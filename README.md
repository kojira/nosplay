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
- **Playback controls** — play/pause, −1m / +1m nudge, speed selector
  (1×–20×), a seek slider, and a **LIVE** button that re-follows wall-clock now.
- **Time navigation** — window-size selector (1 min – 1 hour) and a
  `datetime-local` jump to seek to any past moment within the loaded history.
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
- **Persistence** — window size, speed, TTS toggle, the selected TTS voice, a
  paused playhead position, your relay settings (mode + manual list), and a
  "remember login" hint are saved to IndexedDB and restored on reload. Once you have logged in at least
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
`SimplePool` · `idb`.

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
    tts.ts                      Web Speech API wrapper
```
