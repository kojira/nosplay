// Minimal, guarded wrapper around the Web Speech API (speechSynthesis).

export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 5;
export const TTS_RATE_STEP = 0.1;
export const TTS_RATE_DEFAULT = 1;

/** Clamp a user/persisted TTS rate to the browser-facing supported range. */
export function clampTtsRate(rate: number): number {
  if (!Number.isFinite(rate)) return TTS_RATE_DEFAULT;
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, rate));
}

/** True when the browser exposes speechSynthesis. */
export function hasTts(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Strip noise that should not be read aloud: URLs, nostr bech32 ids, hex blobs,
 * and long alphanumeric garbage. Ordinary CJK / short Latin text is preserved.
 */
export function sanitizeForSpeech(text: string): string {
  return text
    // URLs (http/https + bare www.) → placeholder
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, 'リンク省略')
    // nostr bech32 ids (with optional nostr: scheme) → drop
    .replace(/\bnostr:/gi, ' ')
    .replace(/\b(?:npub|note|nevent|nprofile|naddr|nsec|nrelay)1[ac-hj-np-z02-9]+/gi, ' ')
    // standalone hex blobs (event ids / pubkeys), len >= 32 → drop
    .replace(/(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g, ' ')
    // other long alphanumeric garbage (>= 24, mixed letters + digits) → drop
    .replace(/(?<![A-Za-z0-9])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{24,}(?![A-Za-z0-9])/g, ' ')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- voice selection -------------------------------------------------------
// Browsers populate the voice list asynchronously, so we cache it and refresh
// on the `voiceschanged` event. By default we prefer a Japanese voice so CJK
// text is read naturally rather than spelled out by a default (often English)
// voice. The user may override this with an explicit voice (see selectedVoiceURI),
// which becomes the Japanese baseline for non-English text. English-looking text
// is auto-routed to an English voice instead, regardless of that selection.

let cachedJaVoice: SpeechSynthesisVoice | null = null;
let cachedEnVoice: SpeechSynthesisVoice | null = null;
let voicesPrimed = false;
let voiceRefreshScheduled = false;
const voiceListeners = new Set<() => void>();
let ttsUnlocked = false;

// A user-selected voice, identified by its stable voiceURI. Null means "Auto"
// (fall back to the Japanese auto-pick below). Stored as an id rather than a
// SpeechSynthesisVoice reference because voice objects are recreated per call.
let selectedVoiceURI: string | null = null;

/** iPhone/iPad Safari commonly blocks the first speak() until a user gesture unlocks it. */
function requiresGestureUnlock(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const platform = navigator.platform;
  const vendor = navigator.vendor;
  const touchPoints = navigator.maxTouchPoints ?? 0;
  const isAppleMobile =
    /iP(?:ad|hone|od)/.test(ua) || (platform === 'MacIntel' && touchPoints > 1);
  return isAppleMobile && /Apple/i.test(vendor) && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);
}

/** True when a voice's language tag denotes Japanese (`ja`, `ja-JP`, …). */
function isJapanese(voice: SpeechSynthesisVoice): boolean {
  return /^ja(-|_|$)/i.test(voice.lang);
}

/** Pick the best available Japanese voice, preferring local (offline) ones. */
function pickJapaneseVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const ja = voices.filter(isJapanese);
  if (ja.length === 0) return null;
  // Prefer a default-marked voice, then a local one, else the first match.
  return ja.find((v) => v.default) ?? ja.find((v) => v.localService) ?? ja[0];
}

/** True when a voice's language tag denotes English (`en`, `en-US`, …). */
function isEnglish(voice: SpeechSynthesisVoice): boolean {
  return /^en(-|_|$)/i.test(voice.lang);
}

/** Pick the best available English voice, preferring default/local ones. */
function pickEnglishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const en = voices.filter(isEnglish);
  if (en.length === 0) return null;
  return en.find((v) => v.default) ?? en.find((v) => v.localService) ?? en[0];
}

/**
 * Heuristic: is the sanitized text "English enough" to route to an English
 * voice? Any CJK (kana/kanji/fullwidth-kana) disqualifies it; otherwise we
 * require at least a couple of Latin letters that dominate the letters
 * present, so stray Latin words inside CJK text don't flip the language.
 */
function isEnglishText(text: string): boolean {
  const hasCJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/.test(text);
  if (hasCJK) return false;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return latin >= 2 && latin >= letters * 0.8;
}

/** Refresh the cached Japanese voice from the current voice list. */
function refreshVoices(): void {
  try {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      cachedJaVoice = pickJapaneseVoice(voices);
      cachedEnVoice = pickEnglishVoice(voices);
    }
    for (const listener of voiceListeners) listener();
  } catch {
    // ignore
  }
}

/** Safari can populate voices late without reliably firing `voiceschanged`. */
function scheduleVoiceRefreshes(): void {
  if (voiceRefreshScheduled) return;
  voiceRefreshScheduled = true;
  for (const delay of [0, 250, 1000, 3000]) {
    setTimeout(() => {
      refreshVoices();
    }, delay);
  }
}

/**
 * Prime the voice list once. Voices may not be ready synchronously, so we also
 * listen for `voiceschanged`. Safe to call repeatedly; it only wires up once.
 */
