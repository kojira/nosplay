// THE SINGLE SOURCE OF UI STATE for nosplay.
// A Svelte 5 runes module exporting a singleton `timeline`.
// Constructing the singleton opens NO sockets; call connect() (e.g. onMount).
import type { Event } from 'nostr-tools';
import type { SubCloser } from 'nostr-tools/pool';
import { pool } from '../nostr/pool';
import {
  BOOTSTRAP_RELAYS,
  FALLBACK_RELAYS,
  FALLBACK_AUTHORS,
} from '../nostr/relays';
import { resolveFollows } from '../nostr/follows';
import { fetchProfiles, type ProfileMeta } from '../nostr/profiles';
import { publishNote, hasNip07 } from '../nostr/post';
import { speak, cancelSpeech, hasTts } from '../tts';
import { loadPlayback, savePlayback } from './persist';
import type { Note } from '../nostr/types';

export type Status = 'idle' | 'connecting' | 'live' | 'limited' | 'error';
export type Mode = 'follows' | 'limited';

const MAX_NOTES = 5000;
const DEFAULT_WINDOW_MS = 300_000; // 5 minutes
const HISTORY_LIMIT = 500;
const LIVE_GLOBAL_LIMIT = 200;

export class TimelineStore {
  // ---- reactive state ----
  notes = $state<Note[]>([]); // sorted ascending by created_at, deduped, capped
  playheadMs = $state<number>(Date.now());
  windowMs = $state<number>(DEFAULT_WINDOW_MS);
  isLive = $state<boolean>(true);
  isPlaying = $state<boolean>(true);
  speed = $state<number>(1);
  status = $state<Status>('idle');
  mode = $state<Mode>('limited');
  account = $state<string | null>(null);
  canPost = $state<boolean>(false);
  ttsEnabled = $state<boolean>(false);
  earliestMs = $state<number>(Date.now());
  names = $state<Map<string, ProfileMeta>>(new Map());
  error = $state<string | null>(null);

  // ---- derived ----
  /** Notes whose created_at falls inside the visible window and at/behind the playhead. */
  visibleNotes = $derived(
    this.notes.filter((n) => {
      const ms = n.created_at * 1000;
      return ms <= this.playheadMs && ms >= this.playheadMs - this.windowMs;
    }),
  );

  /** The most recent visible note at/just-before the playhead, or null. */
  headNote = $derived<Note | null>(
    this.visibleNotes.length > 0
      ? this.visibleNotes[this.visibleNotes.length - 1]
      : null,
  );

  // ---- internal (non-reactive) ----
  #ids = new Set<string>();
  #subs: SubCloser[] = [];
  #raf: number | null = null;
  #lastFrame = 0;
  #activeRelays: string[] = FALLBACK_RELAYS;
  #lastSpokenId: string | null = null;

  // ---- persistence (IndexedDB via persist.ts) ----
  #persistReady = false; // true once the saved state has been loaded/applied
  #persistStop: (() => void) | null = null; // disposes the save effect
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingPlayheadMs: number | null = null; // paused playhead awaiting history load

  /** Relays to publish to (mirrors the active read/write relays in scope here). */
  get writeRelays(): string[] {
    return this.#activeRelays;
  }

  // ============================================================
  // Connection
  // ============================================================
  async connect(): Promise<void> {
    if (this.status === 'connecting' || this.status === 'live' || this.status === 'limited') {
      return;
    }
    // Restore persisted playback settings/state before we start the live clock.
    await this.#initPersistence();
    this.status = 'connecting';
    this.error = null;
    this.canPost = hasNip07();

    let authors: string[] = [];
    let relays: string[] = [];

    // Attempt NIP-07 login + follow resolution.
    try {
      if (hasNip07() && window.nostr) {
        const pubkey = await window.nostr.getPublicKey();
        this.account = pubkey;
        const resolved = await resolveFollows(pubkey);
        if (resolved.authors.length > 0) {
          authors = resolved.authors;
          relays = resolved.readRelays.length > 0 ? resolved.readRelays : FALLBACK_RELAYS;
        }
      }
    } catch {
      // login refused / failed -> limited mode
      this.account = this.account ?? null;
    }

    if (authors.length > 0) {
      this.mode = 'follows';
      this.#activeRelays = relays;
    } else {
      this.mode = 'limited';
      authors = FALLBACK_AUTHORS;
      this.#activeRelays = FALLBACK_RELAYS;
      relays = FALLBACK_RELAYS;
    }

    // Fire profile fetch (non-blocking).
    void this.#loadNames(authors, relays);

    // History fetch (one-shot) + live subscription.
    try {
      await this.#fetchHistory(authors, relays);
      // Now that earliestMs reflects real history, clamp the restored playhead.
      this.#applyPendingPlayhead();
      this.#subscribeLive(authors, relays);
      this.status = this.mode === 'follows' ? 'live' : 'limited';
    } catch {
      this.status = 'error';
      this.error = 'Failed to connect to relays.';
    }

    this.start();
  }

