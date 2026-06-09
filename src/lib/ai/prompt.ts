// Thin wrapper around Chrome's built-in AI **Prompt API** (`LanguageModel`,
// Gemini Nano, on-device). This is the SOLE generator of the AI background:
// nosplay asks Gemini Nano to produce the **SVG markup directly**, then strictly
// validates/sanitizes that markup (see sanitize.ts) before it is shown. There is
// **no fallback** — if the Prompt API is unsupported, the model is unavailable,
// generation fails, or the returned markup fails validation, no background is
// drawn and the UI/debug state says exactly why.
//
// References:
//  - Prompt API explainer: https://developer.chrome.com/docs/ai/prompt-api
//
// Honesty / constraints (see README):
//  - The Prompt API is behind flags / origin trials in some Chrome versions and
//    its surface changes between releases. We feature-detect cleanly and never
//    assume universal support.
//  - The model output is untrusted text. It is ALWAYS run through the strict
//    SVG validator/sanitizer (sanitize.ts) before any DOM insertion; markup that
//    contains script, event handlers, foreignObject, external/data refs, etc. is
//    rejected outright (no background shown).

/** Model/feature availability, mirrors the spec's AvailabilityStatus. */
export type LanguageModelAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

/** An expected input/output modality + its languages (BCP-47), per spec. */
interface LanguageModelExpected {
  type?: 'text' | 'image' | 'audio';
  languages?: string[];
}

export interface LanguageModelCreateOptions {
  initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
  expectedInputs?: LanguageModelExpected[];
  expectedOutputs?: LanguageModelExpected[];
  temperature?: number;
  topK?: number;
  monitor?: (m: EventTarget) => void;
  signal?: AbortSignal;
}

export interface LanguageModelPromptOptions {
  /** A JSON Schema the response is constrained to; yields parseable JSON. */
  responseConstraint?: object;
  signal?: AbortSignal;
}

export interface LanguageModelInstance {
  prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;
  destroy(): void;
}

interface LanguageModelFactory {
  availability(
    options?: LanguageModelCreateOptions,
  ): Promise<LanguageModelAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelInstance>;
}

declare global {
  // The built-in AI Prompt API is exposed as a global `LanguageModel` factory
  // when supported. Typed as possibly-undefined so every call site must
  // feature-detect first.
  // eslint-disable-next-line no-var
  var LanguageModel: LanguageModelFactory | undefined;
}

/** True when this browser exposes the built-in AI Prompt API at all. */
export function isLanguageModelSupported(): boolean {
  return typeof LanguageModel !== 'undefined' && LanguageModel !== null;
}

/**
 * Query whether the on-device model is ready, needs downloading, or is
 * unavailable. Returns 'unavailable' on any error or when unsupported.
 */
export async function languageModelAvailability(): Promise<LanguageModelAvailability> {
  if (!isLanguageModelSupported() || !LanguageModel) return 'unavailable';
  try {
    return await LanguageModel.availability();
  } catch {
    return 'unavailable';
  }
}

// The art is generated against this fixed canvas so the strict validator and the
// container styling agree on a known viewBox. The model is told to use it.
const SVG_VIEW_W = 1000;
const SVG_VIEW_H = 600;

/** System prompt: defines the safe, abstract, no-text SVG the model must emit. */
const SVG_SYSTEM_PROMPT =
  'You are a generative-art engine. You turn a short text summary of a live ' +
  'social feed into ONE self-contained, ABSTRACT background illustration, ' +
  'returned as raw SVG markup and nothing else.\n' +
  'HARD RULES — output is rejected if any are broken:\n' +
  `- Output ONLY a single <svg ...>...</svg> element using viewBox "0 0 ${SVG_VIEW_W} ${SVG_VIEW_H}". No prose, no markdown fences, no explanation.\n` +
  '- Allowed elements ONLY: svg, g, defs, title, desc, rect, circle, ellipse, ' +
  'line, polyline, polygon, path, linearGradient, radialGradient, stop.\n' +
  '- NO text/tspan, NO <image>, NO <use>, NO <style>, NO <script>, NO ' +
  '<foreignObject>, NO <animate>/animation, NO filters.\n' +
  '- NO event handlers (no on* attributes), NO href/xlink:href, NO external or ' +
  'data: URLs. The only url(...) allowed is url(#localGradientId) for fills.\n' +
  '- NO words, letters, names or labels from the summary anywhere in the art.\n' +
  '- Keep it faint and ambient: low opacities (mostly 0.05–0.3), soft gradients, ' +
  'flowing shapes. It sits BEHIND a timeline of notes, so it must stay subtle.\n' +
  'Let the summary\'s overall mood guide palette and density: calmer/sparser ' +
  'topics → fewer, softer shapes; busier topics → more.';

/**
 * Create a Prompt API session primed to emit safe, abstract background SVG.
 * MUST be called from a user gesture when the model still needs downloading
 * (the spec requires transient activation for the download). `onProgress`
 * receives 0..1 download progress. Throws if unsupported or if create() fails.
 */
export async function createSvgModel(
  onProgress?: (fraction: number) => void,
): Promise<LanguageModelInstance> {
  if (!isLanguageModelSupported() || !LanguageModel) {
    throw new Error('Built-in AI Prompt API (LanguageModel) is not supported.');
  }
  return LanguageModel.create({
    initialPrompts: [{ role: 'system', content: SVG_SYSTEM_PROMPT }],
    // The summarized feed is often Japanese, sometimes English; output is SVG.
    expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
    monitor: (m: EventTarget) => {
      m.addEventListener('downloadprogress', (e: Event) => {
        const frac = (e as ProgressEvent).loaded;
        if (onProgress && typeof frac === 'number') onProgress(frac);
      });
    },
  });
}

/**
 * Ask Gemini Nano for an abstract background SVG matching `summary`'s mood.
 * Returns the model's RAW text output (expected to be SVG markup). The caller
 * MUST pass this through the strict validator/sanitizer before any DOM use —
 * this function performs no validation and never falls back. Throws on prompt
 * failure (aborted, model error, etc.).
 */
export async function promptSvg(
  model: LanguageModelInstance,
  summary: string,
  signal?: AbortSignal,
): Promise<string> {
  const input =
    'Summary of what people are currently posting about:\n' +
    `"""${summary.slice(0, 1200)}"""\n\n` +
    'Generate the abstract background SVG for this mood now. Remember: a single ' +
    `<svg> with viewBox "0 0 ${SVG_VIEW_W} ${SVG_VIEW_H}", only the allowed ` +
    'shape/gradient elements, faint and ambient, absolutely no text. Reply with ' +
    'the SVG markup only.';
  return (await model.prompt(input, { signal })).trim();
}
