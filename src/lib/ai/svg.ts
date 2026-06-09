// SVG generator: turns an AI summary into a large, faint, abstract background
// image. Two entry points share one local, sanitized assembler:
//
//  - generateBackgroundSvg(summary): the DETERMINISTIC production base. No AI;
//    given the same summary it always produces the same SVG. Shape counts,
//    palette and seed are derived purely from the summary's structure.
//  - sceneToBackgroundSvg(scene, summary): an OPTIONAL enhancement that lets
//    Gemini Nano (via the Prompt API, see prompt.ts) choose the palette and
//    shape counts as a small structured scene, while the summary still drives
//    the constellation. The store falls back to the deterministic path whenever
//    the Prompt API is unavailable or its output can't be used.
//
// Crucially NO TEXT in either path — the summary only influences shapes (never
// letters), and the model only ever supplies a palette key + small integers, so
// no untrusted text reaches the markup. The output is a self-contained <svg>
// string sized to fill its container; it sits behind the timeline at low
// opacity (see Timeline.svelte .ai-bg) as ambient texture. Colors come from the
// app's accent palette.

import type { BackgroundScene, ScenePalette } from './prompt';

const VIEW_W = 1000;
const VIEW_H = 600;

// The default accent palette (matches app.css --accent family). Used by the
// deterministic path; kept first/unchanged so its visuals stay byte-identical.
const DEFAULT_PALETTE = ['#c084fc', '#7c6cf0', '#5e9bff', '#36d399', '#ff79c6'];

// Named palettes the Prompt API may select by key. All colors are defined here
// (never by the model) and drawn from the app's accent family, so the scene
// path stays on-brand and can't inject arbitrary colors.
const SCENE_PALETTES: Record<ScenePalette, string[]> = {
  aurora: ['#36d399', '#5e9bff', '#7c6cf0', '#c084fc', '#a5f3fc'],
  ember: ['#ff79c6', '#ffb86c', '#ff5555', '#c084fc', '#f1fa8c'],
  ocean: ['#5e9bff', '#22d3ee', '#36d399', '#7c6cf0', '#a5f3fc'],
  violet: ['#c084fc', '#7c6cf0', '#5e9bff', '#ff79c6', '#e9d5ff'],
  mono: ['#aab2c8', '#c7cede', '#8b93ad', '#e6e8f0', '#9aa3bd'],
};

const LINK_COLOR = '#aab2c8';

/** Cheap 32-bit string hash (FNV-1a style) for seeding the PRNG. */
function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Tiny deterministic PRNG (mulberry32) seeded from a number. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reduce the summary to abstract numeric "tokens" — never displayed. We split
 * into words, then keep per-word length and a stable hash. These drive shape
 * placement/size/color so the picture reflects the summary's structure (how
 * many distinct points it made, how long they were) without showing any text.
 */
function tokenize(summary: string): { len: number; hash: number }[] {
  return summary
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((w) => w.length >= 2)
    .slice(0, 40)
    .map((w) => ({ len: w.length, hash: hashString(w) }));
}

/** Clamp a (possibly bogus) number to an integer in [lo, hi]. */
function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  const n = Math.round(v);
  return n < lo ? lo : n > hi ? hi : n;
}

/** Resolved, sanitized parameters the local assembler draws from. */
interface SvgParams {
  seed: number;
  palette: string[];
  blobCount: number;
  ringCount: number;
  ribbonCount: number;
  starCount: number;
  /** Drives the constellation; never rendered as text. */
  tokens: { len: number; hash: number }[];
}

/**
 * Build a faint abstract SVG from already-resolved params. Deterministic in
 * `seed` (PRNG stream order is fixed), contains no <text>, and only uses colors
 * from `palette`. Both public entry points funnel through here.
 */
export function generateBackgroundSvg(summary: string): string {
  const text = summary.trim();
  if (!text) return '';
  const seed = hashString(text);
  const tokens = tokenize(text);
  // Always have at least a few tokens to work with so very short summaries
  // still produce a pleasant (if sparse) image.
  const tokenCount = Math.max(tokens.length, 3);
  return buildSvg({
    seed,
    palette: DEFAULT_PALETTE,
    blobCount: 3 + (tokenCount % 4), // 3..6, tied to summary size
    ringCount: 2 + (tokenCount % 3), // 2..4
    ribbonCount: 2 + (tokenCount % 2), // 2..3
    starCount: 40 + (seed % 40), // 40..79
    tokens,
  });
}

/**
 * Build the background from an AI-described structured scene (Prompt API /
 * Gemini Nano). The model only supplies a palette key and small integers; we
 * clamp every value and resolve colors locally, then still derive the
 * constellation from `summary`. Falls back to deterministic output for empty
 * input. The scene seed is mixed with the summary hash so the same summary can
 * vary across scenes while staying stable for a given (scene, summary) pair.
 */
export function sceneToBackgroundSvg(
  scene: BackgroundScene,
  summary: string,
): string {
  const text = summary.trim();
  if (!text) return '';
  const tokens = tokenize(text);
  const palette = SCENE_PALETTES[scene.palette] ?? DEFAULT_PALETTE;
  const seed =
    (hashString(text) ^
      (Math.imul(clampInt(scene.seed, 0, 9999) + 1, 0x9e3779b1) >>> 0)) >>>
    0;
  return buildSvg({
    seed,
    palette,
    blobCount: clampInt(scene.blobs, 0, 6),
    ringCount: clampInt(scene.rings, 0, 5),
    ribbonCount: clampInt(scene.ribbons, 0, 4),
    // Map 0..100 density to a dot count in the same ballpark as the default.
    starCount: clampInt((scene.starDensity / 100) * 120 + 10, 10, 130),
    tokens,
  });
}

