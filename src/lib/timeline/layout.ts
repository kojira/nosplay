// Pure, DOM-independent, deterministic 2D sweep-line vertical packer for the
// timeline cards. This replaces the old fixed-6-lane + busyMs 1D-interval
// approximation (see Timeline.svelte history / PLAN.md §1.2): that approach
// collapsed a real 2D (x-width × y-height) rectangle-collision problem into a
// 1D time-interval reservation, so the moment the width/height estimate drifted
// from the real measured size, cards overlapped or overflowed the bottom edge.
//
// This module owns ONLY vertical placement. The hard invariants it guarantees
// (PLAN.md §2):
//   C1 No overlap   — any two placed card rectangles (x-interval × y-interval,
//                     each padded by GAP) never intersect.
//   C2 No overflow  — every card fits in [0, H] vertically (y >= 0 and
//                     y + height <= H). Image cards included.
//   C3 Deterministic order — items arrive in (created_at, id) stable order
//                     (the caller guarantees this) and the output is identical
//                     run-to-run for the same input.
//   C4 Stable y     — once an id is placed it keeps its y for its lifetime,
//                     supplied via the `cache` map; horizontal motion happens
//                     outside this module, vertical never bounces.
//   C5 x is time-only — x0 is fixed by the caller from the note's time; the
//                     packer NEVER changes x to dodge an overlap, only y.
//   C6 Pure         — no Date.now()/Math.random()/IO. Placement is a pure
//                     function of (items, H, cache). The cache is mutated in
//                     place (documented below) but is itself caller-owned state
//                     keyed by id, so the result stays deterministic for a given
//                     (items, H, cache) triple.
//   C7 Monotone convergence — the caller seeds estimated sizes, then re-packs
//                     deterministically when real measurements / image sizes
//                     arrive. Re-packing updates y only (never x).
//
// Crowding fallback (PLAN.md §4.3.1 — author-stack display): when a note cannot
// be placed individually within [0, H] without overlap, it is folded into an
// author-stack with a near, same-author card — the stack keeps the FRONT card's
// rectangle as its single footprint, which is exactly what resolves the vertical
// shortage. Notes are never dropped: every input id ends up either as its own
// card or inside exactly one stack.

/** A card's placement inputs. x0/width/height are px (measured or estimated). */
export interface LayoutInput {
  /** Stable note id (used as the y-cache key and the stack-membership key). */
  id: string;
  /** Author pubkey — only same-author cards may share an author-stack. */
  author: string;
  /** Left edge in px, fixed by time (left = (1 - f) * W). Never adjusted here. */
  x0: number;
  /** Measured-or-estimated rendered width in px (without the GAP cushion). */
  width: number;
  /** Measured-or-estimated rendered height in px (without the GAP cushion). */
  height: number;
}

/** A card's chosen placement. y is the only field this module decides. */
export interface PlacedItem {
  id: string;
  /** Chosen top in px, in [0, H - height]. */
  y: number;
  width: number;
  height: number;
  x0: number;
  /**
   * For an author-stack FRONT card: the ids of the cards stacked BEHIND it, in
   * deterministic (created_at, id) input order. Undefined for a plain card.
   */
  stackedIds?: string[];
  /** For a stack front: total cards represented (behind count + 1). */
  count?: number;
}

/**
 * Cushion (px) added to BOTH width and height when testing intersection, so
 * adjacent cards keep a little breathing room instead of kissing edges. Folded
 * into the rectangle on every side via the half-open intervals below.
 */
export const GAP = 8;

/** Internal placed rectangle (the GAP-padded extent we test against). */
interface Rect {
  id: string;
  author: string;
  /** Padded x-interval [x0, x0 + width + GAP). */
  xa: number;
  xb: number;
  /** Padded y-interval [y, y + height + GAP). */
  ya: number;
  yb: number;
  /** Raw (un-padded) geometry, copied through to the PlacedItem. */
  x0: number;
  width: number;
  height: number;
  y: number;
  /** Stack members behind this front (deterministic order), if this is a stack. */
  stackedIds?: string[];
}

/** True when two padded x-intervals overlap (half-open, so touching edges pass). */
function xOverlap(a: Rect, x0: number, x1: number): boolean {
  return a.xa < x1 && x0 < a.xb;
}

/**
 * Pack `items` (already in (created_at, id) order) vertically into [0, H].
 *
 * `cache` is the caller-owned id→y map that gives C4 (stable y for a note's
 * lifetime). It is MUTATED IN PLACE: each individually-placed item's chosen y is
 * written back so the next pack reuses it. Stacked (behind) items are not given
 * their own y (they ride the front's footprint) and are removed from the cache.
 *
 * Returns one PlacedItem per item that owns a footprint, in input order. A stack
 * front carries `stackedIds` (the behind ids) and `count`. Items folded behind a
 * front do NOT get their own PlacedItem — they are listed in the front's
 * `stackedIds`, so every input id is represented exactly once (front or behind).
 */
