// Minimal, guarded wrapper around the Web Speech API (speechSynthesis).

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
// voice. The user may override this with an explicit voice (see selectedVoiceURI).

let cachedJaVoice: SpeechSynthesisVoice | null = null;
let voicesPrimed = false;

// A user-selected voice, identified by its stable voiceURI. Null means "Auto"
// (fall back to the Japanese auto-pick below). Stored as an id rather than a
// SpeechSynthesisVoice reference because voice objects are recreated per call.
let selectedVoiceURI: string | null = null;

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

/** Refresh the cached Japanese voice from the current voice list. */
function refreshVoices(): void {
  try {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) cachedJaVoice = pickJapaneseVoice(voices);
  } catch {
    // ignore
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
  try {
    window.speechSynthesis.addEventListener?.('voiceschanged', cb);
    return () => {
      try {
        window.speechSynthesis.removeEventListener?.('voiceschanged', cb);
      } catch {
        // ignore
      }
    };
  } catch {
    return () => {};
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
): boolean {
  if (!hasTts()) return false;
  const cleaned = sanitizeForSpeech(text);
  if (!cleaned) return false;
  try {
    primeVoices();
    if (!cachedJaVoice) refreshVoices(); // voices may have loaded since priming
    const utter = new SpeechSynthesisUtterance(cleaned.slice(0, 280));
    // Default to Japanese so even when no explicit voice matches, the engine
    // selects a JA-capable voice rather than reading kana/kanji as English.
    utter.lang = 'ja-JP';
    // A user-selected voice wins when available; otherwise fall back to the
    // Japanese auto-pick (preserving the original default behavior).
    const voice = findSelectedVoice() ?? cachedJaVoice;
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    }
    utter.onstart = () => callbacks?.onStart?.();
    utter.onend = () => callbacks?.onEnd?.();
    utter.onerror = () => callbacks?.onError?.();
    window.speechSynthesis.speak(utter);
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
