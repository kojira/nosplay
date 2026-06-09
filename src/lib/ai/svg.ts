// Deterministic SVG generator: turns an AI summary string into a large, faint,
// abstract background image. No AI here — given the same summary it always
// produces the same SVG, so the visual is stable until the summary changes.
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

/** Escape text for safe embedding inside SVG markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Extract a few short, display-worthy phrases from the summary. The Summarizer
 * returns key-points (often newline / bullet separated); we split, strip bullet
 * markers, drop tiny fragments, clamp length, and keep the first handful.
 */
function extractPhrases(summary: string): string[] {
  return summary
    .split(/[\n•\-–—*]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 2)
    .map((s) => (s.length > 28 ? s.slice(0, 28) + '…' : s))
    .slice(0, 5);
}

/**
 * Build a faint abstract SVG from a summary string. Deterministic in `summary`.
 * Returns an empty string for empty input so callers can render "nothing yet".
 */
export function generateBackgroundSvg(summary: string): string {
  const text = summary.trim();
  if (!text) return '';

  const seed = hashString(text);
  const rand = mulberry32(seed);
  const phrases = extractPhrases(text);

  // A small accent palette (matches app.css --accent family).
  const palette = ['#c084fc', '#7c6cf0', '#5e9bff', '#36d399', '#ff79c6'];

  const parts: string[] = [];

  // Soft blobs: a few large, low-opacity radial circles scattered around.
  const blobCount = 4 + Math.floor(rand() * 3); // 4..6
  for (let i = 0; i < blobCount; i++) {
    const cx = Math.round(rand() * VIEW_W);
    const cy = Math.round(rand() * VIEW_H);
    const r = Math.round(120 + rand() * 220);
    const color = palette[Math.floor(rand() * palette.length)];
    const op = (0.05 + rand() * 0.08).toFixed(3);
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${op}"/>`,
    );
  }

  // Connecting strokes: a faint poly-line wandering across the canvas, evoking a
  // timeline / network of conversation.
  const pts: string[] = [];
  const steps = 5 + Math.floor(rand() * 4);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round((VIEW_W / steps) * i);
    const y = Math.round(VIEW_H * (0.2 + rand() * 0.6));
    pts.push(`${x},${y}`);
  }
  const lineColor = palette[Math.floor(rand() * palette.length)];
  parts.push(
    `<polyline points="${pts.join(' ')}" fill="none" stroke="${lineColor}" stroke-width="3" opacity="0.10" stroke-linejoin="round"/>`,
  );

  // Big faint phrases: the actual summary content, large and ghosted, laid out
  // on staggered baselines. This is the part that "reads" as the AI summary.
  const fontSizes = [120, 86, 64, 52, 44];
  phrases.forEach((p, i) => {
    const size = fontSizes[Math.min(i, fontSizes.length - 1)];
    const y = Math.round(VIEW_H * (0.22 + i * 0.16));
    const x = Math.round(40 + rand() * 80);
    const rot = (rand() * 6 - 3).toFixed(2);
    const op = (0.16 - i * 0.02).toFixed(3);
    parts.push(
      `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" ` +
        `font-family="system-ui, sans-serif" font-weight="800" font-size="${size}" ` +
        `fill="#f3f4f6" opacity="${op}">${esc(p)}</text>`,
    );
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" ` +
    `width="100%" height="100%" preserveAspectRatio="xMidYMid slice" ` +
    `role="img" aria-hidden="true">${parts.join('')}</svg>`
  );
}