export function packTimeline(items: LayoutInput[], H: number, cache: Map<string, number>): PlacedItem[] {
  const placed: Rect[] = [];
  // Ids that ended up folded behind some front; they get no own footprint.
  const behind = new Set<string>();

  /**
   * Collect the y-intervals of already-placed rects whose padded x-interval
   * overlaps [x0, x1), then find the smallest y >= 0 where a height-tall card
   * (padded) fits without intersecting any of them and stays within H. Returns
   * the chosen y, or null when nothing fits in [0, H] (→ stack fallback).
   *
   * Deterministic: candidate y values are 0 and the bottom edge (yb) of each
   * obstacle, scanned in ascending order — the classic skyline gap search.
   */
  function scanY(x0: number, width: number, height: number): number | null {
    const x1 = x0 + width + GAP;
    const padH = height + GAP;
    // y-intervals [ya, yb) of x-overlapping obstacles, sorted by top edge.
    const obstacles = placed
      .filter((r) => xOverlap(r, x0, x1))
      .map((r) => ({ ya: r.ya, yb: r.yb }))
      .sort((a, b) => a.ya - b.ya || a.yb - b.yb);
    // Candidate tops: 0 first, then just below each obstacle's bottom.
    const candidates = [0, ...obstacles.map((o) => o.yb)];
    for (const cy of candidates) {
      if (cy < 0) continue;
      // C2: the raw card (height, not padded) must end within H.
      if (cy + height > H) continue;
      // C1: padded [cy, cy + padH) must miss every obstacle.
      const top = cy;
      const bot = cy + padH;
      let clear = true;
      for (const o of obstacles) {
        if (o.ya < bot && top < o.yb) {
          clear = false;
          break;
        }
      }
      if (clear) return cy;
    }
    return null;
  }

  /** Push a freshly-placed rect into the active set and remember its geometry. */
  function commit(it: LayoutInput, y: number): Rect {
    const rect: Rect = {
      id: it.id,
      author: it.author,
      xa: it.x0,
      xb: it.x0 + it.width + GAP,
      ya: y,
      yb: y + it.height + GAP,
      x0: it.x0,
      width: it.width,
      height: it.height,
      y,
    };
    placed.push(rect);
    cache.set(it.id, y);
    return rect;
  }

  for (const it of items) {
    const x1 = it.x0 + it.width + GAP;

    // 1. Reuse a cached y if it still satisfies C1 (vs. already-placed
    //    x-overlapping rects) and C2. This is what keeps a note's vertical row
    //    fixed for its lifetime (C4).
    const cachedY = cache.get(it.id);
    if (cachedY !== undefined && cachedY >= 0 && cachedY + it.height <= H) {
      const top = cachedY;
      const bot = cachedY + it.height + GAP;
      let clear = true;
      for (const r of placed) {
        if (xOverlap(r, it.x0, x1) && r.ya < bot && top < r.yb) {
          clear = false;
          break;
        }
      }
      if (clear) {
        commit(it, cachedY);
        continue;
      }
    }

    // 2. Find the smallest valid y from the top down.
    const y = scanY(it.x0, it.width, it.height);
    if (y !== null) {
      commit(it, y);
      continue;
    }

    // 3. No individual placement fits without overlapping or overflowing H →
    //    author-stack fallback (C2 stays inviolate; the note is never dropped).
    //    A fold only resolves the vertical shortage when the front actually SHARES
    //    this card's x-column: the stack reuses the front's footprint, so a card
    //    that does NOT x-overlap would still demand its own (unavailable) vertical
    //    slot. We therefore only ever fold behind an x-OVERLAPPING front. Folding
    //    behind a non-overlapping (distant) card was over-eager — it stacked notes
    //    that shared no column with their front even when the column merely lacked
    //    a single full-height gap. Since `scanY` already proved no standalone slot
    //    exists at this x0 (step 2), an x-overlapping front is the only placement
    //    that keeps C1 without inventing vertical space.
    //    Prefer a SAME-author x-overlapping front (PLAN §4.3.1 author stacks).
    //    Deterministic tiebreak: lowest y, then lowest x0. `placed` is already in
    //    input = (created_at, id) order, so equal (y, x0) keeps the earliest.
    let front: Rect | null = null;
    for (const r of placed) {
      if (r.author !== it.author) continue;
      if (!xOverlap(r, it.x0, x1)) continue;
      if (front === null || r.y < front.y || (r.y === front.y && r.x0 < front.x0)) {
        front = r;
      }
    }
    if (front === null) {
      // No same-author front is available. As a last resort fold behind the
      // nearest x-OVERLAPPING front of ANY author so the column shortage is still
      // resolved by footprint reuse (C1 preserved, note never dropped). This
      // mixed fallback is deliberately after scanY failed, so it cannot steal a
      // card that could have been placed standalone.
      for (const r of placed) {
        if (!xOverlap(r, it.x0, x1)) continue;
        const dx = Math.abs(r.x0 - it.x0);
        if (front === null) {
          front = r;
        } else {
          const fdx = Math.abs(front.x0 - it.x0);
          if (dx < fdx || (dx === fdx && (r.y < front.y || (r.y === front.y && r.x0 < front.x0)))) {
            front = r;
          }
        }
      }
    }
    if (front === null) {
      // No x-overlapping card at all: the card is simply taller than H (scanY
      // rejected every candidate on the C2 ceiling, not on overlap). There is no
      // valid stack front, so place it at y = 0 so it still owns a footprint — we
      // never drop.
      commit(it, 0);
      continue;
    }
    if (front.stackedIds === undefined) front.stackedIds = [];
    front.stackedIds.push(it.id);
    behind.add(it.id);
    // Behind cards ride the front's footprint, so drop any stale own-y so a
    // later un-crowded pack re-scans them fresh rather than reusing a bad y.
    cache.delete(it.id);
  }

  // Emit one PlacedItem per footprint-owning rect, in input order. Behind ids
  // are represented inside their front's stackedIds, never as their own card.
  const out: PlacedItem[] = [];
  for (const it of items) {
    if (behind.has(it.id)) continue;
    const r = placed.find((p) => p.id === it.id);
    if (!r) continue; // (shouldn't happen — every non-behind item is committed)
    const item: PlacedItem = {
      id: r.id,
      y: r.y,
      width: r.width,
      height: r.height,
      x0: r.x0,
    };
    if (r.stackedIds && r.stackedIds.length > 0) {
      item.stackedIds = r.stackedIds;
      item.count = r.stackedIds.length + 1;
    }
    out.push(item);
  }
  return out;
}
