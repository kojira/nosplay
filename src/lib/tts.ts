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
// on the `voiceschanged` event. We prefer a Japanese voice so CJK text is read
// naturally rather than spelled out by a default (often English) voice.

let cachedJaVoice: SpeechSynthesisVoice | null = null;
let voicesPrimed = false;

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

/** Speak the given text if TTS is available. No-op otherwise. */
export function speak(text: string): void {
  if (!hasTts()) return;
  const cleaned = sanitizeForSpeech(text);
  if (!cleaned) return;
  try {
    primeVoices();
    if (!cachedJaVoice) refreshVoices(); // voices may have loaded since priming
    const utter = new SpeechSynthesisUtterance(cleaned.slice(0, 280));
    // Default to Japanese so even when no explicit voice matches, the engine
    // selects a JA-capable voice rather than reading kana/kanji as English.
    utter.lang = 'ja-JP';
    if (cachedJaVoice) {
      utter.voice = cachedJaVoice;
      utter.lang = cachedJaVoice.lang;
    }
    window.speechSynthesis.speak(utter);
  } catch {
    // ignore speech failures
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
