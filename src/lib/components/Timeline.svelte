<script lang="ts">
  import { timeline } from '../timeline/store.svelte';
  import { shortNpub } from '../timeline/format';
  import { getNoteImageUrls } from '../nostr/images';
  import { formatNoteContent } from '../nostr/mentions';
  import { njumpUrl } from '../nostr/njump';
  import { packTimeline, GAP, type LayoutInput, type PlacedItem } from '../timeline/layout';
  import type { ProfileMeta } from '../nostr/profiles';
  import type { Note } from '../nostr/types';

  // Card sizes used to be approximated with a 1D busy-interval reservation over
  // 6 fixed lanes; that could not represent real 2D rectangle collisions, so
  // cards overlapped/overflowed once the estimate drifted from the measured box
  // (PLAN.md §1.2). Vertical placement now lives in the pure, deterministic 2D
  // packer (src/lib/timeline/layout.ts), fed by per-note MEASURED sizes (with a
  // deterministic estimate only as the pre-measurement seed). The constants
  // below are now used solely to ESTIMATE a card's initial width/height before
  // the real getBoundingClientRect() measurement overrides them.
  const MAX_NOTE_PX = 340; // .note max-width cap (px)
  const MIN_NOTE_PX = 120; // floor so tiny notes still reserve breathing room
  const IMG_NOTE_PX = 240; // floor for image-bearing notes — wider than text so
  // the image reads as a photo (landscape-ish) rather than a narrow column, and
  // so its horizontal estimate is distinct from a text card's.
  const NOTE_VW_FRACTION = 0.6; // .note max-width: ...60vw
  const PAD_X = 10; // .note horizontal padding (px), both sides
  const AVATAR_PX = 18; // .avatar width
  const HEAD_GAP_PX = 6; // .head-row gap (avatar → author)
  const CONTENT_FONT = 14; // .note .content font-size
  const AUTHOR_FONT = 12; // .note .author font-size
  // Vertical estimate helpers (px), used ONLY to seed the packer before a card
  // is measured. The measurement (and image onload) overrides these (C7).
  const HEAD_ROW_PX = 22; // avatar/author head row height
  const CONTENT_LINE_PX = 20; // ~one clamped content line at 14px / 1.4
  const NOTE_V_PAD = 12; // .note vertical padding (top+bottom)
  const IMG_EST_PX = 220; // estimated thumbnail height for an image card seed

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

  /** Measured timeline width (px); maps a note's time to its left edge. */
  let containerW = $state(0);
  /** Measured timeline height (px) = H, the packer's vertical bound (C2). */
  let containerH = $state(0);

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
    /** Chosen top in px (from the 2D packer; stable for the note's lifetime). */
    y: number;
    /** Card height in px (measured-or-estimated; drives the inline height). */
    height: number;
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
    /** When this card is an author-stack FRONT, the notes stacked behind it
     *  (deterministic (created_at, id) order); empty for a plain card. */
    stacked: Note[];
    /** Total cards represented by this footprint (behind count + 1). 1 = plain. */
    count: number;
    /** Deterministic rotation order for an author stack: the footprint owner
     *  followed by its stacked notes, in the same (created_at, id) order the
     *  packer used. Length === count. The visible front cycles through this list
     *  (see frontNote), so every folded note surfaces in turn; for a plain card
     *  it is just [note]. */
    order: Note[];
  }

  // --- Measurement cache (C7: estimate → measure → re-pack on y only) ---------
  // Per-note MEASURED {w,h} in px, recorded after render via getBoundingClientRect
  // (text cards) and image onload (image cards settle taller). Keyed by note id.
  // The packer reads these so vertical placement is driven by real rectangles,
  // not a text heuristic. Reset on feed rebuild (feedVersion) below.
  let measured = $state<Map<string, { w: number; h: number }>>(new Map());
  // Bound front-card elements, keyed by note id, used to read their real box.
  const cardEls = new Map<string, HTMLElement>();
  // Identity-keyed y cache owned by the packer (C4: a note keeps its y for life).
  // Cleared together with the measurement cache on feed rebuild.
  const yCache = new Map<string, number>();
  let layoutFeedVersion = -1;

  // Effective CSS max note width for the current container (min(340px, 60vw)).
  // Before the container is measured fall back to the px cap.
  const maxNotePx = $derived(containerW > 0 ? Math.min(MAX_NOTE_PX, containerW * NOTE_VW_FRACTION) : MAX_NOTE_PX);

  // Per-note derived metadata (images + display text), computed once and reused
  // by both the size estimate and the rendered card (the template never
  // re-scans the note). Keyed in render order.
  const noteMeta = $derived.by(() => {
    const m = new Map<string, { images: string[]; display: string }>();
    for (const note of timeline.visibleNotes) {
      const images = getNoteImageUrls(note);
      const display = cardText(formatNoteContent(note.content, note.tags), images);
      m.set(note.id, { images, display });
    }
    return m;
  });

  /**
   * Estimated card height (px) before real measurement — head row + clamped
   * content lines for text; a taller estimate (caption line + thumbnail) for an
   * image card. Deterministic; only a C7 seed, overridden by measurement.
   */
  function estHeightPx(display: string, hasImage: boolean): number {
    if (hasImage) return HEAD_ROW_PX + CONTENT_LINE_PX + IMG_EST_PX + NOTE_V_PAD;
    // Plain text wraps and clamps to 3 lines: 1..3 lines from a width-aware guess.
    const innerMax = Math.max(MIN_NOTE_PX - PAD_X * 2, maxNotePx - PAD_X * 2);
    const lineW = estTextPx(display, CONTENT_FONT);
    const lines = Math.max(1, Math.min(3, Math.ceil(lineW / Math.max(1, innerMax))));
    return HEAD_ROW_PX + lines * CONTENT_LINE_PX + NOTE_V_PAD;
  }

  // Build the packer input from the time-ordered visible notes. visibleNotes is
  // ascending by (created_at, id) and never newer than the playhead, so x0 (the
  // left edge from time) is always within [0, W]. Width/height come from the
  // measurement cache when present, otherwise from the deterministic estimate.
  // Keyed (re-derives) on visibleNotes, measurements, container size, and
  // playhead/window so x0 tracks time — but the packer only ever moves y, and a
  // note's y is frozen via yCache, so horizontal motion never shifts rows.
  const layoutInputs = $derived.by<LayoutInput[]>(() => {
    const playhead = timeline.playheadMs;
    const win = timeline.windowMs;
    const W = containerW;
    const meta = noteMeta;
    const ms2 = measured; // track the measurement map as a dependency
    const out: LayoutInput[] = [];
    for (const note of timeline.visibleNotes) {
      const ms = note.created_at * 1000;
      const f = (playhead - ms) / win; // 0..1 from right edge
      const x0 = (1 - f) * W; // left edge in px (C5: time-only)
      const nm = meta.get(note.id);
      const hasImage = (nm?.images.length ?? 0) > 0;
      const display = nm?.display ?? '';
      const real = ms2.get(note.id);
      const width = real?.w ?? estNotePx(name(note), display, maxNotePx, hasImage);
      const height = real?.h ?? estHeightPx(display, hasImage);
      out.push({ id: note.id, author: note.pubkey, x0, width, height });
    }
    return out;
  });

  // Run the pure 2D packer. Re-packs whenever layoutInputs changes (visible set,
  // measurements, container size, time). yCache freezes each note's y for its
  // lifetime (C4); the packer only ever assigns/keeps y, never x (C5).
  // Drop the y-cache, bound elements, and measurements when the feed was torn
  // down and rebuilt. This runs in an $effect (not inside the packer derived) so
  // we never reassign state during derivation, which Svelte rejects with
  // state_unsafe_mutation. Clearing `measured` here produces a new ref, which
  // re-derives layoutInputs and re-runs the packer against the cleared yCache —
  // the same fresh re-pack the inline reset used to perform, just safely.
  $effect(() => {
    if (timeline.feedVersion === layoutFeedVersion) return;
    layoutFeedVersion = timeline.feedVersion;
    yCache.clear();
    cardEls.clear();
    measured = new Map();
  });

  const packed = $derived.by<PlacedItem[]>(() => {
    const H = containerH > 0 ? containerH : 600; // sane fallback pre-measure
    return packTimeline(layoutInputs, H, yCache);
  });

  // Final render list: join the packer's footprint-owning items back to their
  // notes and stack members, and attach head/speaking/muted/display state.
  const placed = $derived.by<Placed[]>(() => {
    const byId = new Map<string, Note>();
    for (const note of timeline.visibleNotes) byId.set(note.id, note);
    const headId = timeline.headNote?.id ?? null;
    const speakingId = timeline.speakingId;
    const muted = timeline.mutedPubkeys;
    const meta = noteMeta;
    const out: Placed[] = [];
    for (const item of packed) {
      const note = byId.get(item.id);
      if (!note) continue;
      const nm = meta.get(note.id);
      const stacked = (item.stackedIds ?? [])
        .map((id) => byId.get(id))
        .filter((n): n is Note => n !== undefined);
      out.push({
        note,
        y: item.y,
        height: item.height,
        isHead: note.id === headId,
        isSpeaking: note.id === speakingId,
        isMuted: muted.has(note.pubkey),
        images: nm?.images ?? [],
        display: nm?.display ?? '',
        stacked,
        count: item.count ?? 1,
        order: [note, ...stacked],
      });
    }
    return out;
  });

  // Per-frame horizontal position: a note's LEFT edge sits at (1 - f) * 100%.
  // Recomputed cheaply every frame from the playhead (vertical y stays frozen).
  function leftPct(note: Note): number {
    const ms = note.created_at * 1000;
    const f = (timeline.playheadMs - ms) / timeline.windowMs;
    return (1 - f) * 100;
  }

  // ---- author-stack rotation ----
  // How long (ms of playback time) each stacked note stays in front before the
  // next one rotates up. "A few seconds" — noticeable but not frantic.
  const ROTATE_MS = 4000;

  /**
   * The note currently shown in FRONT of an author stack. The index is derived
   * purely from the playback clock (timeline.playheadMs / ROTATE_MS), so it is:
   *  - deterministic — same playhead ⇒ same front, never Date.now()/random;
   *  - self-advancing — playheadMs moves during playback and LIVE, so the front
   *    rotates through every folded note in `order` on its own;
   *  - auto-pausing — pausing stops the playhead (LIVE→pinned, or isPlaying off),
   *    so the index freezes and rotation naturally stops while paused.
   * A plain card (count === 1) always returns its sole note unchanged.
   */
  function frontNote(p: Placed): Note {
    if (p.count <= 1) return p.note;
    const idx = Math.floor(timeline.playheadMs / ROTATE_MS) % p.order.length;
    return p.order[idx];
  }

  // Register/unregister a card element for measurement. The action re-measures
  // after the node mounts; the $effect below re-measures the whole visible set
  // whenever it (or its content) changes.
  // `on` is false for an author-stack FRONT: that card's box renders rotating
  // stacked content, so we must NOT feed it back into the owner's measurement —
  // doing so would churn the footprint every rotation and could reflow (and thus
  // overlap) neighbours. With on:false the owner's last measured/estimated size
  // stays frozen, keeping the reserved footprint stable (C4). A note flipping
  // between plain and stacked toggles `on` via update(), re-/de-registering it.
  function measure(
    el: HTMLElement,
    param: { id: string; on: boolean },
  ): { update: (p: { id: string; on: boolean }) => void; destroy: () => void } {
    let cur = param;
    if (cur.on) cardEls.set(cur.id, el);
    return {
      update(next) {
        if (cur.on) cardEls.delete(cur.id);
        cur = next;
        if (cur.on) cardEls.set(cur.id, el);
      },
      destroy() {
        if (cur.on) cardEls.delete(cur.id);
      },
    };
  }

  /**
   * Record a card's real rendered size into the measurement cache, then trigger
   * a deterministic re-pack (C7). Only writes when the size actually changed (to
   * a 1px tolerance) so this never loops: a stable measurement is idempotent.
   */
  function recordSize(id: string, w: number, h: number): void {
    const prev = measured.get(id);
    if (prev && Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1) return;
    const next = new Map(measured);
    next.set(id, { w, h });
    measured = next; // new ref → layoutInputs re-derives → packer re-runs (y only)
  }

  // Measure every visible card after it renders. Reading placed makes this rerun
  // whenever the visible set / layout changes; reading measured.size lets a
  // settled image (which grows the box on onload) be picked up on the next pass.
  // We measure the card's content box ignoring the JS-driven inline height so
  // the packer learns the card's NATURAL size, then sizes the footprint to it.
  $effect(() => {
    void placed; // dependency: re-measure when the rendered set changes
    void measured.size;
    for (const [id, el] of cardEls) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) recordSize(id, rect.width, rect.height);
    }
  });

  // When a card image finishes loading it changes the card's natural height;
  // re-measure that card so the packer re-flows around the real picture (C7).
  function onImageLoad(id: string): void {
    const el = cardEls.get(id);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) recordSize(id, rect.width, rect.height);
  }

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
  bind:clientHeight={containerH}
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
    <!-- The slot's LEFT edge is the FOOTPRINT OWNER's time anchor (left = (1 - f),
         C5) and its TOP comes from the pure 2D packer (stable for the note's
         lifetime, C4) — both stay pinned to p.note so the layout never shifts.
         For an author stack the card CONTENT rotates: `front` is whichever folded
         note is currently up (deterministic, playhead-driven; see frontNote), and
         every badge/avatar/content/image/interaction below is read off `front`,
         not the owner. The owner's frozen footprint is reused regardless of which
         note is shown, and the card is capped to it (CSS .is-stack .note +
         max-height) so a taller stacked note can never grow the box and overlap a
         neighbour (C1/C2). The behind decorative cards never grow the footprint. -->
    {@const front = frontNote(p)}
    {@const fm = noteMeta.get(front.id)}
    {@const fImages = fm?.images ?? p.images}
    {@const fDisplay = fm?.display ?? p.display}
    {@const isHead = front.id === (timeline.headNote?.id ?? null)}
    {@const isSpeaking = front.id === timeline.speakingId}
    {@const isMuted = timeline.mutedPubkeys.has(front.pubkey)}
    <div
      class="note-slot"
      class:is-stack={p.count > 1}
      style="left: {leftPct(p.note)}%; top: {p.y}px;"
    >
      {#if p.count > 1}
        <!-- Thin offset cards behind the front, hinting "more from this author"
             without enlarging the footprint. Purely decorative. -->
        <span class="stack-card stack-2" aria-hidden="true"></span>
        <span class="stack-card stack-1" aria-hidden="true"></span>
        <span class="stack-count" aria-label={`${p.count} notes from this author`}>×{p.count}</span>
      {/if}
      <!-- Keyed on the front note's id: for a plain card the key is constant so
           the element never remounts; for a stack the key changes on each
           rotation, replaying the subtle entry animation as the next note rises. -->
      {#key front.id}
        <div
          class="note"
          class:head={isHead}
          class:speaking={isSpeaking}
          class:muted={isMuted}
          class:has-image={fImages.length > 0}
          class:rotate-in={p.count > 1}
          style={p.count > 1 ? `max-height: ${p.height}px;` : ''}
          use:measure={{ id: p.note.id, on: p.count === 1 }}
          role="button"
          tabindex="0"
          title="Open this note on njump.me (new tab) — use ⋯ for options"
          onclick={() => openNote(front)}
          onkeydown={(e) => onNoteKey(e, front)}
        >
          <!-- The card's LEFT edge is its exact time anchor; this rail sits flush to
               that left edge so variable-width cards still read right→newer. -->
          <span class="time-anchor" aria-hidden="true"></span>
          <button
            class="note-menu-btn"
            type="button"
            aria-label="Note options"
            title="Options (full text, mute TTS)"
            onclick={(e) => onMenuButton(e, front)}
          >⋯</button>
          <div class="head-row">
            {#if isSpeaking}
              <span class="speaking-badge" title="Reading aloud" aria-label="Reading aloud">🔊</span>
            {/if}
            {#if isMuted}
              <span class="muted-badge" title="TTS muted for this author" aria-label="TTS muted">🔇</span>
            {/if}
            <span class="avatar" aria-hidden="true">
              <span class="avatar-fallback">{initial(front)}</span>
              {#if meta(front)?.picture}
                <img
                  class="avatar-img"
                  src={meta(front)?.picture}
                  alt=""
                  loading="lazy"
                  referrerpolicy="no-referrer"
                  onerror={onAvatarError}
                />
              {/if}
            </span>
            <span class="author">{name(front)}</span>
          </div>
          <span class="content">{fDisplay}</span>
          {#if fImages.length > 0}
            <button
              class="note-image"
              type="button"
              aria-label="Enlarge image"
              title="Tap to enlarge"
              onclick={(e) => openLightbox(e, front)}
            >
              <img
                src={fImages[0]}
                alt="Note attachment"
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
                onload={() => p.count === 1 && onImageLoad(front.id)}
                onerror={onNoteImageError}
              />
              <span class="image-zoom-hint" aria-hidden="true">⤢</span>
              {#if fImages.length > 1}
                <span class="image-count" aria-label={`${fImages.length} images`}>+{fImages.length - 1}</span>
              {/if}
            </button>
          {/if}
        </div>
      {/key}
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

  /* Positioned wrapper: carries the card's time-anchored LEFT edge and the
     packer's chosen TOP (px). The inner .note flows naturally inside it, so the
     card's height is content-driven and matches the footprint the 2D packer
     reserved for it — there is no fixed-lane CSS height coupling any more. */
  .note-slot {
    position: absolute;
    margin-left: 4px;
  }
  /* Contain the behind-stack cards' negative z-index within the slot so they
     layer behind the front card but never sink below the timeline background. */
  .note-slot.is-stack {
    isolation: isolate;
  }

  .note {
    position: relative;
    /* Left-anchored at the note's time position: the card's left edge is its
       time anchor and content grows rightward toward the newer side. Vertical
       size is content-driven (JS packer reserves exactly this height). */
    width: max-content;
    max-width: min(340px, 60vw);
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

  /* Inline image preview: a tap-to-enlarge thumbnail. Its height is a stable,
     deterministic clamp (no longer tied to a fixed lane fraction): big enough to
     read on desktop, sensible on short/mobile viewports. Because the card height
     is now content-driven and the 2D packer reserves exactly the card's measured
     box, this thumbnail height simply contributes to that measured height — no
     manual lane-span coupling is needed, and re-measuring on image onload lets
     the packer settle around the picture (C7). The img fills the box with
     `object-fit: contain`, so the WHOLE picture is always visible (letterboxed),
     never cropped; the faint backdrop makes the letterbox margin intentional. */
  .note-image {
    position: relative;
    display: block;
    width: 100%;
    height: clamp(140px, 22vh, 260px);
    flex: 0 0 auto;
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

  .note-image img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /* ---- author stack (crowding fallback, PLAN.md §4.3.1) ----
     When the packer cannot fit a same-author near note individually without
     overlapping or overflowing, it folds it BEHIND a front card (the stack keeps
     the front's single footprint). We render thin offset cards behind the front
     to hint "more from this author", plus a ×N count badge. These behind cards
     are purely decorative (the front keeps the full interactive card) and never
     enlarge the footprint, so C2 stays satisfied automatically. */
  .stack-card {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    border-radius: 8px;
    background: rgba(28, 31, 41, 0.7);
    border: 1px solid var(--border);
    pointer-events: none;
  }
  .stack-card.stack-1 {
    transform: translate(4px, 4px);
    z-index: -1;
    opacity: 0.85;
  }
  .stack-card.stack-2 {
    transform: translate(8px, 8px);
    z-index: -2;
    opacity: 0.6;
  }
  .stack-count {
    position: absolute;
    top: -8px;
    left: -8px;
    z-index: 3;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--bg);
    font-size: 11px;
    font-weight: 700;
    line-height: 1.5;
    pointer-events: none;
  }

  /* A stack front is capped to the packer's reserved footprint (inline
     max-height = p.height) with border-box sizing, and clipped (.note already
     sets overflow:hidden). Rotating a taller-or-shorter stacked note through the
     front therefore can never grow the box past what the packer reserved, so the
     no-overlap / no-overflow invariants (C1/C2) hold for whichever note is up. */
  .note-slot.is-stack .note {
    box-sizing: border-box;
  }

  /* Subtle entry as the front swaps to the next stacked note: a brief fade plus a
     slight rise/settle — noticeable but quiet. The keyed remount (per front id)
     replays it on each rotation. Disabled under reduced-motion. */
  @keyframes stackRotateIn {
    from {
      opacity: 0.4;
      transform: translateY(4px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  .note-slot.is-stack .note.rotate-in {
    animation: stackRotateIn 0.32s ease-out;
  }
  @media (prefers-reduced-motion: reduce) {
    .note-slot.is-stack .note.rotate-in {
      animation: none;
    }
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