  // ============================================================
  // Persistence
  // ============================================================
  /** Load saved playback state (once) and start saving on future changes. */
  async #initPersistence(): Promise<void> {
    if (this.#persistReady) return;
    this.#persistReady = true;

    const saved = await loadPlayback();
    if (saved) {
      // Settings always restore.
      if (typeof saved.windowMs === 'number' && saved.windowMs > 0) {
        this.windowMs = saved.windowMs;
      }
      if (typeof saved.speed === 'number' && saved.speed > 0) {
        this.speed = saved.speed;
      }
      if (typeof saved.ttsEnabled === 'boolean') {
        this.ttsEnabled = saved.ttsEnabled;
      }
      // Playhead only restores when the last session was paused (not LIVE);
      // a live session reloads live, following wall-clock now. The actual
      // playhead is applied after history loads (see #applyPendingPlayhead),
      // so earliestMs reflects the real oldest note before we clamp.
      if (saved.isLive === false && typeof saved.playheadMs === 'number') {
        this.isLive = false;
        this.isPlaying = false;
        this.#pendingPlayheadMs = saved.playheadMs;
        this.playheadMs = saved.playheadMs; // provisional; re-clamped post-history
      }
    }

    // Persist whenever the small settings or the live flag change. The playhead
    // is read untracked so the ~60fps live clock does not trigger saves; explicit
    // seeks call #scheduleSave() themselves.
    this.#persistStop = $effect.root(() => {
      $effect(() => {
        // Track the fields we care about.
        void this.windowMs;
        void this.speed;
        void this.ttsEnabled;
        void this.isLive;
        this.#scheduleSave();
      });
      return () => {};
    });
  }

  /** Debounced best-effort save of the current playback slice. */
  #scheduleSave(): void {
    if (!this.#persistReady) return;
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void savePlayback({
        windowMs: this.windowMs,
        speed: this.speed,
        ttsEnabled: this.ttsEnabled,
        isLive: this.isLive,
        // Only meaningful when paused; harmless otherwise since restore ignores
        // playheadMs unless isLive === false.
        playheadMs: this.playheadMs,
      });
    }, 400);
  }

  /** Apply a restored paused playhead once real history (earliestMs) is known. */
  #applyPendingPlayhead(): void {
    if (this.#pendingPlayheadMs === null) return;
    const ms = this.#pendingPlayheadMs;
    this.#pendingPlayheadMs = null;
    // Still paused? clamp into the loaded range. If the user already went LIVE
    // or seeked during the await, leave their choice alone.
    if (!this.isLive) {
      this.playheadMs = clamp(ms, this.earliestMs, Date.now());
    }
  }

  async #fetchHistory(authors: string[], relays: string[]): Promise<void> {
    const filter = { kinds: [1], authors, limit: HISTORY_LIMIT };
    const events = await pool.querySync(relays, filter);
    for (const e of events) this.addNote(e);
  }

  #subscribeLive(authors: string[], relays: string[]): void {
    const since = Math.floor(Date.now() / 1000) - 60;
    const sub = pool.subscribeMany(
      relays,
      { kinds: [1], authors, since },
      {
        onevent: (e: Event) => this.addNote(e),
        oneose: () => {
          /* end of stored events; live stream continues */
        },
      },
    );
    this.#subs.push(sub);

    // In limited mode, also tap a small global recent feed so the timeline is lively.
    if (this.mode === 'limited') {
      const globalSub = pool.subscribeMany(
        FALLBACK_RELAYS,
        { kinds: [1], since, limit: LIVE_GLOBAL_LIMIT },
        {
          onevent: (e: Event) => this.addNote(e),
          oneose: () => {},
        },
      );
      this.#subs.push(globalSub);
    }
  }

  async #loadNames(authors: string[], relays: string[]): Promise<void> {
    try {
      const map = await fetchProfiles(authors.slice(0, 200), relays);
      if (map.size > 0) {
        // Merge into a new Map so $state sees the change.
        const merged = new Map(this.names);
        for (const [k, v] of map) merged.set(k, v);
        this.names = merged;
      }
    } catch {
      // names are optional
    }
  }

  // ============================================================
  // Notes
  // ============================================================
  /** Add an event: dedupe by id, insert sorted ascending, cap, update earliest, TTS head. */
  addNote(e: Event | Note): void {
    if (this.#ids.has(e.id)) return;
    // When given a raw Event (has a `kind`), only accept kind:1.
    const kind = (e as { kind?: number }).kind;
    if (kind !== undefined && kind !== 1) return;
    const note: Note = {
      id: e.id,
      pubkey: e.pubkey,
      created_at: e.created_at,
      content: e.content,
      tags: e.tags,
    };
    this.#ids.add(note.id);

    // Insert keeping ascending order by created_at.
    const arr = this.notes;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].created_at < note.created_at) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, note);

    // Cap from the front (oldest) if over the limit.
    if (arr.length > MAX_NOTES) {
      const removed = arr.splice(0, arr.length - MAX_NOTES);
      for (const r of removed) this.#ids.delete(r.id);
    }

    // Reassign to trigger reactivity (splice on $state array is tracked, but be explicit).
    this.notes = arr;

    if (arr.length > 0) {
      this.earliestMs = arr[0].created_at * 1000;
    }

    this.#maybeSpeakHead();
  }

  #maybeSpeakHead(): void {
    if (!this.ttsEnabled || !hasTts()) return;
    const head = this.headNote;
    if (!head) return;
    if (head.id === this.#lastSpokenId) return;
    // Only speak notes at/behind the live-ish playhead (avoid speaking far-past on seek).
    this.#lastSpokenId = head.id;
    speak(head.content);
  }

  // ============================================================
  // Playback loop
  // ============================================================
  start(): void {
    if (this.#raf !== null) return;
    if (typeof requestAnimationFrame === 'undefined') return;
    this.#lastFrame = Date.now();
    const tick = () => {
      this.#step();
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.#raf !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.#raf);
    }
    this.#raf = null;
  }

  #step(): void {
    const now = Date.now();
    const elapsed = now - this.#lastFrame;
    this.#lastFrame = now;

    if (this.isLive) {
      this.playheadMs = now;
      return;
    }
    if (this.isPlaying) {
      const next = this.playheadMs + elapsed * this.speed;
      // Don't run past wall-clock now; if we catch up, go LIVE.
      if (next >= now) {
        this.playheadMs = now;
        this.isLive = true;
      } else {
        this.playheadMs = next;
      }
    }
  }

  // ============================================================
  // Controls
  // ============================================================
  play(): void {
    this.isPlaying = true;
  }
  pause(): void {
    this.isPlaying = false;
  }
  togglePlay(): void {
    this.isPlaying = !this.isPlaying;
  }

  /** Shift the playhead by deltaMs (e.g. -60000 / +60000). Turns LIVE off; clamps. */
  nudge(deltaMs: number): void {
    this.isLive = false;
    cancelSpeech();
    const now = Date.now();
    const next = this.playheadMs + deltaMs;
    this.playheadMs = clamp(next, this.earliestMs, now);
    this.#scheduleSave();
  }

  setSpeed(n: number): void {
    if (n > 0 && Number.isFinite(n)) this.speed = n;
  }

  /** Re-follow wall-clock now. */
  goLive(): void {
    this.isLive = true;
    this.isPlaying = true;
    this.playheadMs = Date.now();
  }

  /** Jump the playhead to an absolute epoch-ms; turns LIVE off and clamps. */
  seekTo(ms: number): void {
    const now = Date.now();
    this.isLive = false;
    cancelSpeech();
    this.playheadMs = clamp(ms, this.earliestMs, now);
    if (this.playheadMs >= now) {
      this.isLive = true;
    }
    this.#scheduleSave();
  }

  toggleTts(): void {
    this.ttsEnabled = !this.ttsEnabled;
    if (!this.ttsEnabled) cancelSpeech();
    else this.#lastSpokenId = this.headNote?.id ?? null;
  }

  /** Publish a note via NIP-07; surfaces errors on this.error and rethrows. */
  async post(content: string): Promise<void> {
    this.error = null;
    try {
      await publishNote(content, this.writeRelays);
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to post note.';
      throw err;
    }
  }

  // ============================================================
  // Teardown
  // ============================================================
  disconnect(): void {
    this.stop();
    cancelSpeech();
    // Flush a final save, then tear down the persistence effect.
    if (this.#saveTimer !== null) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    if (this.#persistReady) {
      void savePlayback({
        windowMs: this.windowMs,
        speed: this.speed,
        ttsEnabled: this.ttsEnabled,
        isLive: this.isLive,
        playheadMs: this.playheadMs,
      });
    }
    if (this.#persistStop) {
      this.#persistStop();
      this.#persistStop = null;
    }
    this.#persistReady = false;
    for (const sub of this.#subs) {
      try {
        sub.close();
      } catch {
        // ignore
      }
    }
    this.#subs = [];
    if (this.status !== 'error') this.status = 'idle';
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

// The singleton UI state source. Importing this does NOT open sockets.
export const timeline = new TimelineStore();
