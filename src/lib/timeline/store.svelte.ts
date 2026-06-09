// THE SINGLE SOURCE OF UI STATE for nosplay.
// A Svelte 5 runes module exporting a singleton `timeline`.
// Constructing the singleton opens NO sockets; call connect() (e.g. onMount).
import type { Event } from 'nostr-tools';
import type { SubCloser } from 'nostr-tools/pool';
import { pool } from '../nostr/pool';
import { FALLBACK_RELAYS, FALLBACK_AUTHORS } from '../nostr/relays';
import { resolveFollows } from '../nostr/follows';
import { fetchProfiles, type ProfileMeta } from '../nostr/profiles';
import { publishNote, hasNip07 } from '../nostr/post';
import { speak, cancelSpeech, hasTts } from '../tts';
import { loadPlayback, savePlayback } from './persist';
import type { Note } from '../nostr/types';

export type Status = 'idle' | 'connecting' | 'live' | 'limited' | 'error';
export type Mode = 'follows' | 'limited';

/** Explicit NIP-07 login lifecycle, surfaced in the UI. */
export type LoginState = 'logged-out' | 'logging-in' | 'logged-in' | 'login-error';

/** How the manual read-relay list combines with the follow-derived (NIP-65) list. */
export type RelayMode = 'auto' | 'merge' | 'manual';

