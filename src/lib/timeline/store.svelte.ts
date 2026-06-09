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
import {
  speak,
  cancelSpeech,
  hasTts,
  listVoices,
  onVoicesChanged,
  setSelectedVoiceURI,
} from '../tts';
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
/** Max live notes buffered for TTS; older ones are dropped during a flood. */
const TTS_QUEUE_MAX = 50;

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
  /** Available speechSynthesis voices, refreshed on `voiceschanged`. */
  availableVoices = $state<SpeechSynthesisVoice[]>([]);
  /** User-selected TTS voice (voiceURI), or null for the Japanese auto-pick. */
  selectedVoiceURI = $state<string | null>(null);
  /** Id of the note currently being read aloud by TTS, or null. */
  speakingId = $state<string | null>(null);
  /**
   * Hex pubkeys the user has permanently muted for TTS. Notes from these
   * authors still render in the timeline but are never spoken. Persisted across
   * sessions. Reassigned as a fresh Set on every change so $state tracks it.
   */
  mutedPubkeys = $state<Set<string>>(new Set());
  /**
   * Bumped whenever the note feed is torn down and rebuilt. Lets the Timeline
   * view drop its cached, identity-keyed lane assignments so a new feed starts
   * with a clean lane layout instead of inheriting stale rows.
   */
  feedVersion = $state<number>(0);
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
  /** FIFO queue of live arrivals awaiting speech, drained one at a time. */
  #ttsQueue: { id: string; text: string }[] = [];
  /** True while an utterance is in flight (between speak() and its end/error). */
  #ttsBusy = false;
  /**
   * Becomes true only once the live subscription is active, so history /
   * bootstrap notes loaded on connect/reconnect are never spoken — TTS focuses
   * on notes that arrive live afterwards.
   */
  #ttsLive = false;
  /**
   * Id of the note last spoken/queued from the playhead path (past playback),
   * or null. Prevents re-speaking the same head note across the many frames it
   * stays current. Reset on any manual seek/nudge/goLive/stop so a jump neither
   * replays the old head nor gets suppressed by a stale marker.
   */
  #lastPlayheadSpokenId: string | null = null;
  /** Disposes the `voiceschanged` subscription. */
  #voicesStop: (() => void) | null = null;
  /** Authors of the current feed (follow list, or fallback authors in limited mode). */
  #followAuthors: string[] = [];
  /** Remembered intent to auto-login on next connect (persisted). */
  #rememberLogin = false;
  /** Pubkeys of arrived notes whose profile (kind:0) is not yet loaded. */
  #pendingProfilePks = new Set<string>();
  #profileTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.#initVoices();
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
    // Suppress TTS until the new live subscription starts, and drop anything
    // queued/speaking from the old feed.
    this.#ttsLive = false;
    this.#stopSpeech();
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
    // Invalidate the view's cached lane assignments: the rebuilt feed is a fresh
    // set of notes, so their rows should be assigned anew.
    this.feedVersion++;
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
      // Only a non-empty string overrides the default (null = Japanese auto-pick).
      if (typeof saved.selectedVoiceURI === 'string' && saved.selectedVoiceURI) {
        this.selectedVoiceURI = saved.selectedVoiceURI;
      }
      // Mirror the restored selection into the TTS module so speak() uses it.
      setSelectedVoiceURI(this.selectedVoiceURI);
      if (saved.relayMode === 'auto' || saved.relayMode === 'merge' || saved.relayMode === 'manual') {
        this.relayMode = saved.relayMode;
      }
      if (Array.isArray(saved.manualRelays)) {
        this.manualRelays = normalizeRelays(saved.manualRelays);
      }
      if (typeof saved.rememberLogin === 'boolean') {
        this.#rememberLogin = saved.rememberLogin;
      }
      if (Array.isArray(saved.mutedPubkeys)) {
        this.mutedPubkeys = new Set(
          saved.mutedPubkeys.filter((pk): pk is string => typeof pk === 'string'),
        );
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
        void this.selectedVoiceURI;
        void this.isLive;
        void this.relayMode;
        void this.manualRelays;
        void this.mutedPubkeys;
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
      selectedVoiceURI: this.selectedVoiceURI,
      isLive: this.isLive,
      // Only meaningful when paused; harmless otherwise since restore ignores
      // playheadMs unless isLive === false.
      playheadMs: this.playheadMs,
      relayMode: this.relayMode,
      manualRelays: this.manualRelays,
      rememberLogin: this.#rememberLogin,
      mutedPubkeys: [...this.mutedPubkeys],
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

    // From here on, events delivered by these subscriptions are live arrivals
    // eligible for TTS (subject to ttsEnabled / isLive checks in #enqueueTts).
    this.#ttsLive = true;
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

    // Lazily resolve the author's profile (name + avatar) if we don't have it
    // yet. The limited-mode global feed surfaces arbitrary authors that are not
    // in the follow list, so without this most notes would show no name/icon.
    this.#queueProfile(note.pubkey);

    this.#enqueueTts(note);
  }

  /** Queue an author pubkey for a debounced batched kind:0 profile fetch. */
  #queueProfile(pubkey: string): void {
    if (this.names.has(pubkey) || this.#pendingProfilePks.has(pubkey)) return;
    this.#pendingProfilePks.add(pubkey);
    if (this.#profileTimer !== null) return;
    this.#profileTimer = setTimeout(() => {
      this.#profileTimer = null;
      void this.#flushProfiles();
    }, 500);
  }

  /** Fetch queued unknown profiles in one batch and merge them into `names`. */
  async #flushProfiles(): Promise<void> {
    const pks = [...this.#pendingProfilePks].filter((pk) => !this.names.has(pk));
    this.#pendingProfilePks.clear();
    if (pks.length === 0) return;
    // Cap per batch so a busy global feed can't issue an unbounded query.
    await this.#loadNames(pks.slice(0, 200), this.activeReadRelays);
  }

  /**
   * Populate the voice list and keep it fresh as voices load asynchronously.
   * Voices are deduped by voiceURI so they form stable, unique option keys.
   */
  #initVoices(): void {
    if (this.#voicesStop) return;
    const refresh = () => {
      const seen = new Set<string>();
      this.availableVoices = listVoices().filter((v) => {
        if (seen.has(v.voiceURI)) return false;
        seen.add(v.voiceURI);
        return true;
      });
    };
    refresh();
    this.#voicesStop = onVoicesChanged(refresh);
  }

  /**
   * Enqueue a live note for sequential TTS. No-op unless TTS is enabled, the
   * live subscription has started (so history/bootstrap notes are never read),
   * and we are following the live edge — a paused/seeked session stays silent
   * so incoming notes don't talk over what the user is reading in the past.
   *
   * Every eligible note is queued (not just the latest head), so a burst of
   * arrivals is spoken one after another instead of only the most recent one.
   */
  #enqueueTts(note: Note): void {
    if (!this.ttsEnabled || !hasTts()) return;
    if (!this.#ttsLive || !this.isLive) return;
    if (this.mutedPubkeys.has(note.pubkey)) return; // permanently muted author
    this.#ttsQueue.push({ id: note.id, text: note.content });
    // Bound the backlog: during a flood, reading every note would lag far
    // behind the timeline, so keep only the most recent arrivals.
    if (this.#ttsQueue.length > TTS_QUEUE_MAX) {
      this.#ttsQueue.splice(0, this.#ttsQueue.length - TTS_QUEUE_MAX);
    }
    this.#drainTts();
  }

  /**
   * Speak the note currently at the playhead when playing through the past
   * (paused-but-playing, i.e. not LIVE). This is the seek/rewind counterpart to
   * #enqueueTts: instead of reacting to live arrivals, it reacts to the moving
   * playhead and reads each note as it becomes the current head. The two paths
   * are mutually exclusive (this requires !isLive, #enqueueTts requires isLive)
   * so they never both push, and they share the same FIFO queue/drain machinery
   * — preserving order and the speaking indicator.
   *
   * The #lastPlayheadSpokenId marker keeps a note from being re-spoken on every
   * frame it remains the head; only a *change* of head enqueues new speech.
   */
  #speakPlayheadHead(): void {
    if (!this.ttsEnabled || !hasTts()) return;
    if (this.isLive) return; // live arrivals are handled by #enqueueTts
    const head = this.headNote;
    if (!head) return;
    if (head.id === this.#lastPlayheadSpokenId) return;
    // Record the head as handled even when muted, so unmuting later doesn't make
    // an already-passed note suddenly speak.
    this.#lastPlayheadSpokenId = head.id;
    if (this.mutedPubkeys.has(head.pubkey)) return; // permanently muted author
    this.#ttsQueue.push({ id: head.id, text: head.content });
    // Bound the backlog the same way live arrivals are bounded, so a fast
    // playback speed crossing many notes can't build an unbounded queue.
    if (this.#ttsQueue.length > TTS_QUEUE_MAX) {
      this.#ttsQueue.splice(0, this.#ttsQueue.length - TTS_QUEUE_MAX);
    }
    this.#drainTts();
  }

  /** Speak the next queued note, one utterance at a time. */
  #drainTts(): void {
    if (this.#ttsBusy) return;
    const next = this.#ttsQueue.shift();
    if (!next) return;
    this.#ttsBusy = true;
    const started = speak(next.text, {
      onStart: () => {
        this.speakingId = next.id;
      },
      onEnd: () => this.#finishTts(next.id),
      onError: () => this.#finishTts(next.id),
    });
    // Nothing was actually queued (empty after sanitize, or TTS unavailable):
    // no end callback will fire, so advance immediately. This is the fix for a
    // note being treated as "spoken" before speak() actually succeeded — an
    // unspeakable note no longer blocks the notes queued behind it.
    if (!started) {
      this.#ttsBusy = false;
      this.#drainTts();
    }
  }

  /** Mark the current utterance done and move on to the next queued note. */
  #finishTts(id: string): void {
    // Guard the clear so a stale callback for an old note doesn't wipe a newer one.
    if (this.speakingId === id) this.speakingId = null;
    this.#ttsBusy = false;
    this.#drainTts();
  }

  /**
   * Cancel speech and clear both the queue and the speaking indicator.
   * `speechSynthesis.cancel()` does not reliably fire `onend`, so we reset our
   * own state explicitly.
   */
  #stopSpeech(): void {
    cancelSpeech();
    this.#ttsQueue = [];
    this.#ttsBusy = false;
    this.speakingId = null;
    // Forget the playhead marker so a subsequent past-playback reads the head at
    // the new position fresh, rather than skipping it as "already spoken".
    this.#lastPlayheadSpokenId = null;
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
        // Advancing through the past: speak the note that just became current.
        this.#speakPlayheadHead();
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
    this.#stopSpeech();
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
    // Drop any past-playback speech (and its playhead marker) before jumping to
    // the live edge, so a half-read past note doesn't talk over fresh arrivals.
    this.#stopSpeech();
    this.isLive = true;
    this.isPlaying = true;
    this.playheadMs = Date.now();
  }

  /** Jump the playhead to an absolute epoch-ms; turns LIVE off and clamps. */
  seekTo(ms: number): void {
    const now = Date.now();
    this.isLive = false;
    this.#stopSpeech();
    this.playheadMs = clamp(ms, this.earliestMs, now);
    if (this.playheadMs >= now) {
      this.isLive = true;
    }
    this.#scheduleSave();
  }

  toggleTts(): void {
    this.ttsEnabled = !this.ttsEnabled;
    // Disabling cancels/clears anything queued or in flight. Enabling starts
    // fresh: only notes that arrive from now on are spoken (no backlog replay).
    if (!this.ttsEnabled) this.#stopSpeech();
  }

  /** Whether the given author (hex pubkey) is permanently muted for TTS. */
  isMuted(pubkey: string): boolean {
    return this.mutedPubkeys.has(pubkey);
  }

  /** Permanently mute an author's notes for TTS (persisted). No-op if already muted. */
  muteAuthor(pubkey: string): void {
    if (this.mutedPubkeys.has(pubkey)) return;
    const next = new Set(this.mutedPubkeys);
    next.add(pubkey);
    this.mutedPubkeys = next;
    this.#scheduleSave();
  }

  /** Un-mute a previously muted author (persisted). No-op if not muted. */
  unmuteAuthor(pubkey: string): void {
    if (!this.mutedPubkeys.has(pubkey)) return;
    const next = new Set(this.mutedPubkeys);
    next.delete(pubkey);
    this.mutedPubkeys = next;
    this.#scheduleSave();
  }

  /** Toggle an author's permanent TTS mute (persisted). */
  toggleMute(pubkey: string): void {
    if (this.mutedPubkeys.has(pubkey)) this.unmuteAuthor(pubkey);
    else this.muteAuthor(pubkey);
  }

  /** Choose a TTS voice by voiceURI, or null to use the Japanese auto-pick. */
  setVoice(uri: string | null): void {
    this.selectedVoiceURI = uri;
    setSelectedVoiceURI(uri);
    this.#scheduleSave();
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
    this.#stopSpeech();
    if (this.#voicesStop) {
      this.#voicesStop();
      this.#voicesStop = null;
    }
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
    if (this.#profileTimer !== null) {
      clearTimeout(this.#profileTimer);
      this.#profileTimer = null;
    }
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
