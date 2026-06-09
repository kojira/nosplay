// STRICT validator/sanitizer for the AI background SVG.
//
// The AI background is produced by Gemini Nano emitting SVG markup directly (see
// prompt.ts). That markup is UNTRUSTED model output and must never reach the DOM
// unchecked. This module is the gate: it parses the markup, enforces a tight
// allowlist of elements/attributes/values, and rejects anything outside it
// (script, event handlers, <style>, <foreignObject>, <image>/<use>, external or
// data: references, etc.). There is NO fallback — on any violation the caller
// shows no background and surfaces the reason.
//
// Two entry points:
//  - validateAndSanitizeSvg(): the simple OK/REASON API callers use in product
//    code; a thin wrapper over the inspector.
//  - inspectSvg(): the detailed diagnostic API. Same checks, but it reports the
//    exact failure STAGE, the offending element/attribute/value, how much raw
//    output there was, how much of it was the extracted <svg> block, and whether
//    there was leading/trailing noise around that block — everything needed to
//    tell "the model emitted junk" apart from "the validator rejected good art".

export type SvgValidation =
  | { ok: true; svg: string }
  | { ok: false; reason: string };

/** The point at which inspection stopped. `null` only when ok. */
export type SvgFailureStage =
  | 'empty'
  | 'too-large'
  | 'no-svg-found'
  | 'parser-unavailable'
  | 'not-well-formed'
  | 'root-not-svg'
  | 'disallowed-element'
  | 'event-handler-attribute'
  | 'namespaced-attribute'
  | 'disallowed-attribute'
  | 'unsafe-attribute-value'
  | 'too-many-elements';

/**
 * Full diagnostic result of inspecting raw model output. `ok` mirrors
 * validateAndSanitizeSvg; the rest is evidence for diagnosing WHY a given raw
 * response did or didn't pass, without re-running anything.
 */
export interface SvgInspection {
  /** True only when the markup passed every check; `svg` is then the safe output. */
  ok: boolean;
  /** Sanitized, re-serialized SVG when ok; '' otherwise. */
  svg: string;
  /** Where inspection stopped; null when ok. */
  stage: SvgFailureStage | null;
  /** Human-readable reason ('' when ok). */
  reason: string;
  /** Length of the RAW model output, verbatim (no trim). */
  rawLength: number;
  /** Length of the extracted <svg>…</svg> block (0 when none was found). */
  extractedLength: number;
  /** True when non-whitespace text preceded the extracted <svg>. */
  hasPrefixNoise: boolean;
  /** True when non-whitespace text followed the extracted </svg>. */
  hasSuffixNoise: boolean;
  /** Leading text before <svg> (trimmed + capped), '' when none. */
  prefixText: string;
  /** Trailing text after </svg> (trimmed + capped), '' when none. */
  suffixText: string;
  /** Offending element localName for element/attribute stages ('' otherwise). */
  element: string;
  /** Offending attribute name for attribute stages ('' otherwise). */
  attribute: string;
  /** Offending attribute value for the unsafe-value stage (capped), '' otherwise. */
  value: string;
}

// The fixed canvas the model is told to draw on (see prompt.ts). A missing
// viewBox is normalised to this rather than rejected.
const DEFAULT_VIEWBOX = '0 0 1000 600';

/** Hard caps to keep a hostile/huge response from being expensive to handle. */
const MAX_INPUT_CHARS = 100_000;
const MAX_ELEMENTS = 4000;
/** Cap on captured snippets (prefix/suffix/value) so diagnostics stay bounded. */
const SNIPPET_CAP = 200;

/**
 * The ONLY elements allowed in the generated art. Deliberately a small,
 * abstract-shape + gradient subset — enough for rich ambient art, nothing that
 * can script, load, embed, or style externally. `title`/`desc` are accessibility
 * metadata (plain text only) and harmless.
 *
 * NOTE the canonical SVG casing of `linearGradient`/`radialGradient`. Element
 * names are matched case-INSENSITIVELY against `ALLOWED_ELEMENTS_LC` below, so a
 * correctly-cased `<linearGradient>` is accepted rather than wrongly rejected.
 */
const ALLOWED_ELEMENTS = new Set<string>([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'linearGradient',
  'radialGradient',
  'stop',
]);

/**
 * Lowercased view of ALLOWED_ELEMENTS, used for matching. The walker lowercases
 * each element's localName, so comparing against a lowercased allowlist is what
 * keeps mixed-case-but-valid SVG element names (linearGradient, radialGradient)
 * from being rejected by a case mismatch.
 */