/** Lifecycle of the follow (kind:3 / kind:10002) resolution. */
export type FollowStatus = 'idle' | 'resolving' | 'ready' | 'empty' | 'error';

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
  canPost = $state<boolean>(false);
  ttsEnabled = $state<boolean>(false);
  earliestMs = $state<number>(Date.now());
  names = $state<Map<string, ProfileMeta>>(new Map());
  error = $state<string | null>(null);

  // ---- auth (NIP-07) ----
  loginState = $state<LoginState>('logged-out');
  loginError = $state<string | null>(null);
  /** Logged-in account pubkey (hex), or null when logged out. */
  pubkey = $state<string | null>(null);
  /** True once we know whether a NIP-07 signer (window.nostr) exists. */
  hasSigner = $state<boolean>(false);

  // ---- follows (kind:3 contacts + kind:10002 NIP-65 read relays) ----
  followStatus = $state<FollowStatus>('idle');
  /** Number of pubkeys in the logged-in account's kind:3 contact list. */
  followCount = $state<number>(0);
  /** Read relays declared by the account's kind:10002 (NIP-65) event. */
  followReadRelays = $state<string[]>([]);

  // ---- relay settings ----
  /** User-entered read relays (manual override / merge source). */
  manualRelays = $state<string[]>([]);
  /** Strategy for combining follow-derived and manual relays. */
  relayMode = $state<RelayMode>('auto');

  // ---- derived ----
  /**
   * The read relays actually used for history + live subscriptions, resolved
   * from `relayMode`, the follow-derived NIP-65 list, and the manual list:
   *  - auto   → follow-derived relays (fallback to defaults when none)
   *  - merge  → union of follow-derived and manual
   *  - manual → manual only (override)
   * Any empty result falls back to FALLBACK_RELAYS so reads never go dark.
   */
  activeReadRelays = $derived.by<string[]>(() => {
    const follow = this.followReadRelays;
    const manual = this.manualRelays;
    let relays: string[];
    switch (this.relayMode) {
      case 'manual':
        relays = manual;
        break;
      case 'merge':
        relays = uniq([...follow, ...manual]);
        break;
      case 'auto':
      default:
        relays = follow;
        break;
    }
    return relays.length > 0 ? relays : FALLBACK_RELAYS;
  });

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
  #lastSpokenId: string | null = null;
  /** Authors of the current feed (follow list, or fallback authors in limited mode). */
  #followAuthors: string[] = [];
  /** Remembered intent to auto-login on next connect (persisted). */
  #rememberLogin = false;

  // ---- persistence (IndexedDB via persist.ts) ----
  #persistReady = false; // true once the saved state has been loaded/applied
  #persistStop: (() => void) | null = null; // disposes the save effect
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingPlayheadMs: number | null = null; // paused playhead awaiting history load

  /** Relays to publish to (mirrors the active read relays in scope here). */
  get writeRelays(): string[] {
    return this.activeReadRelays;
  }

  // ============================================================
  // Connection
  // ============================================================
  async connect(): Promise<void> {
    if (this.status === 'connecting' || this.status === 'live' || this.status === 'limited') {
      return;
    }
    // Restore persisted settings/state before we start the live clock.
    await this.#initPersistence();
    this.status = 'connecting';
    this.error = null;
    this.hasSigner = hasNip07();
    this.canPost = hasNip07();
    this.start();

    // Auto re-login when the user was logged in last session and a signer is
    // present. Most NIP-07 extensions remember the granted permission, so this
    // does not re-prompt. The feed is built inside login(); on failure we fall
    // through to the limited feed below.
    if (this.#rememberLogin && hasNip07() && window.nostr) {
      try {
        await this.login();
        return;
      } catch {
        // fall through to limited mode
      }
    }

    this.mode = 'limited';
    await this.#rebuildFeed();
  }

  /**
   * Explicit NIP-07 login. Requests the public key from window.nostr, then
   * resolves the follow list + read relays and switches to the follows feed.
   * Surfaces progress on loginState / loginError; rethrows on failure.
   */
  async login(): Promise<void> {
    if (!hasNip07() || !window.nostr) {
      this.loginState = 'login-error';
      this.loginError =
        'No NIP-07 extension found. Install a signer (e.g. Alby, nos2x) and reload.';
      throw new Error(this.loginError);
    }
    this.loginState = 'logging-in';
    this.loginError = null;
    try {
      const pubkey = await window.nostr.getPublicKey();
      this.pubkey = pubkey;
      this.loginState = 'logged-in';
      this.hasSigner = true;
      this.canPost = true;
      this.#rememberLogin = true;
      this.#scheduleSave();
      await this.#resolveAndApplyFollows();
    } catch (err) {
      this.loginState = 'login-error';
      this.loginError = err instanceof Error ? err.message : 'Login was refused or failed.';
      throw err;
    }
  }

  /** Forget the logged-in account and return to the limited (no-auth) feed. */
  async logout(): Promise<void> {
    this.pubkey = null;
    this.loginState = 'logged-out';
    this.loginError = null;
    this.followStatus = 'idle';
    this.followCount = 0;
    this.followReadRelays = [];
    this.#followAuthors = [];
    this.mode = 'limited';
    this.#rememberLogin = false;
    this.#scheduleSave();
    await this.#rebuildFeed();
  }

  /** Reconnect (tear down + rebuild) the current feed with current settings. */
  async reconnect(): Promise<void> {
    await this.#rebuildFeed();
  }

  /** Re-resolve the follow list + NIP-65 read relays for the logged-in account. */
  async refreshFollows(): Promise<void> {
    if (this.loginState !== 'logged-in' || !this.pubkey) return;
    await this.#resolveAndApplyFollows();
  }

  /** Resolve kind:3 contacts + kind:10002 read relays, then rebuild the feed. */
  async #resolveAndApplyFollows(): Promise<void> {
    if (!this.pubkey) return;
    this.followStatus = 'resolving';
    try {
      const resolved = await resolveFollows(this.pubkey);
      this.followReadRelays = resolved.readRelays;
      this.followCount = resolved.authors.length;
      this.#followAuthors = resolved.authors;
      if (resolved.authors.length > 0) {
        this.mode = 'follows';
        this.followStatus = 'ready';
      } else {
        // Logged in but no contacts found: stay in limited mode so the timeline
        // still shows something, and tell the user why.
        this.mode = 'limited';
        this.#followAuthors = [];
        this.followStatus = 'empty';
      }
    } catch {
      this.followStatus = 'error';
      this.mode = 'limited';
      this.#followAuthors = [];
    }
    await this.#rebuildFeed();
  }

  // ============================================================
  // Relay settings
  // ============================================================
  /**
   * Apply new relay settings from the UI and reconnect. `manual` is normalized
   * (trimmed, ws(s):// only, deduped). The effective read relays then follow
   * `activeReadRelays` and the rebuilt feed uses them immediately.
   */
  async setRelaySettings(mode: RelayMode, manual: string[]): Promise<void> {
    this.relayMode = mode;
    this.manualRelays = normalizeRelays(manual);
    this.#scheduleSave();
    await this.#rebuildFeed();
  }

  // ============================================================
  // Feed (history + live subscription) build/teardown
  // ============================================================
  /** Tear down current subscriptions, clear notes, and (re)build the feed. */
  async #rebuildFeed(): Promise<void> {
    this.#closeSubs();
    this.#clearNotes();
    this.status = 'connecting';
    this.error = null;

    const authors = this.mode === 'follows' ? this.#followAuthors : FALLBACK_AUTHORS;
    const relays = this.activeReadRelays;

    // Fire profile fetch (non-blocking).
    void this.#loadNames(authors, relays);

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
  }

  #closeSubs(): void {
    for (const sub of this.#subs) {
      try {
        sub.close();
      } catch {
        // ignore
      }
    }
    this.#subs = [];
  }

  /** Drop all loaded notes (used when the feed source changes). */
  #clearNotes(): void {
    this.notes = [];
    this.#ids.clear();
    this.earliestMs = Date.now();
    this.#lastSpokenId = null;
  }

  // ============================================================
  // Persistence
  // ============================================================
  /** Load saved settings (once) and start saving on future changes. */
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
      if (saved.relayMode === 'auto' || saved.relayMode === 'merge' || saved.relayMode === 'manual') {
        this.relayMode = saved.relayMode;
      }
      if (Array.isArray(saved.manualRelays)) {
        this.manualRelays = normalizeRelays(saved.manualRelays);
      }
      if (typeof saved.rememberLogin === 'boolean') {
        this.#rememberLogin = saved.rememberLogin;
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
        void this.relayMode;
        void this.manualRelays;
        this.#scheduleSave();
      });
      return () => {};
    });
  }

  /** Debounced best-effort save of the current settings slice. */
  #scheduleSave(): void {
    if (!this.#persistReady) return;
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void savePlayback(this.#snapshot());
    }, 400);
  }

  /** The slice of state we persist between sessions. */
  #snapshot() {
    return {
      windowMs: this.windowMs,
      speed: this.speed,
      ttsEnabled: this.ttsEnabled,
      isLive: this.isLive,
      // Only meaningful when paused; harmless otherwise since restore ignores
      // playheadMs unless isLive === false.
      playheadMs: this.playheadMs,
      relayMode: this.relayMode,
      manualRelays: this.manualRelays,
      rememberLogin: this.#rememberLogin,
    };
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
      void savePlayback(this.#snapshot());
    }
    if (this.#persistStop) {
      this.#persistStop();
      this.#persistStop = null;
    }
    this.#persistReady = false;
    this.#closeSubs();
    if (this.status !== 'error') this.status = 'idle';
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Deduplicate while preserving order. */
function uniq(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Trim, keep only ws:// / wss:// URLs, drop trailing slashes, dedupe. */
function normalizeRelays(list: string[]): string[] {
  const cleaned = list
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => /^wss?:\/\/.+/i.test(s));
  return uniq(cleaned);
}

// The singleton UI state source. Importing this does NOT open sockets.
export const timeline = new TimelineStore();
