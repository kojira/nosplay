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
    isSpeaking: boolean;
    isMuted: boolean;
  }

  // Identity-keyed lane cache. A note keeps the lane it was first assigned for
  // its whole lifetime, so as the visible window slides the note's vertical
  // row never changes — it scrolls horizontally without bouncing up/down. This
  // replaces the previous purely greedy, window-local reassignment (which
  // recomputed every lane each frame and so jittered as earlier notes left the
  // window). Cleared when the feed is rebuilt (see feedVersion below).
  const laneByNote = new Map<string, number>();
  // Per-author preferred lane: when a brand-new note needs a row, we try to put
  // it on the same lane its author last used (if free), keeping an author's
  // notes on a consistent line. Also reset on feed rebuild.
  const laneByAuthor = new Map<string, number>();
  let laneFeedVersion = -1;

  /**
   * Pick a lane for a note not yet in the cache. Deterministic given the lanes'
   * current free times: prefer the author's previous lane when it's free, else
   * the lane that frees soonest (least overlap). Never reassigns an existing
   * note, so it cannot cause vertical bounce.
   */
  function chooseLane(laneFreeAt: number[], ms: number, preferred: number | undefined): number {
    if (preferred !== undefined && laneFreeAt[preferred] <= ms) return preferred;
    let lane = 0;
    let best = laneFreeAt[0];
    for (let i = 1; i < LANES; i++) {
      if (laneFreeAt[i] < best) {
        best = laneFreeAt[i];
        lane = i;
      }
    }
    return lane;
  }

  // Place the time-ordered visible notes into stable lanes. visibleNotes is
  // ascending by created_at and never includes notes newer than the playhead,
  // so f is always >= 0 (nothing renders to the right of the playhead line).
  const placed = $derived.by<Placed[]>(() => {
    const notes = timeline.visibleNotes;
    const playhead = timeline.playheadMs;
    const win = timeline.windowMs;

    // Drop cached lanes when the feed was torn down and rebuilt.
    if (timeline.feedVersion !== laneFeedVersion) {
      laneByNote.clear();
      laneByAuthor.clear();
      laneFeedVersion = timeline.feedVersion;
    }

    // How much of the window one note (plus gap) covers horizontally. Derived
    // from the real container width so spacing matches the rendered box size
    // instead of a hand-tuned guess; capped so it never exceeds the window.
    const noteWidthPx = Math.min(MAX_NOTE_PX, containerW * NOTE_VW_FRACTION) + GAP_PX;
    const busyFraction =
      containerW > 0 ? Math.min(noteWidthPx / containerW, 1) : FALLBACK_BUSY_FRACTION;
    const busyMs = win * busyFraction;
    const headId = timeline.headNote?.id ?? null;
    const speakingId = timeline.speakingId;
    const muted = timeline.mutedPubkeys;
    const laneFreeAt = new Array<number>(LANES).fill(-Infinity);
    const out: Placed[] = [];
    for (const note of notes) {
      const ms = note.created_at * 1000;
      const f = (playhead - ms) / win; // 0..1 from right edge
      // Reuse the note's existing lane when known; only assign one the first
      // time we see it. New notes fit around the lanes already occupied this
      // pass, so overlaps stay reasonable while existing rows stay put.
      let lane = laneByNote.get(note.id);
      if (lane === undefined) {
        lane = chooseLane(laneFreeAt, ms, laneByAuthor.get(note.pubkey));
        laneByNote.set(note.id, lane);
      }
      laneByAuthor.set(note.pubkey, lane);
      laneFreeAt[lane] = ms + busyMs;
      out.push({
        note,
        f,
        lane,
        isHead: note.id === headId,
        isSpeaking: note.id === speakingId,
        isMuted: muted.has(note.pubkey),
      });
    }
    return out;
  });

  // ---- tap/click menu + full-text modal ----
  /** Note whose action menu is open, or null. */
  let menuNote = $state<Note | null>(null);
  /** Note whose full text is shown in the modal, or null. */
  let fullTextNote = $state<Note | null>(null);

  function openMenu(note: Note): void {
    menuNote = note;
  }

  function closeMenu(): void {
    menuNote = null;
  }

  function showFullText(): void {
    fullTextNote = menuNote;
    menuNote = null;
  }

  function toggleMute(): void {
    if (menuNote) timeline.toggleMute(menuNote.pubkey);
    menuNote = null;
  }

  function onOverlayKey(e: KeyboardEvent, close: () => void): void {
    if (e.key === 'Escape') close();
  }

  function onNoteKey(e: KeyboardEvent, note: Note): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu(note);
    }
  }

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
      class:speaking={p.isSpeaking}
      class:muted={p.isMuted}
      style="right: {p.f * 100}%; top: {(p.lane / LANES) * 100}%;"
      role="button"
      tabindex="0"
      title="Tap for options"
      onclick={() => openMenu(p.note)}
      onkeydown={(e) => onNoteKey(e, p.note)}
    >
      <div class="head-row">
        {#if p.isSpeaking}
          <span class="speaking-badge" title="Reading aloud" aria-label="Reading aloud">🔊</span>
        {/if}
        {#if p.isMuted}
          <span class="muted-badge" title="TTS muted for this author" aria-label="TTS muted">🔇</span>
        {/if}
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

  <!-- per-note action menu (opened by tapping a note) -->
  {#if menuNote}
    <div
      class="overlay"
      role="presentation"
      onclick={closeMenu}
      onkeydown={(e) => onOverlayKey(e, closeMenu)}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="menu" role="menu" tabindex="-1" aria-label="Note options" onclick={(e) => e.stopPropagation()}>
        <div class="menu-title">{name(menuNote)}</div>
        <button class="menu-item" type="button" role="menuitem" onclick={showFullText}>
          Show full post text
        </button>
        <button class="menu-item" type="button" role="menuitem" onclick={toggleMute}>
          {timeline.isMuted(menuNote.pubkey) ? 'Unmute TTS for this author' : 'Mute TTS for this author'}
        </button>
        <button class="menu-item cancel" type="button" role="menuitem" onclick={closeMenu}>
          Cancel
        </button>
      </div>
    </div>
  {/if}

  <!-- full post text modal -->
  {#if fullTextNote}
    <div
      class="overlay"
      role="presentation"
      onclick={() => (fullTextNote = null)}
      onkeydown={(e) => onOverlayKey(e, () => (fullTextNote = null))}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="modal" role="dialog" tabindex="-1" aria-modal="true" aria-label="Full post text" onclick={(e) => e.stopPropagation()}>
        <div class="modal-head">{name(fullTextNote)}</div>
        <div class="modal-body">{fullTextNote.content}</div>
        <button class="menu-item" type="button" onclick={() => (fullTextNote = null)}>Close</button>
      </div>
    </div>
  {/if}
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
    /* Notes are interactive: tapping one opens its action menu. */
    pointer-events: auto;
    cursor: pointer;
    text-align: left;
  }

  .note:focus-visible {
    outline: 2px solid var(--accent-border);
    outline-offset: 2px;
  }

  /* An author muted for TTS: dimmed slightly so it's visible at a glance. */
  .note.muted {
    opacity: 0.7;
  }

  .muted-badge {
    flex: 0 0 auto;
    font-size: 12px;
    line-height: 1;
    opacity: 0.9;
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

  /* The note currently being read aloud by TTS. Uses `outline` (not box-shadow)
     so it layers cleanly on top of .note.head's box-shadow when both apply. */
  .note.speaking {
    outline: 2px solid var(--accent-border);
    outline-offset: 2px;
    animation: ttsPulse 1.1s ease-in-out infinite;
    z-index: 6;
  }

  @keyframes ttsPulse {
    0%,
    100% {
      outline-color: var(--accent-border);
    }
    50% {
      outline-color: transparent;
    }
  }

  .speaking-badge {
    flex: 0 0 auto;
    font-size: 12px;
    line-height: 1;
    opacity: 0.9;
  }

  @media (prefers-reduced-motion: reduce) {
    .note.speaking {
      animation: none;
    }
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

  /* ---- tap menu + full-text modal ---- */
  .overlay {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    padding: 16px;
  }

  .menu,
  .modal {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  }

  .menu {
    min-width: 240px;
    max-width: 90%;
  }

  .menu-title,
  .modal-head {
    color: var(--accent);
    font-weight: 600;
    font-size: 13px;
    padding: 2px 4px 6px;
    border-bottom: 1px solid var(--border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-item {
    appearance: none;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--text);
    font-size: 14px;
    padding: 8px 10px;
    cursor: pointer;
  }

  .menu-item:hover,
  .menu-item:focus-visible {
    background: var(--accent-bg);
    border-color: var(--accent-border);
    outline: none;
  }

  .menu-item.cancel {
    color: var(--text-dim);
  }

  .modal {
    width: min(560px, 92%);
    max-height: 80%;
  }

  .modal-body {
    color: var(--text-h);
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow-y: auto;
    padding: 8px 4px;
  }
</style>