const ALLOWED_ELEMENTS_LC = new Set<string>(
  [...ALLOWED_ELEMENTS].map((e) => e.toLowerCase()),
);

/**
 * The ONLY attributes allowed (matched case-insensitively). Geometry, transform,
 * and presentation/paint attributes plus a couple of a11y hints. Notably ABSENT:
 * `style`, `href`/`xlink:href`, `src`, anything namespaced (contains ':'), and
 * any `on*` event handler — all of which are rejected below.
 */
const ALLOWED_ATTRS = new Set<string>([
  // structure / geometry
  'id',
  'class',
  'transform',
  'viewbox',
  'preserveaspectratio',
  'x',
  'y',
  'width',
  'height',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'd',
  'pathlength',
  // gradients
  'offset',
  'fx',
  'fy',
  'fr',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  // paint / presentation
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'stop-color',
  'stop-opacity',
  'color',
  'vector-effect',
  'paint-order',
  'mix-blend-mode',
  'pointer-events',
  // a11y
  'role',
  'aria-hidden',
  // namespace decl (only meaningful on <svg>; harmless elsewhere)
  'xmlns',
]);

/** Truncate a captured snippet so diagnostics never balloon. */
function clip(s: string): string {
  return s.length > SNIPPET_CAP ? s.slice(0, SNIPPET_CAP) + '…' : s;
}

