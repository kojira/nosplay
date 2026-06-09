<script lang="ts">
  import { timeline } from '../timeline/store.svelte';
  import { shortNpub } from '../timeline/format';
  import type { Note } from '../nostr/types';

  const LANES = 8; // vertical lanes for the comment stack
  // Approximate seconds of horizontal space a comment occupies, used to keep a
  // lane "busy" so the next note doesn't overlap it.
  const LANE_BUSY_MS = 14_000;

  interface Placed {
    note: Note;
    /** 0 = right edge (playhead), 1 = left edge (window start). */
    f: number;
    lane: number;
    isHead: boolean;
  }

  // Assign lanes greedily over the time-ordered visible notes so labels do not
  // overlap. visibleNotes is ascending by created_at.
  const placed = $derived.by<Placed[]>(() => {
    const notes = timeline.visibleNotes;
    const playhead = timeline.playheadMs;
    const win = timeline.windowMs;
    const headId = timeline.headNote?.id ?? null;
    const laneFreeAt = new Array<number>(LANES).fill(-Infinity);
    const out: Placed[] = [];
    for (const note of notes) {
      const ms = note.created_at * 1000;
      const f = (playhead - ms) / win; // 0..1 from right edge
      // pick the lane that has been free longest
      let lane = 0;
      let best = laneFreeAt[0];
      for (let i = 1; i < LANES; i++) {
        if (laneFreeAt[i] < best) {
          best = laneFreeAt[i];
          lane = i;
        }
      }
      laneFreeAt[lane] = ms + LANE_BUSY_MS;
      out.push({ note, f, lane, isHead: note.id === headId });
    }
    return out;
  });

  function name(n: Note): string {
    return timeline.names.get(n.pubkey)?.name ?? shortNpub(n.pubkey);
  }
</script>

<div class="timeline" role="log" aria-label="Live timeline of notes">
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
      <span class="author">{name(p.note)}</span>
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
    transform: translateX(50%);
    white-space: nowrap;
    max-width: 46vw;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 4px 10px;
    border-radius: 8px;
    background: rgba(28, 31, 41, 0.78);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 14px;
    line-height: 1.45;
    pointer-events: none;
  }

  .note .author {
    color: var(--accent);
    font-weight: 600;
    margin-right: 6px;
    font-size: 12px;
  }

  .note .content {
    color: var(--text-h);
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
