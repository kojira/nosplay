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
  Each note keeps a stable vertical lane for its lifetime (assigned once, keyed
  to its identity/author), so notes scroll horizontally without bouncing up and
  down as the visible window slides.
- **Note menu** — tap (or click) any note to open its options: **Show full
  post text** opens the untruncated content in a modal, and **Mute TTS for this
  author** permanently silences read-aloud for that note's author (pubkey).
  Muting takes effect immediately: it drops any of that author's notes already
  queued for speech and cuts off their note if it is being read at that moment.
  Muted authors are dimmed with a 🔇 badge and still appear in the timeline;
  the mute list persists across reloads (see *Persistence*) and can be undone
  from the same menu.
- **Playback controls** — play/pause, −1m / +1m nudge, speed selector
  (1×–20×), a seek slider, and a **LIVE** button that re-follows wall-clock now.
- **Time navigation** — window-size selector (1 min – 1 hour) and a
  `datetime-local` jump to seek to any past moment within the loaded history.
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
- **AI summary background** — an optional **✨ AI BG** toggle that, when on,
  periodically summarizes the currently visible timeline with **Chrome's
  built-in AI Summarizer (Gemini Nano, on-device)** and renders it as a
  large, faint, low-opacity **abstract SVG** behind the notes — constellations,
  ribbons and soft gradients derived from the summary's shape, never its words.
  When Chrome's **Prompt API** (`LanguageModel`, Gemini Nano) is also available,
  the model additionally picks a structured palette/scene for that background;
  otherwise nosplay derives it deterministically. Everything runs locally — no
  text leaves your device, and there are **no mock/fake AI responses**. It
  updates on a ~30s heartbeat and on meaningful context change (notes entering /
  leaving the window), throttled so it never spams the model. A status line
  always tells you what it's doing (downloading the model, summarizing, ready,
  or that the summary came back empty when there isn't enough distinct content
  to paint) or why it's inactive (unsupported browser / model unavailable). The feature
  degrades gracefully: in browsers without built-in AI the toggle still reflects
  your choice but clearly says it's unsupported, and the rest of the app is
  unaffected. See [AI summary background](#ai-summary-background).
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
- **overrides** persisted playback for that load, and clamps the playhead into
  the loaded history once it arrives.

When neither param is present the app behaves exactly as before (restoring your
persisted playback / starting live). `start` alone is treated as a bare jump
target; `end` alone seeks there keeping your current window.

## AI summary background

Toggle **✨ AI BG** (next to the TTS controls) to turn on an ambient, AI-generated
background. When enabled, nosplay:

1. collects a trimmed slice of the **currently visible** notes' text (the most
   recent ~40 notes / ~4000 chars within the window);
2. summarizes it with **Chrome's built-in AI Summarizer API** — the on-device
   **Gemini Nano** model (`type: 'key-points'`, `length: 'short'`,
   `format: 'plain-text'`);
3. turns that summary into an abstract SVG **locally** (`src/lib/ai/svg.ts`) — soft
   gradient blobs, orbital rings, flowing ribbons, and a constellation/star-field.
   Two paths feed the same local, sanitized assembler:
   - **deterministic base** — palette, shape counts and seed are derived purely
     from the summary's word counts, lengths and hashes. Given the same summary
     it always produces the same image. This is the stable production path.
   - **optional Prompt-API enhancement** — when Chrome's built-in **Prompt API**
     (`LanguageModel`, Gemini Nano) is available, nosplay additionally asks the
     model for a small **structured JSON scene** (a palette key plus shape
     counts, constrained by a JSON Schema via `responseConstraint`). That scene
     chooses the palette/mood and shape density; the summary still drives the
     constellation. Colors and the final SVG are assembled locally — the model
     only ever returns a palette name and small integers, never markup or text.

   In **both** paths **no summary text, words or letters are ever drawn** — only
   shapes. If the Prompt API is unavailable, the session can't be created, or its
   output can't be parsed/validated, nosplay **falls back automatically** to the
   deterministic generator;
4. draws it as a large, low-opacity layer **behind** the notes (notes stay fully
   readable and clickable; the background is `aria-hidden` and
   `pointer-events: none`).

It refreshes on a **~30s heartbeat** and whenever the visible set of notes
changes meaningfully, but is **throttled** (min ~12s between summaries, and
identical text is skipped) so it never churns or spams model calls.

### Privacy

Summarization happens entirely **on your device** via Gemini Nano. No timeline
text is sent to any server for this feature. There are **no mocked or canned AI
responses** — if the model isn't available, the feature simply stays inactive
(with a clear status message) rather than faking output.

### Requirements, support & constraints

The Summarizer API is **Chrome's built-in AI**, not a Web standard available
everywhere yet. To actually see summaries you need:

- **Chrome 138+** (desktop: Windows 10/11, macOS 13+, or Linux; also recent
  ChromeOS). The global `Summarizer` API reached stable around Chrome 138.
- Hardware that can host the model: roughly **>22 GB free disk**, **>4 GB VRAM**
  / a reasonably capable GPU, and an unmetered network for the **one-time model
  download** (the model is several GB and is shared across sites).
- On first use the model may need to **download**. Per the spec this requires a
  **user gesture**, which is why nosplay only calls `Summarizer.create()` from
  the enable toggle. If you reload with the feature left on and the model still
  needs downloading, just toggle it off/on once to grant the gesture.
- If you're on an older/dev Chrome where the API is still behind a flag, enable
  the relevant **`chrome://flags`** entries (e.g. *Summarization API for Gemini
  Nano*, and *Optimization Guide On Device Model*), then restart Chrome. Flag
  names and availability change between versions — check
  [the Summarizer API docs](https://developer.chrome.com/docs/ai/summarizer-api)
  for the current setup. You can inspect model state at
  `chrome://on-device-internals`.

### Unsupported browsers

The feature **degrades gracefully**. In Firefox, Safari, older Chrome, or any
browser without the built-in AI Summarizer, the toggle still reflects your
on/off choice but the status line clearly states it's **not supported**, no
background is drawn, and nothing else in the app is affected.

### Debugging & visibility

Because the feature depends on browser-specific on-device models, it ships with
explicit diagnostics so it's easy to see what it's doing (or why it isn't):

- **AI debug panel** — when AI BG is on, a compact, collapsible *"AI debug —
  summary & source range"* panel appears under the status line. It shows the
  **actual summary text**, the **source range** that was summarized (the
  `created_at` span of the slice and the visible window), how many notes were
  **summarized vs visible**, the **input / summary / SVG char counts** (and
  whether the input was truncated to the char budget), the **render mode**
  (Prompt-API scene — with palette — vs deterministic fallback), and the time of
  the **last run**. When there isn't enough text yet, it says so and reports how
  many more characters are needed.
- **Console logging** — every summarization run logs a structured
  `[nosplay/ai-bg]` object to the browser console (status, render mode, scene
  data, visible/summarized counts, char counts, window/slice timestamps, and the
  summary itself), so SVG/scene generation results are always inspectable. Scene
  model readiness and any summarize/render failures are logged too.

All of this is **runtime-only diagnostics** (never persisted) and is cleared when
the feature is toggled off.

### The Prompt API (optional enhancement)

nosplay uses the **Summarizer API** as the **production base** for the text
summary because it is the most stable, purpose-built built-in-AI surface for
that task. The more general **Prompt API** (`LanguageModel`,
`src/lib/ai/prompt.ts`) is used **only as an optional enhancement**: when it is
present, nosplay asks Gemini Nano for a **structured JSON scene** (palette +
shape counts, constrained by a JSON Schema) that drives the abstract background,
instead of deriving everything deterministically from the summary.

This path is **best-effort and may simply be absent** for you:

- The Prompt API is **less widely available** than the Summarizer. At time of
  writing it is partly **origin-trial / `chrome://flags`-gated** (e.g. *Prompt
  API for Gemini Nano*) and its surface changes between Chrome versions, so it
  is **not assumed** to exist. nosplay feature-detects it cleanly.
- To avoid surprising the user with a second large download, nosplay only
  creates a Prompt API session when the on-device model is already
  `available` — it **never forces a download** for this enhancement.
- If the API is missing, the session can't be created, the prompt fails, or the
  JSON can't be parsed/validated, nosplay **falls back automatically** to the
  deterministic summary→SVG generator. The summary itself still comes from the
  Summarizer either way, so turning this on never breaks the base feature.

In short: **Summarizer = summary (stable)**, **Prompt API = nicer background
when your Chrome happens to support it**, with a deterministic local fallback.

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

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the app
and publishes `dist/` to GitHub Pages. The workflow sets `BASE_PATH` to
`/<repo>/` so asset URLs resolve under the project site; enable Pages with the
**GitHub Actions** source in the repository settings.

## Tech

Svelte 5 (runes) · TypeScript · Vite · [nostr-tools](https://github.com/nbd-wtf/nostr-tools)
`SimplePool` · `idb` · [Chrome built-in AI Summarizer](https://developer.chrome.com/docs/ai/summarizer-api) (Gemini Nano, on-device).

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
      summarizer.ts             Chrome built-in AI (Gemini Nano) Summarizer wrapper (summary base)
      prompt.ts                 optional Prompt API (LanguageModel) wrapper → structured scene JSON
      svg.ts                    summary/scene → faint abstract background SVG (no text), local + sanitized
    tts.ts                      Web Speech API wrapper
```
