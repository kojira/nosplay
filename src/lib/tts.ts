// Minimal, guarded wrapper around the Web Speech API (speechSynthesis).

/** True when the browser exposes speechSynthesis. */
export function hasTts(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Speak the given text if TTS is available. No-op otherwise. */
export function speak(text: string): void {
  if (!hasTts()) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    const utter = new SpeechSynthesisUtterance(trimmed.slice(0, 280));
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
