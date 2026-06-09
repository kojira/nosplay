// Deterministic SVG generator: turns an AI summary string into a large, faint,
// abstract background image. No AI here, and crucially NO TEXT — given the same
// summary it always produces the same SVG, so the visual is stable until the
// summary changes. The summary only influences shapes (never letters): word
// counts, word lengths and per-word hashes seed clusters, constellations,
// ribbons, orbital rings and a star field.
//
// The output is a self-contained <svg> string sized to fill its container
// (width/height 100%, fixed viewBox). It is meant to sit behind the timeline at
// low opacity (see Timeline.svelte .ai-bg), so it reads as ambient texture
// rather than content. Colors come from the app's accent palette.

const VIEW_W = 1000;
const VIEW_H = 600;

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

/**
 * Build a faint abstract SVG from a summary string. Deterministic in `summary`.
 * Contains no <text> — the summary only shapes the geometry. Returns an empty
 * string for empty input so callers can render "nothing yet".
 */
export function generateBackgroundSvg(summary: string): string {
  const text = summary.trim();
  if (!text) return '';

  const seed = hashString(text);
  const rand = mulberry32(seed);
  const tokens = tokenize(text);
  // Always have at least a few tokens to work with so very short summaries
  // still produce a pleasant (if sparse) image.
  const tokenCount = Math.max(tokens.length, 3);

  // A small accent palette (matches app.css --accent family).
  const palette = ['#c084fc', '#7c6cf0', '#5e9bff', '#36d399', '#ff79c6'];
  const pick = () => palette[Math.floor(rand() * palette.length)];

  const defs: string[] = [];
  const parts: string[] = [];

  // ---- Soft gradient blobs: large, low-opacity radial washes ----------------
  // One radial gradient per blob so the wash fades to transparent at its edge.
  const blobCount = 3 + (tokenCount % 4); // 3..6, tied to summary size
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
  const ringCount = 2 + (tokenCount % 3); // 2..4
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
  const ribbonCount = 2 + (tokenCount % 2); // 2..3
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
            `stroke="#aab2c8" stroke-width="1" opacity="0.10"/>`,
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
  const starCount = 40 + (seed % 40); // 40..79, deterministic in the summary
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
