# nosplay

A time-scrubbable [Nostr](https://nostr.com) timeline. Notes flow across a
full-screen axis whose **right edge is the current moment** and whose left edge
is `now − window`. You can pause, rewind, fast-forward, and seek through the
recent past like a media player — hence *nos·play*.

Everything is real: notes are fetched live from public Nostr relays. There are
no sample or fake posts.

This project was built to fulfill the [requirements document (要件書)](https://github.com/TsukemonoGit/nosplay/blob/main/docs/%E8%A6%81%E4%BB%B6%E6%9B%B8.md).

## Features

- **Live timeline** — kind:1 notes laid out by time across the full screen,
  newest at the right edge (the playhead = current time). Each note shows the
  author's avatar and display name (resolved from kind:0 metadata, with an
  npub fallback), and long posts wrap and clamp instead of being truncated.
  Legacy NIP-08 positional mentions (a `#[i]` token pointing at an `e`/`p` tag)
  are rewritten to a compact `[mention: note1…]` / `[mention: npub1…]` label —
  both in the card and the full-text modal — instead of showing a raw `#[0]`.
  Each note keeps a stable vertical lane for its lifetime (assigned once, keyed
  to its identity/author), so notes scroll horizontally without bouncing up and
  down as the visible window slides. A card's **left edge is its exact time
  anchor**, marked with a thin accent rail, so even though cards have different
  widths (short vs. long text, with/without an image) the timeline always reads
  right → newer, left → older. Notes posted in the same second are ordered
  deterministically by event id, so the horizontal layout is stable run-to-run.
- **Open on njump** — **clicking (or pressing Enter/Space on) a note opens that
  specific event on [njump.me](https://njump.me) in a new tab** (`https://njump.me/<note1…>`,
  with the `note1` id encoded via NIP-19). The per-note options that the click
  used to open now live behind a small **⋯** button on each card: **Show full
  post text** opens the untruncated content (and any images) in a modal, and
  **Mute / Unmute TTS for this author** permanently silences (or restores)
  read-aloud for that note's author (pubkey). Muting takes effect immediately:
  it drops any of that author's notes already queued for speech and cuts off
  their note if it is being read at that moment. Muted authors are dimmed with a
  🔇 badge and still appear in the timeline; the mute list persists across
  reloads (see *Persistence*) and can be undone from the same menu.
- **Image previews** — notes that carry images show an inline thumbnail on the
  card, sourced (in priority order) from NIP-92 `imeta` tags, NIP-94-style `url`
  tags (accepted when a sibling `m`/`mime` tag declares `image/*`), and direct
  image links in the post text. Only `http(s)` URLs are ever used as an
  `<img src>`. When a note has **multiple** images the card shows the first with
  a **+N** badge, and the full set is viewable as a grid in the **⋯ → Show full
  post text** modal (each image links out to the original in a new tab). Broken
  or unreachable images fail gracefully — the thumbnail (or gallery slot) is
  removed instead of showing a broken-image glyph — and image cards reserve a
  little extra horizontal room so they don't overlap their neighbours.
- **Playback controls** — play/pause, −1m / +1m nudge, speed selector
  (1×–50×), a seek slider, and a **LIVE** button that re-follows wall-clock now.
  Catching up to wall-clock now while fast-forwarding automatically snaps back to
  LIVE. (At very high speeds notes stream past quickly and read-aloud can't keep
  up with every note; TTS keeps only the most recent backlog so it never jams.)
- **Time navigation** — window-size selector (1 min – 1 hour) and a
  `datetime-local` **Jump to** field: pick any past moment, then press **Jump**
  to seek to it. If the chosen time predates the loaded history (e.g. a date last
  year), nosplay fetches the notes needed to reach it — a single bounded query
  for the slice around that moment's visible window (`since`/`until` bracketing
  `[target − window, target]`), so it lands directly on the chosen time instead
  of paging down from the live tail; if that window turns out to be empty or
  sparse for these authors, nosplay fetches the nearest older notes and then
  settles the playhead onto the closest note at/behind the target — so the jump
  lands on visible notes (the nearest one sits at the window's right edge)
  instead of freezing on a blank window. As you then play forward from a deep
  jump, nosplay keeps backfilling the history just ahead of the playhead one
  window-sized chunk at a time, so consuming the initial slice no longer leaves
  the window empty (**Waiting for notes…**) — playback stays filled all the way
  to the live edge, where the live subscription takes over. The button shows
  **Loading…** while it fetches. Editing the field never moves the playhead on its
  own — the seek happens only on confirm — and jumping to a past moment pauses
  playback there rather than auto-playing on. (The seek slider and ±1m nudge still
  move only within the currently loaded range.)
- **Shareable range links** — a **🔗 Share** button copies a link to the view
  you are looking at. Opening that link reproduces the same time range (see
  [Share links](#share-links)).
- **Text-to-speech** — optional read-aloud of new notes via the browser's
  Web Speech API. A **Voice** selector next to the TTS toggle lets you pick any
  voice the browser offers; the list populates asynchronously (via
  `voiceschanged`) so it fills in even when voices load late. The default
  **Auto (Japanese)** option keeps the original behavior: a Japanese voice is
  selected when the browser offers one (and the utterance language defaults to
  `ja-JP`) so CJK text is read naturally rather than spelled out by a default
  English voice. English-looking notes are automatically read with an English
  voice instead (auto-picked from the browser, falling back to `en-US` if none
  is available), while the Voice selection stays the Japanese baseline used for
  non-English text. Your choice is stored by its stable `voiceURI`, persists across
  reloads, and falls back to Auto if that voice is no longer available. URLs and
  Nostr identifiers (npub/note/etc.) are stripped or replaced before speaking so
  they aren't read aloud. The note currently being read aloud is highlighted in
  the timeline (a pulsing outline plus a 🔊 badge) so you can see which post is
  speaking. Live arrivals are spoken through an app-level FIFO queue, one note
  at a time, so a burst of incoming notes is read sequentially instead of only
  the latest one — and a note that sanitizes to nothing never blocks the notes
  behind it. Only notes that arrive **after** the live subscription starts are
  spoken live: reconnecting or reloading never replays the loaded history.
  When you rewind or seek into the past and **play through it**, TTS follows the
  moving playhead instead — each note is read as it becomes the current one under
  the playhead, through the same queue. A paused session stays silent until it is
  playing (or LIVE); manually seeking/nudging or hitting **LIVE** resets the
  speech state so a jump never replays a stale note or talks over a fresh one.
- **AI summary background** — an optional **✨ AI BG** toggle that, when on, has
  **Chrome's built-in AI Prompt API (`LanguageModel`, Gemini Nano, on-device)**
  generate the background **SVG markup directly** from the currently visible
  timeline, and renders it as a large, faint, low-opacity abstract layer behind
  the notes. The model output is **strictly validated/sanitized** (a tight
  element/attribute allowlist; no script, event handlers, `<foreignObject>`,
  `<image>`/`<use>`, `<style>`, or external/`data:` references) before it is ever
  put in the DOM. The system and user prompts are now simple defaults and are
  **user-editable** (from the AI debug panel; the user prompt's `{summary}`
  placeholder is replaced with the feed text), while the output stays strictly
  validated with no fallback. There is **no fallback**: if the Prompt API is
  unsupported, the model is unavailable, generation fails, or the markup fails
  validation, **no background is drawn** and the status line + debug panel say
  exactly why. The
  on-device **Summarizer API** is still used (when available) only to condense
  the feed text fed to the SVG prompt. Everything runs locally — no text leaves
  your device, and there are **no mock/fake AI responses**. It updates on a ~30s
  heartbeat and on meaningful context change, throttled so it never spams the
  model. See [AI summary background](#ai-summary-background).
- **Explicit NIP-07 login** — an account bar shows the login state (logged
  out / logging in / logged in / login error), the obtained pubkey (as a short
  npub), and **Connect / Reconnect / Refresh follows / Log out** controls. Login
  is explicit: nothing prompts your signer until you click *Connect* (a previous
  session can opt into silent auto re-login — see *Persistence*).
- **Posting** — compose and publish a note through a [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md)
  browser extension (e.g. Alby, nos2x). The composer's *post-@* selector
  (current / playhead) only labels intent; posts always publish at the real
  current time.
- **Relay settings** — inspect and edit the read relays the timeline fetches
  from, and choose how your manual list combines with the follow-derived one
  (see [Relays](#relays)).
- **Persistence** — window size, speed, TTS toggle, the selected TTS voice, the
  per-author TTS mute list, the **AI background** toggle, a paused playhead
  position, your relay settings (mode + manual list), and a "remember login"
  hint are saved to IndexedDB and restored on reload. Muting or un-muting an
  author is written immediately (not debounced), so the change survives a reload
  that happens right after. Once you have logged in at least
  once, the next session silently re-attempts NIP-07 login (most signers
  remember the granted permission, so this does not re-prompt); *Log out* clears
  the hint.

## Modes

- **follows** — after you log in with a NIP-07 signer, nosplay resolves your
  **NIP-02 contact list (kind:3)** and **NIP-65 relay list (kind:10002)** and
  builds the timeline from the accounts you follow, read from your declared read
  relays. The account bar explains exactly what was resolved ("Following N
  accounts · timeline = people you follow").
- **limited** — with no signer, before you log in, or when your account has no
  contact list, it streams a small set of well-known public accounts plus a
  recent global feed so the timeline stays lively. The account bar says why
  ("No contact list (kind:3) found — showing the limited feed instead").

The mode, connection status, and right-edge time are shown in the top-right
status line; the login state and pubkey are shown in the account bar below it.

## Follow timeline (after login)

When you click **Connect (NIP-07)**:

1. nosplay calls `window.nostr.getPublicKey()` and shows the resulting pubkey.
2. It fetches the newest **kind:10002** (NIP-65) event to learn your **read
   relays**, and the newest **kind:3** (NIP-02) event to learn the **pubkeys you
   follow**.
3. If a contact list is found, the timeline switches to **follows** mode and
   subscribes to `kind:1` notes from those authors on the resolved read relays.
   If not, it stays in **limited** mode and tells you so.

**Refresh follows** re-runs steps 2–3 (e.g. after you follow new accounts).
**Reconnect** tears down and rebuilds the current feed with the current relay
settings without re-resolving follows.

## Share links

Click **🔗 Share** to copy a link to the current view. The link captures the
visible range as two concise query params:

| Param   | Meaning                                   | Units               |
| ------- | ----------------------------------------- | ------------------- |
| `start` | Left edge of the window (`end − window`)  | epoch **seconds**   |
| `end`   | Right edge / playhead                     | epoch **seconds**   |

For example `…/?start=1718000000&end=1718000300` opens a 5-minute window ending
at `end`. Opening a link:

- seeks the playhead to `end` and sets the window to `end − start`, so the exact
  shared range is shown;
- pauses (the link is a **fixed** range — sharing while LIVE captures the moment
  you clicked, not a moving "now"); if `end` is at or beyond the current time it
  snaps back to **LIVE** instead;
- **overrides** persisted playback for that load. If the shared moment predates
  the loaded history, nosplay fetches the notes needed to reach it (the same
  direct target-range query as a **Jump**) before settling the playhead there;
  and if that shared range is empty or sparse, the playhead is nudged onto the
  nearest note at/behind it so the restored view shows real notes rather than a
  blank window. Pressing play from a deep shared moment backfills the history
  ahead of the playhead chunk-by-chunk, just like a deep Jump, so playback runs
  smoothly up to the live edge without the window ever emptying.

When neither param is present the app behaves exactly as before (restoring your
persisted playback / starting live). `start` alone is treated as a bare jump
target; `end` alone seeks there keeping your current window.

## AI summary background

Toggle **✨ AI BG** (next to the TTS controls) to turn on an ambient,
AI-generated background. The background is produced by **Gemini Nano generating
the SVG markup directly** — there is **no fallback**. When enabled, nosplay:

1. collects a trimmed slice of the **currently visible** notes' text (the most
   recent ~40 notes / ~4000 chars within the window);
2. (optionally) condenses that text with **Chrome's built-in AI Summarizer API**
   (on-device Gemini Nano, `type: 'key-points'`, `length: 'short'`,
   `format: 'plain-text'`) when it's available, purely to give the SVG prompt a
   tighter input. If the Summarizer isn't available, the trimmed feed text is
   sent to the generator as-is;
3. asks **Chrome's built-in AI Prompt API** (`LanguageModel`, Gemini Nano,
   `src/lib/ai/prompt.ts`) to **generate the background SVG markup directly** —
   a single abstract `<svg>` matching the feed's mood. The model emits
   the actual SVG; nosplay does **not** assemble it from a template or a
   structured scene. The system and user prompts are now **simple defaults that
   you can edit** — both are exposed as live, editable fields in the AI debug
   panel (and in the `svg-smoke.html` test), with the user prompt's `{summary}`
   placeholder filled in with the feed text; the output is still strictly
   validated/sanitized with no fallback. A pure **model-formatting miss** (empty
   output, no `<svg>` at all, or prose/code fences around the markup) is
   re-prompted up to 3 times total — classified straight from the validator's
   result — while a genuine validation failure (disallowed/unsafe content) stops
   at once; the validator is never weakened and there is still no fallback;
4. **strictly validates and sanitizes** that markup (`src/lib/ai/sanitize.ts`)
   before it touches the DOM. The validator parses the SVG and enforces a tight
   allowlist:
   - **allowed elements only**: `svg`, `g`, `defs`, `title`, `desc`, `rect`,
     `circle`, `ellipse`, `line`, `polyline`, `polygon`, `path`,
     `linearGradient`, `radialGradient`, `stop`, `text`, `tspan`;
   - **rejected outright**: `<script>`, `<style>`, `<foreignObject>`, `<image>`,
     `<use>`, `<textPath>`, animation/filter elements, any `on*` event handler,
     any `href`/`xlink:href`/namespaced attribute, `style` attributes, and any
     value containing `javascript:`, `data:`, `expression(`, `@import`, embedded
     markup, or a non-local `url(...)` (only `url(#localId)` gradient refs pass).
     `text`/`tspan` render plain glyphs only — the `href`-bearing `<textPath>`
     stays rejected;
   - size/element-count caps guard against hostile output.

   Validation is **strict and all-or-nothing**: any disallowed element,
   attribute, or value fails the whole document. There is **no partial stripping**
   and **no fallback** — on any failure nosplay draws **no background** and
   surfaces the reason. On success the markup is re-serialized from the checked
   tree and normalised (`xmlns`, sizing, `role`/`aria-hidden`, `viewBox` —
   inferred from the SVG's own `width`/`height` when absent, so the art fills the
   layer instead of collapsing into the top-left corner);
5. draws the validated SVG as a large, low-opacity layer **behind** the notes
   (notes stay fully readable and clickable; the background is `aria-hidden` and
   `pointer-events: none`).

It refreshes on a **~30s heartbeat** and whenever the visible set of notes
changes meaningfully, but is **throttled** (min ~12s between generations, and
identical input is skipped) so it never churns or spams model calls.

### No fallback, by design

The **only** source of the background is Gemini Nano's direct SVG output. nosplay
does **not** fall back to a deterministic/local generator or any canned art. If
the Prompt API is **unsupported**, the model is **unavailable**, generation
**fails**, or the output **fails validation**, the background simply isn't shown
and the UI/debug state says which of those happened.

### Privacy

Everything happens entirely **on your device** via Gemini Nano. No timeline text
is sent to any server for this feature. There are **no mocked or canned AI
responses** — if the model isn't available, the feature simply stays inactive
(with a clear status message) rather than faking output.

### Requirements, support & constraints

The Prompt API and Summarizer API are **Chrome's built-in AI**, not a Web
standard available everywhere yet. The background generator depends on the
**Prompt API (`LanguageModel`)** specifically. To actually see a background you
need:

- A recent **Chrome** with the built-in AI **Prompt API** (`LanguageModel`)
  enabled. At time of writing it is partly **origin-trial / `chrome://flags`**
  -gated (e.g. *Prompt API for Gemini Nano*, plus *Optimization Guide On Device
  Model*), and its surface changes between versions — check
  [the Prompt API docs](https://developer.chrome.com/docs/ai/prompt-api) for the
  current setup. The Summarizer step additionally uses the
  [Summarizer API](https://developer.chrome.com/docs/ai/summarizer-api) when
  present, but its absence only means the raw feed text is used.
- Hardware that can host the model: roughly **>22 GB free disk**, **>4 GB VRAM**
  / a reasonably capable GPU, and an unmetered network for the **one-time model
  download** (the model is several GB and is shared across sites).
- On first use the model may need to **download**. Per the spec this requires a
  **user gesture**, which is why nosplay only calls `LanguageModel.create()` from
  the enable toggle. If you reload with the feature left on and the model still
  needs downloading, just toggle it off/on once to grant the gesture.
- You can inspect model state at `chrome://on-device-internals`.

### Unsupported browsers

In Firefox, Safari, older Chrome, or any browser without the built-in AI Prompt
API, the toggle still reflects your on/off choice but the status line clearly
states it's **not supported**, **no background is drawn**, and nothing else in
the app is affected.

### Debugging & visibility

Because the feature depends on browser-specific on-device models, it ships with
explicit diagnostics so it's easy to see what it's doing (or why it isn't):

- **AI debug panel** — when AI BG is on, a compact, collapsible *"AI debug —
  Gemini Nano direct SVG"* panel appears under the status line. It shows three
  headline badges — **Direct SVG** (did Gemini Nano produce SVG), **Validated**
  (did it pass strict validation), and **On screen** (did it reach the DOM) — the
  **failure reason** when something blocked it, the **Prompt API support /
  availability** and model readiness, the **actual summary/prompt text**, the
  **source range** and visible/summarized note counts, the **input / summary /
  raw-SVG / shown-SVG char counts**, the **render mode** (`direct-svg` or
  `none`), DOM/layer measurements, and the time of the **last run**.
- **Console logging** — every run logs a structured `[nosplay/ai-bg]` object to
  the browser console whose headline reads *"Gemini Nano direct SVG: YES/NO ·
  valid: YES/NO · on screen: YES/NO"* plus the failure reason, with the full
  generation state (Prompt API support/availability, model readiness, raw vs
  shown SVG char counts), DOM evidence, source slice, and the full generated SVG
  markup so it can be copied straight out of the console.

All of this is **runtime-only diagnostics** (never persisted) and is cleared when
the feature is toggled off.

## Relays

The timeline reads from a set of **read relays**. Two sources feed that set:

- **Follow-derived** — the read relays declared in your **NIP-65 (kind:10002)**
  event, discovered automatically at login.
- **Manual** — read relays you type into the **⚙ Relays** panel (one `wss://`
  URL per line). Entries are trimmed, validated as `ws://`/`wss://`, and deduped.

The **relay mode** decides how the two combine into the relays actually used
(shown live as *Active now* in the panel):

| Mode               | Effective read relays                                              |
| ------------------ | ----------------------------------------------------------------- |
| **Auto** (default) | Follow-derived relays only. Manual list is ignored for reads.     |
| **Merge**          | Union of follow-derived **and** manual relays.                    |
| **Manual**         | Manual relays only — a full **override** of the follow-derived list. |

In every mode, if the chosen set is empty (e.g. *Auto* before login, or *Manual*
with no URLs), nosplay falls back to its built-in default relays
(`wss://yabu.me`, `wss://r.kojira.io`, `wss://x.kojira.io`) so reads never go
dark. These defaults are also used to bootstrap follow/relay-list discovery at
login. Click **Apply & reconnect** to save the settings (they
persist to IndexedDB) and rebuild the feed. Notes you post are published to the
same active read-relay set.

## Develop

```sh
npm install
npm run dev       # start the dev server
npm run check     # svelte-check + tsc typecheck
npm run build     # production build to dist/
npm run preview   # preview the production build
```

## SVG smoke test

A tiny, isolated page that answers one question: **can Chrome's built-in AI
Prompt API / Gemini Nano return an SVG string from a short text prompt?** It
reuses the real `src/lib/ai/prompt.ts` and `src/lib/ai/sanitize.ts` helpers (no
mocks) and is separate from the app — it touches no product logic.

It is **not** a standalone file — open it through a Vite server (opening the
`.html` via `file://` will not load the TypeScript module). Use one of:

**Dev (recommended):**

1. `npm run dev`
2. Open **http://localhost:5173/svg-smoke.html**
3. Click **Run**.

**Preview the production build:**

1. `npm run build`
2. `npm run preview`
3. Open **http://localhost:4173/svg-smoke.html** — local builds use a base of
   `/`, so assets resolve at the server root and the preview is fully usable.
   (GitHub Pages deploys set `BASE_PATH=/nosplay/`; see *Deploy*.)
4. Click **Run**.

**Browser-only:** it must run in a **Chrome build with the Prompt API / Gemini
Nano enabled** (see *AI summary background → Requirements*). It **cannot run in
Node/CI** — `npm run build` only proves the page compiles, not that generation
works. If the API is unsupported/unavailable the status line says so and stops.

What to look at:

- the **RAW `<pre>` output** — the model's verbatim, untrusted text;
- the **VALID / INVALID** result from the strict validator (`validateAndSanitizeSvg`);
  on **VALID** the sanitized SVG is rendered below it.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the app
and publishes `dist/` to GitHub Pages. The workflow sets `BASE_PATH` to
`/<repo>/` so asset URLs resolve under the project site; enable Pages with the
**GitHub Actions** source in the repository settings.

## Tech

Svelte 5 (runes) · TypeScript · Vite · [nostr-tools](https://github.com/nbd-wtf/nostr-tools)
`SimplePool` · `idb` · Chrome built-in AI: [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (`LanguageModel`, generates the background SVG directly) and [Summarizer API](https://developer.chrome.com/docs/ai/summarizer-api) (Gemini Nano, on-device).

## Project layout

```
src/
  App.svelte                    full-screen UI + controls
  app.css                       dark theme + layout
  lib/
    components/
      Timeline.svelte           note layout across the window
      TimeAxis.svelte           time ticks; right edge = now
    timeline/
      store.svelte.ts           the single source of UI state (runes singleton)
      persist.ts                IndexedDB persistence of playback state
      format.ts                 display helpers (time, npub)
    nostr/
      pool.ts relays.ts follows.ts profiles.ts post.ts types.ts
    ai/
      summarizer.ts             Chrome built-in AI (Gemini Nano) Summarizer wrapper (optional input condenser)
      prompt.ts                 Prompt API (LanguageModel) wrapper → Gemini Nano generates background SVG directly
      sanitize.ts               strict allowlist validator/sanitizer for the model's SVG (no fallback)
    tts.ts                      Web Speech API wrapper
```
