// Thin wrapper around Chrome's built-in AI **Prompt API** (`LanguageModel`,
// Gemini Nano, on-device). This is an OPTIONAL enhancement path for the AI
// background: when available, we ask the model for a small, STRUCTURED JSON
// scene description (palette + shape counts) that drives the *local* SVG
// assembly. It is NOT the production base — the Summarizer API remains that
// (see summarizer.ts) — and everything here degrades to the deterministic
// summary→SVG generator when the Prompt API is absent or fails.
//
// References:
//  - Prompt API explainer: https://developer.chrome.com/docs/ai/prompt-api
//  - Structured output via `responseConstraint` (a JSON Schema): the model is
//    constrained to emit JSON matching the schema, so the result is parseable.
//
// Honesty / constraints (see README):
//  - The Prompt API is LESS widely available than the Summarizer: parts of it
//    are behind flags / origin trials and the surface changes between Chrome
//    versions. We feature-detect cleanly and only ever use it as a bonus —
//    never assume universal support.
//  - We never force a model download here; the caller only creates a session
//    when availability is already 'available'.
//  - The model only ever returns a palette key + numbers. Colors and final SVG
//    markup are produced locally (svg.ts), so untrusted text never reaches the
//    DOM.

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

/** Palette keys the model may choose from. Colors are resolved locally (svg.ts). */
export const SCENE_PALETTE_KEYS = [
  'aurora',
  'ember',
  'ocean',
  'violet',
  'mono',
] as const;

export type ScenePalette = (typeof SCENE_PALETTE_KEYS)[number];

/**
 * The structured, abstract, no-text scene the model returns. Deliberately
 * modest and browser-safe: a named palette plus a handful of small integer
 * knobs that the local generator turns into shapes. No colors, no free text.
 */
export interface BackgroundScene {
  palette: ScenePalette;
  /** Random seed (0..9999) so the same mood can still vary. */
  seed: number;
  /** Count of soft gradient blobs (0..6). */
  blobs: number;
  /** Count of orbital rings (0..5). */
  rings: number;
  /** Count of flowing ribbons (0..4). */
  ribbons: number;
  /** Star-field density 0..100 (mapped to a dot count locally). */
  starDensity: number;
}

/** JSON Schema passed as `responseConstraint` so output is constrained JSON. */
const SCENE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['palette', 'seed', 'blobs', 'rings', 'ribbons', 'starDensity'],
  properties: {
    palette: { type: 'string', enum: [...SCENE_PALETTE_KEYS] },
    seed: { type: 'integer', minimum: 0, maximum: 9999 },
    blobs: { type: 'integer', minimum: 0, maximum: 6 },
    rings: { type: 'integer', minimum: 0, maximum: 5 },
    ribbons: { type: 'integer', minimum: 0, maximum: 4 },
    starDensity: { type: 'integer', minimum: 0, maximum: 100 },
  },
} as const;

/** True when this browser exposes the built-in AI Prompt API at all. */
export function isLanguageModelSupported(): boolean {
  return typeof LanguageModel !== 'undefined' && LanguageModel !== null;
}

/**
 * Query whether the on-device model is ready, needs downloading, or is
 * unavailable. Returns 'unavailable' on any error or when unsupported, so
 * callers can treat that as "no enhancement".
 */
export async function languageModelAvailability(): Promise<LanguageModelAvailability> {
  if (!isLanguageModelSupported() || !LanguageModel) return 'unavailable';
  try {
    return await LanguageModel.availability();
  } catch {
    return 'unavailable';
  }
}

/**
 * Create a Prompt API session primed to emit abstract scene JSON. The feed is
 * mixed Japanese + English, so we declare both as expected input languages.
 * Throws if unsupported or if create() fails; the caller treats either as
 * "stay on the deterministic path".
 */
export async function createSceneModel(): Promise<LanguageModelInstance> {
  if (!isLanguageModelSupported() || !LanguageModel) {
    throw new Error('Built-in AI Prompt API (LanguageModel) is not supported.');
  }
  return LanguageModel.create({
    initialPrompts: [
      {
        role: 'system',
        content:
          'You turn a short text summary of a live social feed into an ' +
          'ABSTRACT, no-text background scene. You never echo, describe, or ' +
          'include any words, letters, names or labels from the summary — only ' +
          'an aesthetic palette and simple shape counts. Reply ONLY with JSON ' +
          'matching the provided schema.',
      },
    ],
    // The summarized feed is often Japanese, sometimes English.
    expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  });
}

/**
 * Ask the model for a structured scene matching `summary`'s mood. Returns a
 * validated BackgroundScene, or null on any failure (prompt error, non-JSON
 * output, etc.) so the caller falls back to the deterministic generator.
 * Numeric ranges are clamped again at render time (svg.ts) as defence in depth.
 */
export async function promptScene(
  model: LanguageModelInstance,
  summary: string,
  signal?: AbortSignal,
): Promise<BackgroundScene | null> {
  const input =
    'Summary of what people are currently posting about:\n' +
    `"""${summary.slice(0, 1200)}"""\n\n` +
    'Choose an abstract background scene matching its overall mood. Pick a ' +
    'palette, a random seed, and how many soft blobs, orbital rings and ' +
    'flowing ribbons to draw, plus a star-field density (0-100). Calmer or ' +
    'sparser topics → fewer, softer shapes; busier topics → more.';
  try {
    const raw = await model.prompt(input, {
      responseConstraint: SCENE_SCHEMA,
      signal,
    });
    return parseScene(raw);
  } catch {
    return null;
  }
}

/**
 * Parse + validate the model's reply into a BackgroundScene. Tolerates output
 * that wraps the JSON in prose/markdown fences (some builds ignore the
 * constraint). Returns null if no usable object is found.
 */
function parseScene(raw: string): BackgroundScene | null {
  let data: unknown = tryParse(raw);
  if (data === undefined) {
    // Fall back to extracting the first {...} block.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    data = tryParse(match[0]);
    if (data === undefined) return null;
  }
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;

  const palette = (SCENE_PALETTE_KEYS as readonly string[]).includes(
    o.palette as string,
  )
    ? (o.palette as ScenePalette)
    : 'violet';
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  return {
    palette,
    seed: num(o.seed, 0),
    blobs: num(o.blobs, 3),
    rings: num(o.rings, 3),
    ribbons: num(o.ribbons, 2),
    starDensity: num(o.starDensity, 50),
  };
}

/** JSON.parse that returns undefined instead of throwing. */
function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
