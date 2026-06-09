# nosplay

A time-scrubbable [Nostr](https://nostr.com) timeline. Notes flow across a
full-screen axis whose **right edge is the current moment** and whose left edge
is `now − window`. You can pause, rewind, fast-forward, and seek through the
recent past like a media player — hence *nos·play*.

Everything is real: notes are fetched live from public Nostr relays. There are
no sample or fake posts.

## Features

- **Live timeline** — kind:1 notes laid out by time across the full screen,
  newest at the right edge (the playhead = current time).
- **Playback controls** — play/pause, −1m / +1m nudge, speed selector
  (1×–60×), a seek slider, and a **LIVE** button that re-follows wall-clock now.
- **Time navigation** — window-size selector (1 min – 1 hour) and a
  `datetime-local` jump to seek to any past moment within the loaded history.
- **Text-to-speech** — optional read-aloud of new notes via the browser's
  Web Speech API. URLs and Nostr identifiers (npub/note/etc.) are stripped or
  replaced before speaking so they aren't read aloud.
- **Posting** — compose and publish a note through a [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md)
  browser extension (e.g. Alby, nos2x). The composer's *post-@* selector
  (current / playhead) only labels intent; posts always publish at the real
  current time.
- **Persistence** — window size, speed, TTS toggle, and a paused playhead
  position are saved to IndexedDB and restored on reload.

## Modes

- **follows** — when a NIP-07 signer is present, nosplay resolves your
  NIP-02 contact list and NIP-65 read relays and streams the people you follow.
- **limited** — with no signer (or no follows), it streams a small set of
  well-known public accounts plus a recent global feed so the timeline stays
  lively.

The mode, connection status, and signing account are shown in the top-right
status line.

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
