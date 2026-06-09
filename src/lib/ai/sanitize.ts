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
// Result is a discriminated union so callers branch on `ok` and always have a
// concrete `reason` to display when validation fails.

export type SvgValidation =
  | { ok: true; svg: string }
  | { ok: false; reason: string };

// The fixed canvas the model is told to draw on (see prompt.ts). A missing
// viewBox is normalised to this rather than rejected.
const DEFAULT_VIEWBOX = '0 0 1000 600';

/** Hard caps to keep a hostile/huge response from being expensive to handle. */
const MAX_INPUT_CHARS = 100_000;
const MAX_ELEMENTS = 4000;

/**
 * The ONLY elements allowed in the generated art. Deliberately a small,
 * abstract-shape + gradient subset — enough for rich ambient art, nothing that
 * can script, load, embed, or style externally. `title`/`desc` are accessibility
 * metadata (plain text only) and harmless.
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

/** Extract the first complete <svg>…</svg> block from possibly-noisy output. */
function extractSvg(raw: string): string | null {
  const start = raw.search(/<svg[\s>]/i);
  if (start === -1) return null;
  const close = raw.toLowerCase().lastIndexOf('</svg>');
  if (close === -1 || close < start) return null;
  return raw.slice(start, close + '</svg>'.length);
}

/**
 * Validate + sanitize raw model output into safe SVG markup, or explain why it
 * can't be used. Strict: any disallowed element, attribute, or value fails the
 * whole document (no partial stripping that could hide an injected node). On
 * success the returned markup is re-serialized from the parsed, fully-checked
 * tree and normalised (xmlns, sizing, role/aria-hidden, viewBox).
 */
export function validateAndSanitizeSvg(raw: string): SvgValidation {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'model returned empty output' };
  if (trimmed.length > MAX_INPUT_CHARS)
    return {
      ok: false,
      reason: `output too large (${trimmed.length} chars > ${MAX_INPUT_CHARS} cap)`,
    };

  const candidate = extractSvg(trimmed);
  if (!candidate)
    return { ok: false, reason: 'no <svg> element found in model output' };

  if (typeof DOMParser === 'undefined')
    return { ok: false, reason: 'DOMParser unavailable in this environment' };

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(candidate, 'image/svg+xml');
  } catch (e) {
    return { ok: false, reason: `SVG could not be parsed (${String(e)})` };
  }

  // A namespaced <parsererror> anywhere means the XML was malformed.
  if (
    doc.documentElement.localName.toLowerCase() === 'parsererror' ||
    doc.querySelector('parsererror')
  ) {
    return { ok: false, reason: 'SVG markup is not well-formed XML' };
  }

  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== 'svg') {
    return { ok: false, reason: 'root element is not <svg>' };
  }

  // Walk every element and enforce the allowlists.
  let count = 0;
  const walker = doc.createTreeWalker(root, 1 /* SHOW_ELEMENT */);
  let node: Element | null = root;
  while (node) {
    count++;
    if (count > MAX_ELEMENTS)
      return {
        ok: false,
        reason: `too many elements (> ${MAX_ELEMENTS})`,
      };

    const name = node.localName.toLowerCase();
    if (!ALLOWED_ELEMENTS.has(name)) {
      return { ok: false, reason: `disallowed element <${name}>` };
    }

    for (const attrName of node.getAttributeNames()) {
      const lower = attrName.toLowerCase();
      if (lower.startsWith('on')) {
        return { ok: false, reason: `event handler attribute "${attrName}"` };
      }
      // Reject any namespaced attribute (e.g. xlink:href) outright; we never
      // need them and they are a common injection vector.
      if (lower.includes(':')) {
        return { ok: false, reason: `namespaced attribute "${attrName}"` };
      }
      if (!ALLOWED_ATTRS.has(lower)) {
        return {
          ok: false,
          reason: `disallowed attribute "${attrName}" on <${name}>`,
        };
      }
      const value = node.getAttribute(attrName) ?? '';
      if (attrValueIsDangerous(value)) {
        return {
          ok: false,
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
  return { ok: true, svg };
}