function buildSvg(params: SvgParams): string {
  const { seed, palette, blobCount, ringCount, ribbonCount, starCount, tokens } =
    params;
  const rand = mulberry32(seed);
  const pick = () => palette[Math.floor(rand() * palette.length)];

  const defs: string[] = [];
  const parts: string[] = [];

  // ---- Soft gradient blobs: large, low-opacity radial washes ----------------
  // One radial gradient per blob so the wash fades to transparent at its edge.
  for (let i = 0; i < blobCount; i++) {
    const cx = Math.round(rand() * VIEW_W);
    const cy = Math.round(rand() * VIEW_H);
    const r = Math.round(140 + rand() * 240);
    const color = pick();
    const op = (0.07 + rand() * 0.1).toFixed(3);
    const gid = `blob${i}`;
    defs.push(
      `<radialGradient id="${gid}">` +
        `<stop offset="0%" stop-color="${color}" stop-opacity="${op}"/>` +
        `<stop offset="100%" stop-color="${color}" stop-opacity="0"/>` +
        `</radialGradient>`,
    );
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${gid})"/>`);
  }

  // ---- Orbital rings: a few concentric, slightly-eccentric ellipses ---------
  // Evokes orbits / halos around a shared focus drawn from the seed.
  const ringFocusX = Math.round(VIEW_W * (0.3 + rand() * 0.4));
  const ringFocusY = Math.round(VIEW_H * (0.3 + rand() * 0.4));
  const ringColor = pick();
  for (let i = 0; i < ringCount; i++) {
    const rx = Math.round(80 + i * 70 + rand() * 40);
    const ry = Math.round(rx * (0.5 + rand() * 0.35));
    const rot = Math.round(rand() * 180);
    parts.push(
      `<ellipse cx="${ringFocusX}" cy="${ringFocusY}" rx="${rx}" ry="${ry}" ` +
        `transform="rotate(${rot} ${ringFocusX} ${ringFocusY})" ` +
        `fill="none" stroke="${ringColor}" stroke-width="1.5" opacity="0.10"/>`,
    );
  }

  // ---- Ribbons: smooth wandering bezier bands crossing the canvas -----------
  // Two or three flowing strokes give the image a sense of motion/threads.
  for (let i = 0; i < ribbonCount; i++) {
    const yBase = VIEW_H * (0.2 + rand() * 0.6);
    let d = `M -40 ${Math.round(yBase)}`;
    const segs = 4 + Math.floor(rand() * 3);
    for (let s = 1; s <= segs; s++) {
      const x = Math.round((VIEW_W + 80) * (s / segs)) - 40;
      const y = Math.round(yBase + (rand() * 220 - 110));
      const cx = Math.round(x - VIEW_W / segs / 2);
      const cy = Math.round(y + (rand() * 160 - 80));
      d += ` Q ${cx} ${cy} ${x} ${y}`;
    }
    const color = pick();
    const w = (6 + rand() * 10).toFixed(1);
    parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" ` +
        `stroke-linecap="round" opacity="0.07"/>`,
    );
  }

  // ---- Constellation: one node per token, linked into a faint network -------
  // Node size scales with that token's word length; position/color from its
  // hash. Nearby nodes are connected so it reads as a star map of the summary.
  type Node = { x: number; y: number; r: number; color: string };
  const nodes: Node[] = tokens.length
    ? tokens.map((t) => {
        const hx = (t.hash & 0xffff) / 0xffff;
        const hy = ((t.hash >>> 16) & 0xffff) / 0xffff;
        return {
          x: Math.round(40 + hx * (VIEW_W - 80)),
          y: Math.round(40 + hy * (VIEW_H - 80)),
          r: 2 + Math.min(t.len, 12) * 0.6,
          color: palette[t.hash % palette.length],
        };
      })
    : [];

  // Link each node to its nearest couple of neighbours (cheap O(n^2); n<=40).
  const links: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const dists = nodes
      .map((n, j) => ({ j, d: (n.x - nodes[i].x) ** 2 + (n.y - nodes[i].y) ** 2 }))
      .filter((e) => e.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    for (const { j } of dists) {
      if (j > i) {
        links.push(
          `<line x1="${nodes[i].x}" y1="${nodes[i].y}" x2="${nodes[j].x}" y2="${nodes[j].y}" ` +
            `stroke="${LINK_COLOR}" stroke-width="1" opacity="0.10"/>`,
        );
      }
    }
  }
  parts.push(...links);
  for (const n of nodes) {
    parts.push(
      `<circle cx="${n.x}" cy="${n.y}" r="${n.r.toFixed(1)}" fill="${n.color}" opacity="0.22"/>`,
    );
  }

  // ---- Star field: tiny scattered dots for ambient texture ------------------
  for (let i = 0; i < starCount; i++) {
    const x = Math.round(rand() * VIEW_W);
    const y = Math.round(rand() * VIEW_H);
    const r = (0.5 + rand() * 1.3).toFixed(1);
    const op = (0.05 + rand() * 0.12).toFixed(3);
    parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#e6e8f0" opacity="${op}"/>`);
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" ` +
    `width="100%" height="100%" preserveAspectRatio="xMidYMid slice" ` +
    `role="img" aria-hidden="true"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`
  );
}
