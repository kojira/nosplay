// Shareable view-range links. A link encodes the visible time range as concise
// epoch-second query params (?start=&end=). Opening such a link reproduces the
// range: end becomes the playhead (right edge) and end-start becomes the window.
// Times are seconds (matching Nostr's created_at) to keep URLs short.

/** A view range parsed from a share link. Both bounds are epoch milliseconds. */
export interface ShareRange {
  /** Left edge of the visible window (epoch ms), if the link carried it. */
  startMs?: number;
  /** Right edge / playhead (epoch ms), if the link carried it. */
  endMs?: number;
}

/** Parse a positive epoch-second query param into epoch ms, or undefined. */
function secParam(q: URLSearchParams, key: string): number | undefined {
  const raw = q.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1000);
}

/**
 * Parse share params from a query string (e.g. `window.location.search`).
 * Returns null when neither `start` nor `end` is present/valid, so callers can
 * cheaply skip when a link carries no range (preserving default app behavior).
 */
export function parseShareParams(search: string): ShareRange | null {
  const q = new URLSearchParams(search);
  const startMs = secParam(q, 'start');
  const endMs = secParam(q, 'end');
  if (startMs === undefined && endMs === undefined) return null;
  return { startMs, endMs };
}

/**
 * Build a shareable absolute URL for the range [startMs, endMs] (epoch ms),
 * based on the current page URL but with a fresh query (no stale params/hash).
 * Bounds are emitted as floored epoch seconds.
 */
export function buildShareUrl(startMs: number, endMs: number): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('start', String(Math.floor(startMs / 1000)));
  url.searchParams.set('end', String(Math.floor(endMs / 1000)));
  return url.toString();
}
