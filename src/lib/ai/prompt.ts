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

// The strict validator (sanitize.ts) normalises a missing viewBox to
// "0 0 1000 600", so the prompts no longer need to dictate a fixed canvas.

/** Simple default system prompt. User-editable from the UI; output is still
 *  strictly validated/sanitized (sanitize.ts), so we only ask for SVG markup
 *  with no <text>. */
export const DEFAULT_SVG_SYSTEM_PROMPT =
  '文章から連想される絵をSVGで描いてください。返答は <svg> から </svg> までの' +
  'SVGマークアップだけにし、説明文やコードフェンス(```)は付けないでください。' +
  '文字を表示する <text> 要素は使わないでください。';

/** Simple default user-prompt template. `{summary}` is replaced with the feed
 *  text by buildSvgUserPrompt. User-editable from the UI. */
export const DEFAULT_SVG_USER_PROMPT =
  '次の文章から連想される絵をSVGで出力してください。\n\n"""{summary}"""';

/**
 * Build the final user prompt from a template + summary. Caps the summary at
 * 1200 chars, substitutes the `{summary}` placeholder, and if the template has
 * no placeholder appends the summary block so the model still receives it.
 */
export function buildSvgUserPrompt(template: string, summary: string): string {
  const capped = summary.slice(0, 1200);
  if (template.includes('{summary}')) {
    return template.split('{summary}').join(capped);
  }
  return `${template}\n\n"""${capped}"""`;
}

/**
 * Create a Prompt API session primed to emit safe, abstract background SVG.
 * MUST be called from a user gesture when the model still needs downloading
 * (the spec requires transient activation for the download). `onProgress`
 * receives 0..1 download progress. Throws if unsupported or if create() fails.
 */
export async function createSvgModel(
  onProgress?: (fraction: number) => void,
  systemPrompt: string = DEFAULT_SVG_SYSTEM_PROMPT,
): Promise<LanguageModelInstance> {
  if (!isLanguageModelSupported() || !LanguageModel) {
    throw new Error('Built-in AI Prompt API (LanguageModel) is not supported.');
  }
  return LanguageModel.create({
    initialPrompts: [{ role: 'system', content: systemPrompt }],
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
 * Ask Gemini Nano for a background SVG derived from `summary`. The user-prompt
 * template (default DEFAULT_SVG_USER_PROMPT, overridable from the UI) is combined
 * with the summary via buildSvgUserPrompt. Returns the model's RAW text output
 * VERBATIM (expected to be SVG markup; no trimming or normalization, so
 * callers/diagnostics see exactly what the model emitted). The caller MUST pass
 * this through the strict validator/sanitizer before any DOM use — this function
 * performs no validation and never falls back. Throws on prompt failure (aborted,
 * model error, etc.).
 */
export async function promptSvg(
  model: LanguageModelInstance,
  summary: string,
  signal?: AbortSignal,
  userPromptTemplate: string = DEFAULT_SVG_USER_PROMPT,
): Promise<string> {
  const input = buildSvgUserPrompt(userPromptTemplate, summary);
  // Verbatim: no trim/normalization, so the validator and diagnostics see
  // exactly what the model emitted (including any leading/trailing prose
  // around the <svg> block).
  return await model.prompt(input, { signal });
}