/** Reject an attribute value that could smuggle in script or external refs. */
function attrValueIsDangerous(value: string): boolean {
  const v = value.toLowerCase();
  if (v.includes('javascript:')) return true;
  if (v.includes('data:')) return true; // no data: URLs (images/fonts/etc.)
  if (v.includes('expression(')) return true; // legacy CSS expression
  if (v.includes('@import')) return true;
  if (v.includes('<')) return true; // no nested markup in a value
  if (v.includes('url(')) {
    // The only permitted url() is a reference to a LOCAL element id, e.g.
    // fill="url(#blob0)". Strip every well-formed local ref; if any url( remains
    // it points somewhere we don't allow (http/data/quoted/etc.) → reject.
    const stripped = v.replace(/url\(\s*#[a-z][\w:.\-]*\s*\)/g, '');
    if (stripped.includes('url(')) return true;
  }
  return false;
}

/**
 * Locate the first complete <svg>…</svg> block in possibly-noisy output and
 * report its bounds so the caller can see any leading/trailing text. Returns
 * null when there is no usable block.
 */
function extractSvgBlock(
  raw: string,
): { svg: string; start: number; end: number } | null {
  const start = raw.search(/<svg[\s>]/i);
  if (start === -1) return null;
  const close = raw.toLowerCase().lastIndexOf('</svg>');
  if (close === -1 || close < start) return null;
  const end = close + '</svg>'.length;
  return { svg: raw.slice(start, end), start, end };
}

/**
 * Detailed inspection of raw model output: the SAME strict checks as
 * validateAndSanitizeSvg, but every exit reports the precise failure stage and
 * supporting metadata (raw vs extracted length, prefix/suffix noise, offending
 * element/attribute/value). On success `ok` is true and `svg` holds the
 * sanitized, re-serialized markup.
 */
export function inspectSvg(raw: string): SvgInspection {
  const rawText = raw ?? '';
  const base: SvgInspection = {
    ok: false,
    svg: '',
    stage: null,
    reason: '',
    rawLength: rawText.length,
    extractedLength: 0,
    hasPrefixNoise: false,
    hasSuffixNoise: false,
    prefixText: '',
    suffixText: '',
    element: '',
    attribute: '',
    value: '',
  };

  if (!rawText.trim())
    return { ...base, stage: 'empty', reason: 'model returned empty output' };
  if (rawText.length > MAX_INPUT_CHARS)
    return {
      ...base,
      stage: 'too-large',
      reason: `output too large (${rawText.length} chars > ${MAX_INPUT_CHARS} cap)`,
    };

  const block = extractSvgBlock(rawText);
  if (!block)
    return {
      ...base,
      stage: 'no-svg-found',
      reason: 'no <svg> element found in model output',
    };

  // Bounds known: record how much of the raw output was the <svg> block and
  // whether there was noise around it (a common Gemini-Nano failure mode).
  const prefix = rawText.slice(0, block.start);
  const suffix = rawText.slice(block.end);
  const meta: SvgInspection = {
    ...base,
    extractedLength: block.svg.length,
    hasPrefixNoise: prefix.trim().length > 0,
    hasSuffixNoise: suffix.trim().length > 0,
    prefixText: clip(prefix.trim()),
    suffixText: clip(suffix.trim()),
  };

  if (typeof DOMParser === 'undefined')
    return {
      ...meta,
      stage: 'parser-unavailable',
      reason: 'DOMParser unavailable in this environment',
    };

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(block.svg, 'image/svg+xml');
  } catch (e) {
    return {
      ...meta,
      stage: 'not-well-formed',
      reason: `SVG could not be parsed (${String(e)})`,
    };
  }

  // A namespaced <parsererror> anywhere means the XML was malformed.
  if (
    doc.documentElement.localName.toLowerCase() === 'parsererror' ||
    doc.querySelector('parsererror')
  ) {
    return {
      ...meta,
      stage: 'not-well-formed',
      reason: 'SVG markup is not well-formed XML',
    };
  }

  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== 'svg') {
    return { ...meta, stage: 'root-not-svg', reason: 'root element is not <svg>' };
  }

  // Walk every element and enforce the allowlists.
  let count = 0;
  const walker = doc.createTreeWalker(root, 1 /* SHOW_ELEMENT */);
  let node: Element | null = root;
  while (node) {
    count++;
    if (count > MAX_ELEMENTS)
      return {
        ...meta,
        stage: 'too-many-elements',
        reason: `too many elements (> ${MAX_ELEMENTS})`,
      };

    const name = node.localName;
    if (!ALLOWED_ELEMENTS_LC.has(name.toLowerCase())) {
      return {
        ...meta,
        stage: 'disallowed-element',
        element: name,
        reason: `disallowed element <${name}>`,
      };
    }

    for (const attrName of node.getAttributeNames()) {
      const lower = attrName.toLowerCase();
      if (lower.startsWith('on')) {
        return {
          ...meta,
          stage: 'event-handler-attribute',
          element: name,
          attribute: attrName,
          reason: `event handler attribute "${attrName}"`,
        };
      }
      // Reject any namespaced attribute (e.g. xlink:href) outright; we never
      // need them and they are a common injection vector.
      if (lower.includes(':')) {
        return {
          ...meta,
          stage: 'namespaced-attribute',
          element: name,
          attribute: attrName,
          reason: `namespaced attribute "${attrName}"`,
        };
      }
      if (!ALLOWED_ATTRS.has(lower)) {
        return {
          ...meta,
          stage: 'disallowed-attribute',
          element: name,
          attribute: attrName,
          reason: `disallowed attribute "${attrName}" on <${name}>`,
        };
      }
      const value = node.getAttribute(attrName) ?? '';
      if (attrValueIsDangerous(value)) {
        return {
          ...meta,
          stage: 'unsafe-attribute-value',
          element: name,
          attribute: attrName,
          value: clip(value),
          reason: `unsafe value for "${attrName}" on <${name}>`,
        };
      }
    }

    node = walker.nextNode() as Element | null;
  }

  // Passed validation. Normalise the root so the layer renders predictably and
  // is inert (decorative, non-interactive).
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!root.getAttribute('viewBox')) root.setAttribute('viewBox', DEFAULT_VIEWBOX);
  root.setAttribute('width', '100%');
  root.setAttribute('height', '100%');
  if (!root.getAttribute('preserveAspectRatio'))
    root.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  root.setAttribute('role', 'img');
  root.setAttribute('aria-hidden', 'true');

  const svg = new XMLSerializer().serializeToString(root);
  return { ...meta, ok: true, svg, stage: null, reason: '' };
}

/**
 * Validate + sanitize raw model output into safe SVG markup, or explain why it
 * can't be used. Strict: any disallowed element, attribute, or value fails the
 * whole document (no partial stripping that could hide an injected node). On
 * success the returned markup is re-serialized from the parsed, fully-checked
 * tree and normalised (xmlns, sizing, role/aria-hidden, viewBox).
 *
 * Thin wrapper over inspectSvg() for callers that only need the OK/REASON
 * verdict; reach for inspectSvg() directly when you need the failure stage and
 * supporting metadata.
 */
export function validateAndSanitizeSvg(raw: string): SvgValidation {
  const result = inspectSvg(raw);
  return result.ok
    ? { ok: true, svg: result.svg }
    : { ok: false, reason: result.reason };
}