function primeVoices(): void {
  if (voicesPrimed) return;
  voicesPrimed = true;
  refreshVoices();
  scheduleVoiceRefreshes();
  try {
    window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
  } catch {
    // ignore
  }
}

/** The current list of available voices, priming the engine if needed. */
export function listVoices(): SpeechSynthesisVoice[] {
  if (!hasTts()) return [];
  primeVoices();
  try {
    return window.speechSynthesis.getVoices();
  } catch {
    return [];
  }
}

/**
 * Subscribe to voice-list changes (`voiceschanged`). Returns an unsubscribe
 * function. Voices often arrive asynchronously, so callers use this to refresh
 * their UI once the list populates.
 */
export function onVoicesChanged(cb: () => void): () => void {
  if (!hasTts()) return () => {};
  primeVoices();
  voiceListeners.add(cb);
  try {
    window.speechSynthesis.addEventListener?.('voiceschanged', cb);
    return () => {
      voiceListeners.delete(cb);
      try {
        window.speechSynthesis.removeEventListener?.('voiceschanged', cb);
      } catch {
        // ignore
      }
    };
  } catch {
    return () => {
      voiceListeners.delete(cb);
    };
  }
}

/** Whether Safari still needs a first user gesture before speech can start. */
export function isTtsUnlockPending(): boolean {
  return hasTts() && requiresGestureUnlock() && !ttsUnlocked;
}

/**
 * Warm up iPhone/iPad Safari's speech engine from a real user gesture so later
 * queued playback can start outside that gesture.
 */
export function unlockTtsFromGesture(): boolean {
  if (!hasTts()) return false;
  primeVoices();
  scheduleVoiceRefreshes();
  if (!requiresGestureUnlock()) {
    ttsUnlocked = true;
    return true;
  }
  if (ttsUnlocked) return true;
  try {
    const synth = window.speechSynthesis;
    if (synth.paused) synth.resume();
    synth.cancel();
    const utter = new SpeechSynthesisUtterance('.');
    utter.volume = 0;
    utter.rate = 1;
    utter.lang = 'en-US';
    synth.speak(utter);
    ttsUnlocked = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Set the user-selected voice by its voiceURI, or null to use the Japanese
 * auto-pick. Unknown/unavailable ids simply fall back to the auto-pick at
 * speak time, so this never throws.
 */
export function setSelectedVoiceURI(uri: string | null): void {
  selectedVoiceURI = uri && uri.length > 0 ? uri : null;
}

/** Resolve the selected voiceURI to a live voice object, or null if gone. */
function findSelectedVoice(): SpeechSynthesisVoice | null {
  if (!selectedVoiceURI) return null;
  try {
    return (
      window.speechSynthesis.getVoices().find((v) => v.voiceURI === selectedVoiceURI) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Speak the given text if TTS is available.
 *
 * Returns `true` when an utterance was actually handed to the speech engine —
 * in that case exactly one of the `onEnd` / `onError` callbacks is expected to
 * fire later. Returns `false` when nothing was queued (TTS unavailable, or the
 * text is empty after sanitizing); callers must NOT wait for `onEnd` in that
 * case, since it will never arrive. This lets a queue advance correctly instead
 * of stalling on a note that produced no speakable text.
 *
 * Note that `speechSynthesis.cancel()` does not reliably fire `onend` across
 * browsers, so callers must also clear their state on explicit cancel.
 */
export function speak(
  text: string,
  callbacks?: { onStart?: () => void; onEnd?: () => void; onError?: () => void },
  rate = TTS_RATE_DEFAULT,
): boolean {
  if (!hasTts()) return false;
  if (isTtsUnlockPending()) return false;
  const cleaned = sanitizeForSpeech(text);
  if (!cleaned) return false;
  try {
    primeVoices();
    scheduleVoiceRefreshes();
    if (!cachedJaVoice || !cachedEnVoice) refreshVoices(); // voices may have loaded since priming
    const synth = window.speechSynthesis;
    if (synth.paused) synth.resume();
    if (requiresGestureUnlock() && synth.pending && !synth.speaking) synth.cancel();
    const utter = new SpeechSynthesisUtterance(cleaned.slice(0, 280));
    utter.rate = clampTtsRate(rate);
    if (isEnglishText(cleaned)) {
      // English note: prefer an English browser voice; if none exists, fall back
      // to just tagging the utterance en-US and letting the engine choose.
      if (cachedEnVoice) {
        utter.voice = cachedEnVoice;
        utter.lang = cachedEnVoice.lang;
      } else {
        utter.lang = 'en-US';
      }
    } else {
      // Non-English note: keep the Japanese baseline — the user-selected voice
      // wins when set, otherwise the Japanese auto-pick. Default lang ja-JP so a
      // missing voice still reads kana/kanji naturally rather than as English.
      utter.lang = 'ja-JP';
      const voice = findSelectedVoice() ?? cachedJaVoice;
      if (voice) {
        utter.voice = voice;
        utter.lang = voice.lang;
      }
    }
    utter.onstart = () => callbacks?.onStart?.();
    utter.onend = () => callbacks?.onEnd?.();
    utter.onerror = () => callbacks?.onError?.();
    synth.speak(utter);
    return true;
  } catch {
    // ignore speech failures
    return false;
  }
}

/** Cancel any pending/ongoing speech. */
export function cancelSpeech(): void {
  if (!hasTts()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // ignore
  }
}
