<script lang="ts">
  import { timeline } from '../timeline/store.svelte';
  import { shortNpub } from '../timeline/format';
  import type { ProfileMeta } from '../nostr/profiles';
  import type { Note } from '../nostr/types';

  const LANES = 6; // vertical lanes for the comment stack
  // A note is right-anchored at its time and grows leftward up to this pixel
  // width (mirrors the .note CSS: max-width min(340px, 60vw)). Two same-lane
  // notes overlap when their horizontal gap is smaller than this, so we keep a
  // lane "busy" for exactly the time span this width occupies at the current
  // zoom. GAP_PX adds a little breathing room between adjacent notes.
  const MAX_NOTE_PX = 340;
  const NOTE_VW_FRACTION = 0.6;
  const GAP_PX = 8;
  // Fallback fraction used before the container width is measured.
  const FALLBACK_BUSY_FRACTION = 0.16;

  /** Measured timeline width (px); drives the busy-interval calculation. */
  let containerW = $state(0);

  interface Placed {
    note: Note;
    /** 0 = right edge (playhead), 1 = left edge (window start). */
    f: number;
    lane: number;
    isHead: boolean;
  }

  // Assign lanes greedily over the time-ordered visible notes so labels do not
  // overlap. visibleNotes is ascending by created_at and never includes notes
  // newer than the playhead, so f is always >= 0 (nothing renders to the right
  // of the playhead line).
  const placed = $derived.by<Placed[]>(() => {
    const notes = timeline.visibleNotes;
    const playhead = timeline.playheadMs;
    const win = timeline.windowMs;
    // How much of the window one note (plus gap) covers horizontally. Derived
    // from the real container width so spacing matches the rendered box size
    // instead of a hand-tuned guess; capped so it never exceeds the window.
    const noteWidthPx = Math.min(MAX_NOTE_PX, containerW * NOTE_VW_FRACTION) + GAP_PX;
    const busyFraction =
      containerW > 0 ? Math.min(noteWidthPx / containerW, 1) : FALLBACK_BUSY_FRACTION;
    const busyMs = win * busyFraction;
    const headId = timeline.headNote?.id ?? null;
    const laneFreeAt = new Array<number>(LANES).fill(-Infinity);
    const out: Placed[] = [];
    for (const note of notes) {
      const ms = note.created_at * 1000;
      const f = (playhead - ms) / win; // 0..1 from right edge
      // Prefer a lane that is genuinely free at this time; otherwise fall back
      // to the lane that frees soonest (least overlap) so a note is never
      // dropped even under bursty load.
      let lane = 0;
      let best = laneFreeAt[0];
      for (let i = 1; i < LANES; i++) {
        if (laneFreeAt[i] < best) {
          best = laneFreeAt[i];
          lane = i;
        }
      }
      laneFreeAt[lane] = ms + busyMs;
      out.push({ note, f, lane, isHead: note.id === headId });
    }
    return out;
  });

  function meta(n: Note): ProfileMeta | undefined {
    return timeline.names.get(n.pubkey);
  }

  function name(n: Note): string {
    return meta(n)?.name ?? shortNpub(n.pubkey);
  }

  function initial(n: Note): string {
    const nm = meta(n)?.name;
    return (nm ?? n.pubkey).slice(0, 1).toUpperCase();
  }

  // Hide a broken avatar image so the letter fallback (behind it) shows through.
  function onAvatarError(e: Event): void {
    (e.currentTarget as HTMLImageElement).style.display = 'none';
  }
</script>

<div
  class="timeline"
  role="log"
  aria-label="Live timeline of notes"
  bind:clientWidth={containerW}
>
  {#if placed.length === 0}
    <div class="empty">
      {#if timeline.status === 'connecting'}
        Connecting to relays…
      {:else}
        Waiting for notes in this time window…
      {/if}
    </div>
  {/if}

  {#each placed as p (p.note.id)}
    <div
      class="note"
      class:head={p.isHead}
      style="right: {p.f * 100}%; top: {(p.lane / LANES) * 100}%;"
    >
      <div class="head-row">
        <span class="avatar" aria-hidden="true">
          <span class="avatar-fallback">{initial(p.note)}</span>
          {#if meta(p.note)?.picture}
            <img
              class="avatar-img"
              src={meta(p.note)?.picture}
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              onerror={onAvatarError}
            />
          {/if}
        </span>
        <span class="author">{name(p.note)}</span>
      </div>
      <span class="content">{p.note.content}</span>
    </div>
  {/each}

  <!-- playhead marker at the right edge -->
  <div class="playhead-line" aria-hidden="true"></div>
</div>

<style>
  .timeline {
    position: relative;
    flex: 1 1 auto;
    overflow: hidden;
    background: var(--bg);
    min-height: 0;
  }

  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    font-size: 14px;
  }

  .note {
    position: absolute;
    /* Right-anchored at the note's time position; content grows leftward into
       the past, so a note never spills past the playhead (right edge). */
    width: max-content;
    max-width: min(340px, 60vw);
    max-height: calc((100% / 6) - 8px);
    margin-right: 4px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 10px;
    border-radius: 8px;
    background: rgba(28, 31, 41, 0.82);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 14px;
    line-height: 1.4;
    overflow: hidden;
    pointer-events: none;
  }

  .head-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .avatar {
    position: relative;
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--accent-bg);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .avatar-fallback {
    color: var(--accent);
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
  }

  .avatar-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .note .author {
    color: var(--accent);
    font-weight: 600;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .note .content {
    color: var(--text-h);
    /* Wrap long posts and clamp to a few lines instead of harshly truncating
       to a single ellipsised line. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
  }

  .note.head {
    background: var(--accent-bg);
    border-color: var(--accent-border);
    box-shadow: 0 0 0 1px var(--accent-border);
    z-index: 5;
  }

  .playhead-line {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 2px;
    background: var(--live);
    opacity: 0.7;
  }
</style>
