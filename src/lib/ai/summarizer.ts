// Thin wrapper around Chrome's built-in AI **Summarizer API** (Gemini Nano,
// on-device). This is the production summarization path for the AI background
// feature. The API is exposed as a global `Summarizer` factory in supporting
// Chrome builds; everything here degrades gracefully when it is absent.
//
// References:
//  - Summarizer API explainer / spec: https://developer.chrome.com/docs/ai/summarizer-api
//  - The model is Gemini Nano, downloaded and run locally by Chrome. No text
//    ever leaves the device.
//
// Notes / constraints (see README for the full list):
//  - Requires a recent Chrome (138+ stable for the Summarizer API) on desktop
//    with enough disk (~a few GB) for the on-device model.
//  - The first create() may need to DOWNLOAD the model; per spec this requires
//    transient user activation, so we only ever call create() from a user
//    gesture (the enable toggle).
//  - The older `window.ai.*` / Prompt API surface is intentionally NOT relied
//    upon here; it is behind flags and unstable. See README.

/** Model/feature availability, mirrors the spec's AvailabilityStatus. */
export type SummarizerAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

export interface SummarizerCreateOptions {
  type?: 'tldr' | 'key-points' | 'teaser' | 'headline';
  format?: 'plain-text' | 'markdown';
  length?: 'short' | 'medium' | 'long';
  sharedContext?: string;
  monitor?: (m: EventTarget) => void;
  signal?: AbortSignal;
}

export interface SummarizerInstance {
  summarize(
    input: string,
    options?: { context?: string; signal?: AbortSignal },
  ): Promise<string>;
  destroy(): void;
}

interface SummarizerFactory {
  availability(): Promise<SummarizerAvailability>;
  create(options?: SummarizerCreateOptions): Promise<SummarizerInstance>;
}

declare global {
  // The built-in AI Summarizer is exposed as a global factory when supported.
  // Typed as possibly-undefined so all call sites must feature-detect first.
  // eslint-disable-next-line no-var
  var Summarizer: SummarizerFactory | undefined;
}

/** True when this browser exposes the built-in AI Summarizer API at all. */
export function isSummarizerSupported(): boolean {
  return typeof Summarizer !== 'undefined' && Summarizer !== null;
}

/**
 * Query whether the on-device model is ready, needs downloading, or is
 * unavailable. Returns 'unavailable' on any error or when unsupported, so
 * callers can treat that as "feature off".
 */
export async function summarizerAvailability(): Promise<SummarizerAvailability> {
  if (!isSummarizerSupported() || !Summarizer) return 'unavailable';
  try {
    return await Summarizer.availability();
  } catch {
    return 'unavailable';
  }
}

/**
 * Create a Summarizer session tuned for short, plain-text key-points summaries
 * of a live social feed. MUST be called from a user gesture when the model
 * still needs downloading (the spec requires transient activation for the
 * download). `onProgress` receives 0..1 download progress while the model
 * fetches. Throws if unsupported or if create() fails (e.g. activation needed).
 */
export async function createSummarizer(
  onProgress?: (fraction: number) => void,
): Promise<SummarizerInstance> {
  if (!isSummarizerSupported() || !Summarizer) {
    throw new Error('Built-in AI Summarizer is not supported in this browser.');
  }
  return Summarizer.create({
    type: 'key-points',
    format: 'plain-text',
    length: 'short',
    sharedContext:
      'A live stream of short Nostr social-media posts (often Japanese). ' +
      'Summarize what people are currently talking about.',
    monitor: (m: EventTarget) => {
      m.addEventListener('downloadprogress', (e: Event) => {
        // Spec ProgressEvent: `loaded` is a 0..1 fraction for this API.
        const frac = (e as ProgressEvent).loaded;
        if (onProgress && typeof frac === 'number') onProgress(frac);
      });
    },
  });
}
