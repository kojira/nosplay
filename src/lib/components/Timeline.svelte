<script lang="ts">
  import { timeline } from '../timeline/store.svelte';
  import { shortNpub } from '../timeline/format';
  import { getNoteImageUrls } from '../nostr/images';
  import { formatNoteContent } from '../nostr/mentions';
  import { njumpUrl } from '../nostr/njump';
  import type { ProfileMeta } from '../nostr/profiles';
  import type { Note } from '../nostr/types';

  const LANES = 6; // vertical lanes for the comment stack
  // Each note is left-anchored at its time and grows rightward toward the newer
  // side, rendered as a box whose width depends on its content (mirrors the
  // .note CSS: width:max-content; max-width:min(340px, 60vw)). Two notes on the
  // same lane visually overlap when the older (further-left) box extends right
  // far enough to reach the newer note's anchor, so we keep a lane "busy" for
  // exactly the time span *that note's own box* occupies forward in time from
  // its anchor at the current zoom (estNotePx → busyMs).
  // Earlier this reserved the single MAX width for every note, which both
  // over-reserved short notes (wasting lane time) and still let wide notes
  // collide; the per-note, content-aware estimate below replaces that.
  const MAX_NOTE_PX = 340; // .note max-width cap (px)
  const MIN_NOTE_PX = 120; // floor so tiny notes still reserve breathing room
  const IMG_NOTE_PX = 220; // floor for image-bearing notes (thumbnail is wider)
  const NOTE_VW_FRACTION = 0.6; // .note max-width: ...60vw
  const PAD_X = 10; // .note horizontal padding (px), both sides
  const AVATAR_PX = 18; // .avatar width
  const HEAD_GAP_PX = 6; // .head-row gap (avatar → author)
  const CONTENT_FONT = 14; // .note .content font-size
  const AUTHOR_FONT = 12; // .note .author font-size
  const GAP_PX = 8; // base horizontal gap reserved between adjacent notes
  const LANE_BUFFER_PX = 12; // extra cushion so same-lane neighbours never kiss
  // Vertical footprint, in lanes, that a card occupies for collision avoidance.
  // A plain text card is capped to a single lane by CSS (.note max-height:
  // calc((100%/6) - 8px)). An image card is image-first and intentionally taller
  // — it occupies IMG_LANE_SPAN consecutive lanes. The placement reserves that
  // many lanes (so other cards never overlap the image region) AND never starts
  // an image card lower than LANES - IMG_LANE_SPAN (so it can't overflow the
  // bottom edge). The CSS .note.has-image max-height MUST match this span
  // (currently 2 lanes); changing one without the other reintroduces overlap.
  const TEXT_LANE_SPAN = 1;
  const IMG_LANE_SPAN = 2;
  // Fallback fraction used before the container width is measured. Leans
  // conservative (wide) so the un-measured first frame never packs notes too
  // tightly; once containerW is known the per-note estimate takes over.
  const FALLBACK_BUSY_FRACTION = 0.2;

  /**
   * True for code points that render at roughly one full em (CJK ideographs,
   * Hiragana, Katakana, Hangul, full-width forms, common CJK punctuation). This
   * is a Japanese-heavy app (のすたろう), so most content is full-width; Latin
   * and other narrow glyphs are treated as ~0.55em. The 0x1100 floor catches
   * Hangul Jamo upward; below it (Latin, Greek, Cyrillic, symbols) is narrow.
   */
  function isWide(cp: number): boolean {
    return (
      cp >= 0x1100 &&
      (cp <= 0x115f || // Hangul Jamo
        (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
        (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
        (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
        (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
        (cp >= 0xff00 && cp <= 0xff60) || // full-width forms
        (cp >= 0xffe0 && cp <= 0xffe6) || // full-width signs
        (cp >= 0x1f300 && cp <= 0x1faff)) // emoji / pictographs
    );
  }

  /** Estimate a string's single-line rendered width in px at the given font. */
  function estTextPx(str: string, fontPx: number): number {
    let w = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0) ?? 0;
      w += isWide(cp) ? fontPx : fontPx * 0.55;
    }
    return w;
  }

  /**
   * Estimate a note's rendered horizontal px occupancy from its author label and
   * content, clamped to the real CSS max width. The box wraps and clamps content
   * to 3 lines, so its width is roughly the wider of the head row (avatar + gap +
   * author text) and the *capped* single-line content estimate, plus padding.
   * Result is clamped into [MIN_NOTE_PX, maxNotePx]. `maxNotePx` is the effective
   * CSS max for the current container; pass MAX_NOTE_PX before it is measured.
   */
  function estNotePx(
    authorText: string,
    content: string,
    maxNotePx: number,
    hasImage: boolean,
  ): number {
    const innerMax = Math.max(MIN_NOTE_PX - PAD_X * 2, maxNotePx - PAD_X * 2);
    const headRow = AVATAR_PX + HEAD_GAP_PX + estTextPx(authorText, AUTHOR_FONT);
    const contentLine = Math.min(estTextPx(content, CONTENT_FONT), innerMax);
    const inner = Math.max(headRow, contentLine);
    const total = inner + PAD_X * 2;
    // Image-bearing notes render a thumbnail that is visually wider than short
    // text, so reserve a wider lane span for them (clamped to the CSS max) — this
    // keeps an image card from being under-reserved and overlapping its neighbour.
    const floor = hasImage ? Math.min(maxNotePx, IMG_NOTE_PX) : MIN_NOTE_PX;
    return Math.min(maxNotePx, Math.max(floor, total));
  }

  /** http/https URLs in free text (mirrors src/lib/nostr/images.ts URL_RE). */
  const CONTENT_URL_RE = /https?:\/\/[^\s<>"'()]+/gi;
  /** Image file extensions, matched on the URL path (same set as images.ts). */
  const IMG_EXT_RE = /\.(?:jpe?g|png|gif|webp|avif|bmp|svgz?)$/i;

  /** True if `raw` is an http(s) image URL already shown as a thumbnail. */
  function isImageUrl(raw: string, imageSet: Set<string>): boolean {
    try {
      const u = new URL(raw.trim());
      if (imageSet.has(u.href)) return true;
      return IMG_EXT_RE.test(u.pathname);
    } catch {
      return false;
    }
  }

  /**
   * Card-only display text for an image-bearing note: strips the raw image-URL
   * strings (the very URLs already rendered as a thumbnail) so the link text
   * doesn't dominate the card body. Reuses the placement's `images` list to
   * decide what counts as an attachment. Non-image text/links stay visible; a
   * post that is *only* image URLs collapses to a compact neutral label instead
   * of rendering blank. The raw `note.content` and the full-text modal (which
   * re-derives from `note.content`) are untouched — this is display-only.
   */
  function cardText(display: string, images: string[]): string {
    if (images.length === 0) return display;
    const imageSet = new Set(images);
    const stripped = display
      .replace(CONTENT_URL_RE, (m) => (isImageUrl(m, imageSet) ? '' : m))
      // Tidy the whitespace the removed URLs leave behind.
      .replace(/[^\S\n]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return stripped || 'Image post';
  }

  /** Measured timeline width (px); drives the busy-interval calculation. */
  let containerW = $state(0);

  /** The AI-background layer element, bound when the feature renders an SVG. */
  let aiBgEl = $state<HTMLDivElement | null>(null);

  // Verify, after every SVG swap, that the background actually landed in the
  // DOM and is laid out so it can be seen, then report the measurement back to
  // the store. This is what turns the store's debug snapshot from "we built an
  // SVG string" into "an <svg> is on the page at this size/opacity/z-index",
  // which is the difference the YES/NO verdict hinges on. Reading aiBgSvg /
  // aiBgEnabled makes the effect re-run on each render. reportAiBgDom() reads
  // *and* writes aiBgDebug, so aiBgDebug is in fact a tracked dependency of this
  // effect — the loop is broken on the store side, where reportAiBgDom() skips
  // the write when the measurement is unchanged (idempotent), so the effect
  // settles instead of re-dirtying itself.
  $effect(() => {
    const svg = timeline.aiBgSvg;
    const enabled = timeline.aiBgEnabled;
    const el = aiBgEl;
    if (!enabled || !svg || !el) {
      timeline.reportAiBgDom(null);
      return;
    }
    const svgEl = el.querySelector('svg');
    if (!svgEl) {
      timeline.reportAiBgDom({
        inserted: false,
        svgChars: 0,
        viewBox: '',
        width: 0,
        height: 0,
        opacity: 0,
        zIndex: '',
      });
      return;
    }
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    timeline.reportAiBgDom({
      inserted: true,
      svgChars: svgEl.outerHTML.length,
      viewBox: svgEl.getAttribute('viewBox') ?? '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      opacity: Number.parseFloat(cs.opacity) || 0,
      zIndex: cs.zIndex,
    });
  });

  interface Placed {
    note: Note;
    /** 0 = right edge (playhead), 1 = left edge (window start). The card's
     *  LEFT edge is placed at (1 - f). */
    f: number;
    lane: number;
    isHead: boolean;
    isSpeaking: boolean;
    isMuted: boolean;
    /** Previewable image URLs for this note (computed once per placement pass). */
    images: string[];
    /** Card-display content: legacy `#[i]` references rewritten to mention
     *  labels and, on image notes, raw image-URL strings stripped (falling
     *  back to a neutral "Image post" label when nothing else remains). Used
     *  for the card text and width estimate; note.content stays raw. */
    display: string;
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
   * Pick a starting lane for a note not yet in the cache, reserving `span`
   * consecutive lanes (1 for text, IMG_LANE_SPAN for an image card). The card
   * occupies lanes [start .. start+span-1], so:
   *   - `start` is constrained to 0 .. LANES-span, which guarantees the card's
   *     bottom never falls past the last lane (no bottom overflow);
   *   - a block is "free" only when ALL its lanes are free at `ms`, so a taller
   *     image card can't be slotted on top of a neighbour it would overlap.
   * Deterministic: prefer the author's previous lane when its block is free,
   * else the lowest fully-free block, else the block that frees soonest (least
   * overlap). Never reassigns an existing note, so it cannot cause vertical
   * bounce. For span === 1 this reduces to the previous lowest-free behaviour.
   */
  function chooseLane(
    laneFreeAt: number[],
    ms: number,
    preferred: number | undefined,
    span: number,
  ): number {
    const maxStart = LANES - span;
    // Latest free-time across a span-wide block starting at `s` (the block is
    // free for a new note only once its busiest lane has freed).
    const blockFreeAt = (s: number): number => {
      let f = -Infinity;
      for (let i = s; i < s + span; i++) if (laneFreeAt[i] > f) f = laneFreeAt[i];
      return f;
    };
    if (preferred !== undefined && preferred <= maxStart && blockFreeAt(preferred) <= ms) {
      return preferred;
    }
    let lane = 0;
    let best = Infinity;
    for (let s = 0; s <= maxStart; s++) {
      const f = blockFreeAt(s);
      if (f <= ms) return s; // lowest fully-free block
      if (f < best) {
        best = f;
        lane = s;
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

    // Effective CSS max note width for the current container (min(340px, 60vw)).
    // Before the container is measured (containerW === 0) fall back to the px cap.
    const maxNotePx = containerW > 0 ? Math.min(MAX_NOTE_PX, containerW * NOTE_VW_FRACTION) : MAX_NOTE_PX;
    const measured = containerW > 0;
    const headId = timeline.headNote?.id ?? null;
    const speakingId = timeline.speakingId;
    const muted = timeline.mutedPubkeys;
    const laneFreeAt = new Array<number>(LANES).fill(-Infinity);
    const out: Placed[] = [];
    for (const note of notes) {
      const ms = note.created_at * 1000;
      const f = (playhead - ms) / win; // 0..1 from right edge
      // Resolve image URLs once here, then reuse for both the lane-width
      // estimate and rendering (the template never re-scans the note).
      const images = getNoteImageUrls(note);
      // Rewrite legacy `#[i]` mentions, then (for image notes) strip the raw
      // image-URL strings so the thumbnail leads instead of the link text.
      // Computed once and reused for both the width estimate and the rendered
      // card text (keeps the two in sync); the modal re-derives from raw content.
      const display = cardText(formatNoteContent(note.content, note.tags), images);
      // Vertical footprint in lanes: an image card is taller (image-first) and
      // occupies IMG_LANE_SPAN consecutive lanes; a text card occupies one. The
      // span drives both how many lanes we reserve (so neighbours don't overlap
      // the taller image region) and how low the card may start (so it can't
      // overflow the bottom edge) — see chooseLane.
      const span = images.length > 0 ? IMG_LANE_SPAN : TEXT_LANE_SPAN;
      // Reuse the note's existing lane when known; only assign one the first
      // time we see it. New notes fit around the lanes already occupied this
      // pass, so overlaps stay reasonable while existing rows stay put.
      let lane = laneByNote.get(note.id);
      if (lane === undefined) {
        lane = chooseLane(laneFreeAt, ms, laneByAuthor.get(note.pubkey), span);
        laneByNote.set(note.id, lane);
      }
      laneByAuthor.set(note.pubkey, lane);
      // Reserve this lane for exactly the time span this note's own box covers.
      // The box extends forward (rightward) in time from the note's left-edge
      // anchor, so reserving up to `ms + busyMs` is exactly right.
      // Content-aware (vs. the old single MAX width for every note): short notes
      // free their lane sooner, wide notes hold it longer so they can't collide.
      const busyMs = measured
        ? win * Math.min((estNotePx(name(note), display, maxNotePx, images.length > 0) + GAP_PX + LANE_BUFFER_PX) / containerW, 1)
        : win * FALLBACK_BUSY_FRACTION;
      // Reserve every lane this card spans vertically, so a taller image card
      // holds its whole footprint busy for that time and nothing is placed over
      // it. `lane + span <= LANES` is guaranteed by chooseLane.
      const freeAt = ms + busyMs;
      for (let i = lane; i < lane + span; i++) laneFreeAt[i] = freeAt;
      out.push({
        note,
        f,
        lane,
        isHead: note.id === headId,
        isSpeaking: note.id === speakingId,
        isMuted: muted.has(note.pubkey),
        images,
        display,
      });
    }
    return out;
  });

  // ---- tap/click menu + full-text modal ----
  /** Note whose action menu is open, or null. */
  let menuNote = $state<Note | null>(null);
  /** Note whose full text is shown in the modal, or null. */
  let fullTextNote = $state<Note | null>(null);
  /** Note whose image(s) are shown enlarged in the lightbox, or null. */
  let lightboxNote = $state<Note | null>(null);

  /**
   * Primary note action: open this specific event on njump.me in a new tab.
   * `noopener,noreferrer` keeps the opened page from reaching back into this
   * one. A note whose id can't be encoded (shouldn't happen for real events)
   * falls back to opening its options menu so the click is never dead.
   */
  function openNote(note: Note): void {
    const url = njumpUrl(note.id);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else openMenu(note);
  }

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
    // Ignore keys that bubbled up from the inner ⋯ button (which has its own
    // activation), so pressing Enter there opens the menu without also opening
    // njump.
    if (e.currentTarget !== e.target) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openNote(note);
    }
  }

  /** Open the options menu from the card's ⋯ button without triggering njump. */
  function onMenuButton(e: MouseEvent, note: Note): void {
    e.stopPropagation();
    openMenu(note);
  }

  /**
   * Enlarge a note's image(s) in an in-app lightbox. The card click opens
   * njump.me, so tapping the thumbnail must stop the event from bubbling up to
   * the card — otherwise both would fire (njump would win by opening a new tab).
   */
  function openLightbox(e: MouseEvent, note: Note): void {
    e.stopPropagation();
    lightboxNote = note;
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

  // All previewable image URLs for a note (capped), used by the full-text
  // modal's gallery. The timeline cards reuse the per-placement `images` list.
  // See src/lib/nostr/images.ts.
  function imageUrls(n: Note): string[] {
    return getNoteImageUrls(n);
  }

  // Hide a broken note image so the card (or modal gallery slot) collapses
  // gracefully instead of showing a broken-image glyph.
  function onNoteImageError(e: Event): void {
    const img = e.currentTarget as HTMLImageElement;
    const wrap = img.closest('.note-image, .modal-image');
    if (wrap) wrap.remove();
    else img.remove();
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
  <!-- AI summary background: a large, faint SVG that Gemini Nano generated
       directly, behind the notes. Only present when the feature is on and a
       background was produced. aria-hidden + pointer-events:none keep it purely
       decorative. -->
  {#if timeline.aiBgEnabled && timeline.aiBgSvg}
    <!-- eslint-disable-next-line svelte/no-at-html-tags — aiBgSvg is model output
         that has passed the strict allowlist validator/sanitizer in
         src/lib/ai/sanitize.ts before reaching the store, so it is safe to inline. -->
    <div class="ai-bg" aria-hidden="true" bind:this={aiBgEl}>{@html timeline.aiBgSvg}</div>
  {/if}

  {#if placed.length === 0}
    <div class="empty">
      {#if timeline.status === 'connecting'}
        Connecting to relays…
      {:else if timeline.historyLoading}
        Loading history…
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
      class:has-image={p.images.length > 0}
      style="left: {(1 - p.f) * 100}%; top: {(p.lane / LANES) * 100}%;"
      role="button"
      tabindex="0"
      title="Open this note on njump.me (new tab) — use ⋯ for options"
      onclick={() => openNote(p.note)}
      onkeydown={(e) => onNoteKey(e, p.note)}
    >
      <!-- The card's LEFT edge is its exact time anchor; this rail sits flush to
           that left edge so variable-width cards still read right→newer. -->
      <span class="time-anchor" aria-hidden="true"></span>
      <button
        class="note-menu-btn"
        type="button"
        aria-label="Note options"
        title="Options (full text, mute TTS)"
        onclick={(e) => onMenuButton(e, p.note)}
      >⋯</button>
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
      <span class="content">{p.display}</span>
      {#if p.images.length > 0}
        <button
          class="note-image"
          type="button"
          aria-label="Enlarge image"
          title="Tap to enlarge"
          onclick={(e) => openLightbox(e, p.note)}
        >
          <img
            src={p.images[0]}
            alt="Note attachment"
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            onerror={onNoteImageError}
          />
          <span class="image-zoom-hint" aria-hidden="true">⤢</span>
          {#if p.images.length > 1}
            <span class="image-count" aria-label={`${p.images.length} images`}>+{p.images.length - 1}</span>
          {/if}
        </button>
      {/if}
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
        <div class="modal-body">{formatNoteContent(fullTextNote.content, fullTextNote.tags)}</div>
        {#if imageUrls(fullTextNote).length > 0}
          <div class="modal-gallery" class:multi={imageUrls(fullTextNote).length > 1}>
            {#each imageUrls(fullTextNote) as src (src)}
              <a class="modal-image" href={src} target="_blank" rel="noreferrer noopener">
                <img
                  {src}
                  alt="Note attachment"
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  onerror={onNoteImageError}
                />
              </a>
            {/each}
          </div>
        {/if}
        <button class="menu-item" type="button" onclick={() => (fullTextNote = null)}>Close</button>
      </div>
    </div>
  {/if}

  <!-- image lightbox: enlarges a note's image(s) in-app, near native size but
       always fitted to the viewport. Opened by tapping a card thumbnail. -->
  {#if lightboxNote}
    <div
      class="overlay lightbox"
      role="presentation"
      onclick={() => (lightboxNote = null)}
      onkeydown={(e) => onOverlayKey(e, () => (lightboxNote = null))}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="lightbox-inner" role="dialog" tabindex="-1" aria-modal="true" aria-label="Image viewer" onclick={(e) => e.stopPropagation()}>
        {#each imageUrls(lightboxNote) as src (src)}
          <img
            class="lightbox-img"
            {src}
            alt="Note attachment"
            decoding="async"
            referrerpolicy="no-referrer"
            onerror={onNoteImageError}
          />
        {/each}
      </div>
      <button class="lightbox-close" type="button" aria-label="Close image viewer" onclick={() => (lightboxNote = null)}>✕</button>
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

  /* AI summary background: fills the timeline, sits above the base bg but below
     every note (notes default to z-index auto/0, painted later in the DOM).
     Low opacity + pointer-events:none keep the notes fully readable/clickable. */
  .ai-bg {
    position: absolute;
    inset: 0;
    z-index: 0;
    opacity: 0.6;
    pointer-events: none;
    overflow: hidden;
    /* Ease summary swaps so the background doesn't pop when it updates. */
    transition: opacity 0.6s ease;
  }
  .ai-bg :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  @media (prefers-reduced-motion: reduce) {
    .ai-bg {
      transition: none;
    }
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
    /* Left-anchored at the note's time position: the card's left edge is its
       time anchor and content grows rightward toward the newer side. */
    width: max-content;
    max-width: min(340px, 60vw);
    max-height: calc((100% / 6) - 8px);
    margin-left: 4px;
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
    /* Never give up vertical space when the card is squeezed to its lane cap —
       only the image thumbnail shrinks (see .note-image). */
    flex: 0 0 auto;
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
    /* Text keeps its (already clamped) height; the image gives up space first. */
    flex: 0 0 auto;
  }

  /* Image cards are image-first: the thumbnail leads and the caption is a
     secondary line. Image-URL strings are already stripped from the text (see
     cardText()), so the caption is real prose or the neutral "Image post"
     fallback. Clamp it to a single, slightly smaller, dimmer line so the
     picture clearly dominates and the freed rows go to `.note-image`. */
  .note.has-image .content {
    -webkit-line-clamp: 1;
    line-clamp: 1;
    font-size: 13px;
    color: var(--text-dim);
    margin-bottom: 1px;
  }

  /* An image card is image-first and spans IMG_LANE_SPAN (2) lanes. This height
     MUST stay in lockstep with that JS span (see IMG_LANE_SPAN in the script):
     two lanes tall, minus the same 8px inter-lane gap a text card leaves. The
     lane placement reserves both lanes (so neighbours never overlap the picture)
     and never starts an image card below lane LANES-2, so this 2-lane height can
     never intrude into a lower lane or overflow the bottom edge. The picture
     still keeps a real, readable size while its footprint is fully accounted
     for by collision avoidance. */
  .note.has-image {
    max-height: calc((100% / 6) * 2 - 8px);
  }

  /* Inline image preview: a tap-to-enlarge thumbnail kept well within the card.
     It is the ONE flex child allowed to shrink (head-row and content are
     `flex: 0 0 auto`). The thumbnail box has a *preferred* height of
     `clamp(110px, 16vh, 200px)` — big enough to actually read on desktop, while
     the `16vh` term and the 110px floor keep it sensible on short/mobile
     viewports. The real ceiling, though, is the card's own
     `max-height: calc((100% / 6) - 8px)` lane cap (each of the 6 timeline lanes
     gets 1/6 of the height): `flex: 0 1 auto; min-height: 0` lets this box give
     up height when head + content + image would exceed that cap, so the
     thumbnail shrinks to fit instead of the card clipping the image's bottom
     edge (which read as a "top-crop"). On tall desktop screens the lane is big
     enough that the preferred height wins and the thumbnail is large; on short
     screens it gracefully shrinks. The img fills the box (`height: 100%`) with
     `object-fit: contain`, so the *whole* picture is always visible
     (letterboxed) at whatever height the box ends up — never cropped. `width`
     still tracks the image's intrinsic width (capped by the card's max-width),
     so image cards keep the same rendered width the lane reservation assumes.
     The faint backdrop makes the letterbox margin read as intentional. */
  .note-image {
    position: relative;
    display: block;
    width: 100%;
    height: clamp(110px, 16vh, 200px);
    flex: 0 1 auto;
    min-height: 0;
    margin-top: 2px;
    padding: 0;
    border: none;
    border-radius: 6px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.04);
    cursor: zoom-in;
  }
  .note-image:focus-visible {
    outline: 2px solid var(--accent-border);
    outline-offset: 1px;
  }

  /* Image-first cards get a taller preferred thumbnail to match their larger
     card cap. Still `flex: 0 1 auto; min-height: 0` (inherited), so it keeps
     shrinking before the card clips it — the whole-image `contain` behaviour is
     unchanged, it just starts from a bigger size. */
  .note.has-image .note-image {
    height: clamp(150px, 22vh, 260px);
  }

  .note-image img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /* A small "expand" affordance so it's obvious the thumbnail enlarges on tap
     (it's purely decorative — the whole thumbnail is the button). */
  .image-zoom-hint {
    position: absolute;
    left: 4px;
    bottom: 4px;
    padding: 0 5px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 11px;
    line-height: 1.5;
    pointer-events: none;
  }

  /* "+N" badge when a note carries more images than the single thumbnail shown.
     The full set is viewable in the options → full-text modal gallery. */
  .image-count {
    position: absolute;
    right: 4px;
    bottom: 4px;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
    pointer-events: none;
  }

  /* The card's left edge is its time anchor. A thin accent rail flush to that
     edge makes "left edge = this note's timestamp" legible. Cards still read
     right→newer, left→older — flow direction is unchanged; only the anchored
     edge moved. */
  .time-anchor {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 2px;
    width: 2px;
    border-radius: 1px;
    background: var(--accent);
    opacity: 0.4;
    pointer-events: none;
  }
  .note.head .time-anchor,
  .note.speaking .time-anchor {
    opacity: 0.7;
  }

  /* Compact ⋯ affordance: opens the note's options (full text, mute TTS) that
     the card click used to open, now that the click opens njump.me instead. */
  .note-menu-btn {
    position: absolute;
    top: 2px;
    right: 6px;
    z-index: 2;
    appearance: none;
    width: 20px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.35);
    color: var(--text-h);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.6;
  }
  .note-menu-btn:hover,
  .note-menu-btn:focus-visible {
    background: var(--accent-bg);
    color: var(--accent);
    opacity: 1;
    outline: none;
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
    width: min(820px, 94%);
    max-height: 88%;
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

  /* Full-text modal gallery: all of a note's images. A single image is shown as
     large as practical — up to its native size — while still fitting inside the
     modal width and the viewport height (giant images downscale, small ones are
     not blown up). Multiple images lay out in a responsive grid, each whole and
     uncropped. Each links out to the original in a new tab. */
  .modal-gallery {
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px;
    margin: 4px 0;
  }
  .modal-gallery.multi {
    grid-template-columns: repeat(2, 1fr);
  }

  .modal-image {
    display: block;
    border-radius: 8px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.04);
    text-align: center;
  }

  .modal-image img {
    display: block;
    width: auto;
    max-width: 100%;
    height: auto;
    max-height: 78vh;
    margin: 0 auto;
    object-fit: contain;
  }
  /* In the grid, each cell takes its column width; the image fills that width
     and stays whole (contain, not cover), capped to a slice of the viewport so
     several images stay scannable without scrolling forever. */
  .modal-gallery.multi .modal-image img {
    width: 100%;
    max-height: 42vh;
    object-fit: contain;
  }

  /* ---- image lightbox ---- */
  /* Sits above the menu/full-text overlays (z 20). Shows a note's image(s) at
     (up to) native size, but always fitted to the viewport: `width/height: auto`
     keeps small images from being blown up, while the `max-width`/`max-height`
     caps force giant images to downscale so they never overflow the screen.
     Multiple images stack and the inner box scrolls. */
  .lightbox {
    z-index: 30;
    flex-direction: column;
    background: rgba(0, 0, 0, 0.85);
  }

  .lightbox-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    max-width: 100%;
    max-height: 100%;
    overflow: auto;
  }

  .lightbox-img {
    display: block;
    width: auto;
    height: auto;
    max-width: min(96vw, 100%);
    max-height: 86vh;
    object-fit: contain;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.04);
  }

  .lightbox-close {
    position: absolute;
    top: 10px;
    right: 12px;
    appearance: none;
    width: 34px;
    height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
  .lightbox-close:hover,
  .lightbox-close:focus-visible {
    background: var(--accent-bg);
    color: var(--accent);
    outline: none;
  }
</style>
