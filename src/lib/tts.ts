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

/** Speak the given text if TTS is available. No-op otherwise. */
export function speak(text: string): void {
  if (!hasTts()) return;
  const cleaned = sanitizeForSpeech(text);
  if (!cleaned) return;
  try {
    const utter = new SpeechSynthesisUtterance(cleaned.slice(0, 280));
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
