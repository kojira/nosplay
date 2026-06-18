// THE SINGLE SOURCE OF UI STATE for nosplay.
// A Svelte 5 runes module exporting a singleton `timeline`.
// Constructing the singleton opens NO sockets; call connect() (e.g. onMount).
import { untrack } from 'svelte';
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
import {
  isSummarizerSupported,
  summarizerAvailability,
  createSummarizer,
  type SummarizerInstance,
} from '../ai/summarizer';
import { inspectSvg } from '../ai/sanitize';
import {
  isLanguageModelSupported,
  languageModelAvailability,
  createSvgModel,
  promptSvg,
  DEFAULT_SVG_SYSTEM_PROMPT,
  DEFAULT_SVG_USER_PROMPT,
  type LanguageModelInstance,
  type LanguageModelAvailability,
} from '../ai/prompt';

export type Status = 'idle' | 'connecting' | 'live' | 'limited' | 'error';
export type Mode = 'follows' | 'limited';

/**
 * Lifecycle/availability of the AI summary background. The background is drawn
 * ONLY from SVG that Gemini Nano (the Prompt API / LanguageModel) generates
 * directly — there is no fallback — so the status reflects that generator:
 *  - 'off'           the feature is disabled
 *  - 'unsupported'   this browser has no built-in AI Prompt API (LanguageModel)
 *  - 'unavailable'   API present but the on-device model can't run
 *  - 'downloadable'  enabling will trigger a model download (needs a click)
 *  - 'downloading'   the on-device model is being fetched (progress %)
 *  - 'ready'         model live, waiting for / between generations
 *  - 'summarizing'   condensing the visible feed text for the SVG prompt
 *  - 'generating'    Gemini Nano is generating the background SVG right now
 *  - 'summary-empty' nothing meaningful to draw from the visible feed
 *  - 'invalid-svg'   the model returned markup that failed strict validation
 *  - 'error'         creating the model or generating the SVG failed
 */
export type AiBgStatus =
  | 'off'
  | 'unsupported'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'ready'
  | 'summarizing'
  | 'generating'
  | 'summary-empty'
  | 'invalid-svg'
  | 'error';

/** How the last background was produced. Direct Gemini-Nano SVG, or nothing. */
export type AiRenderMode = 'direct-svg' | 'none';

/**
 * Debug snapshot of the LAST summarization run, surfaced in the UI and logged to
 * the console so it's obvious where a given AI background came from and why the
 * feature is (or isn't) drawing. Purely diagnostic — never persisted, and reset
 * when the feature is turned off. All times are epoch ms (0 = "never").
 */
export interface AiBgDebug {
  /** Epoch ms of the last summarization attempt (success, empty, or skip). */
  lastRunAt: number;
  /** Epoch ms of the last run that actually produced a summary. */
  lastSummaryAt: number;
  /** Visible window edges at the last run: [start .. end] (playhead). */
  windowStartMs: number;
  windowEndMs: number;
  /** Notes inside the visible window at the last run. */
  visibleCount: number;
  /** Notes actually fed to the summarizer (after the AI_MAX_NOTES cap). */
  summarizedCount: number;
  /** created_at span of the summarized slice (epoch ms), 0 when none. */
  sliceStartMs: number;
  sliceEndMs: number;
  /** Characters of feed text fed to the summarizer. */
  inputChars: number;
  /** True when the feed text was clipped to the AI_MAX_CHARS budget. */
  inputTruncated: boolean;
  /** Characters of the resulting summary text. */
  summaryChars: number;
  /** Characters of the validated SVG actually shown (0 when none). */
  svgChars: number;
  /** Characters of the RAW model output before validation (0 when none). */
  rawSvgChars: number;
  /** How the last background was produced: direct Gemini-Nano SVG, or none. */
  renderMode: AiRenderMode;

  // ---- Gemini Nano direct-SVG generator (the Prompt API / LanguageModel) ----
  /** Whether this browser exposes the Prompt API (LanguageModel) at all. */
  promptApiSupported: boolean;
  /** Last known on-device model availability ('unsupported'/'unknown' before checked). */
  promptApiAvailability: LanguageModelAvailability | 'unsupported' | 'unknown';
  /** Whether the direct-SVG generator session is live this session. */
  svgModelReady: boolean;
  /** True when the last shown background came from Gemini-Nano direct SVG. */
  directSvgUsed: boolean;
  /** Whether the last generated SVG passed strict validation/sanitization. */
  svgValid: boolean;
  /** Human-readable reason for the last failure ('' when none). */
  failureReason: string;
  /** True when there was too little text to summarize on the last run. */
  notEnoughText: boolean;
  /** Extra characters of feed text needed to clear AI_MIN_CHARS (0 when met). */
  charsNeeded: number;

  // ---- DOM / layer verification (measured by Timeline.svelte) ----------
  // These describe whether the generated SVG actually made it onto the page
  // and can be seen, as opposed to merely existing as a string in the store.
  // Set via reportAiBgDom() after each render; 0/''/false until measured.
  /** True when an <svg> element for the AI background was found in the DOM. */
  domInserted: boolean;
  /** outerHTML length of the inserted <svg>, or 0 when none was found. */
  domSvgChars: number;
  /** viewBox attribute read off the inserted <svg> ('' when absent). */
  viewBox: string;
  /** Measured pixel size of the .ai-bg layer (rounded; 0 before layout). */
  domWidth: number;
  domHeight: number;
  /** Computed opacity of the .ai-bg layer (0..1; 0 means invisible). */
  opacity: number;
  /** Computed z-index of the .ai-bg layer as a string ('auto' / number). */
  zIndex: string;
  /** Epoch ms of the last DOM measurement (0 = never measured). */
  domCheckedAt: number;
}

/** One DOM measurement of the rendered AI background, or null when absent. */
export interface AiBgDomMeasurement {
  inserted: boolean;
  svgChars: number;
  viewBox: string;
  width: number;
  height: number;
  opacity: number;
  zIndex: string;
}

/**
 * A plain YES/NO verdict on the AI background, derived from a debug snapshot.
 * The whole point is to answer "is SVG generation actually working?" without
 * having to eyeball a dozen fields: `svgGenerated` is the generation answer,
 * `visible` is the end-to-end answer (generated AND on-screen), and `reasons`
 * lists every blocker so a NO is self-explanatory.
 */
export interface AiBgVerdict {
  /** A non-empty SVG string was produced on the last render. */
  svgGenerated: boolean;
  /** An <svg> for it was found in the DOM. */
  domInserted: boolean;
  /** The layer has non-zero size and non-zero opacity (so it can show). */
  layered: boolean;
  /** End-to-end: enabled AND generated AND inserted AND layered. */
  visible: boolean;
  /** Human-readable blockers; empty array when everything checks out. */
  reasons: string[];
}

/**
 * Reduce a debug snapshot to a YES/NO verdict. Pure (no reactive reads) so it
 * can be used both in the console logger and in a `$derived` in the UI.
 */
export function aiBgVerdict(
  debug: AiBgDebug,
  svg: string,
  enabled: boolean,
): AiBgVerdict {
  // A non-empty, validated SVG that Gemini Nano generated directly.
  const svgGenerated =
    svg.length > 0 && debug.svgChars > 0 && debug.svgValid && debug.directSvgUsed;
  const domInserted = debug.domInserted;
  const layered =
    debug.domWidth > 0 && debug.domHeight > 0 && debug.opacity > 0;
  const visible = enabled && svgGenerated && domInserted && layered;

  const reasons: string[] = [];
  if (!enabled) reasons.push('feature toggled off');
  if (!svgGenerated) {
    if (!debug.promptApiSupported)
      reasons.push('Prompt API (LanguageModel) not supported in this browser');
    else if (debug.promptApiAvailability === 'unavailable')
      reasons.push('on-device Gemini Nano model unavailable');
    else if (debug.notEnoughText)
      reasons.push(`not enough text (need ~${debug.charsNeeded} more chars)`);
    else if (debug.failureReason) reasons.push(debug.failureReason);
    else if (debug.lastRunAt === 0) reasons.push('no generation run yet');
    else reasons.push('no SVG produced');
  } else {
    if (!domInserted)
      reasons.push('SVG not inserted into the DOM (no <svg> element found)');
    else {
      if (debug.domWidth === 0 || debug.domHeight === 0)
        reasons.push('background layer has zero size');
      if (debug.opacity === 0) reasons.push('layer opacity is 0');
    }
  }
  return { svgGenerated, domInserted, layered, visible, reasons };
}

/** Best-effort human-readable message from a thrown value. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** A fresh, empty debug snapshot (feature off / never run). */
function emptyAiBgDebug(): AiBgDebug {
  return {
    lastRunAt: 0,
    lastSummaryAt: 0,
    windowStartMs: 0,
    windowEndMs: 0,
    visibleCount: 0,
    summarizedCount: 0,
    sliceStartMs: 0,
    sliceEndMs: 0,
    inputChars: 0,
    inputTruncated: false,
    summaryChars: 0,
    svgChars: 0,
    rawSvgChars: 0,
    renderMode: 'none',
    promptApiSupported: false,
    promptApiAvailability: 'unknown',
    svgModelReady: false,
    directSvgUsed: false,
    svgValid: false,
    failureReason: '',
    notEnoughText: false,
    charsNeeded: 0,
    domInserted: false,
    domSvgChars: 0,
    viewBox: '',
    domWidth: 0,
    domHeight: 0,
    opacity: 0,
    zIndex: '',
    domCheckedAt: 0,
  };
}

/** Explicit NIP-07 login lifecycle, surfaced in the UI. */
export type LoginState = 'logged-out' | 'logging-in' | 'logged-in' | 'login-error';

/** How the manual read-relay list combines with the follow-derived (NIP-65) list. */
export type RelayMode = 'auto' | 'merge' | 'manual';

/** Lifecycle of the follow (kind:3 / kind:10002) resolution. */
export type FollowStatus = 'idle' | 'resolving' | 'ready' | 'empty' | 'error';

const MAX_NOTES = 5000;
const DEFAULT_WINDOW_MS = 300_000; // 5 minutes
const HISTORY_LIMIT = 500;
/**
 * Safety cap on how many older-history pages the deep-jump FALLBACK may fetch
 * before giving up, so an unreachable target (or a relay that keeps returning
 * full pages) can never loop forever. The primary deep-jump path is now a single
 * bounded target-range query (see #fetchTargetRange); this `until`-only paging
 * loop only runs as a fallback when that range comes back empty (a sparse slice
 * for these authors), to land the jump at the nearest available older notes.
 */
const DEEP_HISTORY_MAX_ROUNDS = 20;
/**
 * Extra backfill BEFORE the visible window when fetching a deep-jump target
 * range. The visible window is `[target - windowMs, target]`; we widen the
 * query's `since` by this margin so a few notes that predate the window are
 * loaded too. That keeps `earliestMs` at/below `target - windowMs` (so the
 * window's left edge has notes anchoring it rather than abruptly ending at the
 * oldest fetched note) and gives the left-edge anchoring something to bite on.
 */
const TARGET_RANGE_ANCHOR_MS = DEFAULT_WINDOW_MS; // one extra window of backfill
const LIVE_GLOBAL_LIMIT = 200;
/** Max live notes buffered for TTS; older ones are dropped during a flood. */
const TTS_QUEUE_MAX = 50;

// ---- AI summary background tuning ----
/** Heartbeat: re-summarize the visible feed at most this often (interval). */
const AI_INTERVAL_MS = 30_000;
/** Floor between two summaries, so a context change can't trigger churn. */
const AI_MIN_GAP_MS = 12_000;
/** Cap how many recent visible notes / chars we feed the summarizer. */
const AI_MAX_NOTES = 40;
const AI_MAX_CHARS = 4000;
/** Don't bother summarizing fewer than this many characters of feed text. */
const AI_MIN_CHARS = 80;
/**
 * Max times we re-prompt Gemini Nano for the SVG in a single generation when the
 * output is a model-FORMATTING miss (code fences / prose around the markup, or
 * no <svg> at all). This is NOT a fallback and never weakens the validator: each
 * attempt's raw output is run through the same strict inspectSvg(). Genuine
 * validation failures (disallowed/unsafe content) are non-retryable and stop at
 * once. Counts the first try, so 3 = at most two re-prompts.
 */
const AI_SVG_MAX_ATTEMPTS = 3;

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
  /**
   * True while a deep-past jump is paging older history from the relays (see
   * jumpTo / ensureHistoryFor). Surfaced in the UI so the Jump control can show
   * progress and reject overlapping jumps.
   */
  historyLoading = $state<boolean>(false);
  names = $state<Map<string, ProfileMeta>>(new Map());
  error = $state<string | null>(null);

  // ---- AI summary background (Chrome built-in AI / Gemini Nano) ----
  /** User toggle for the AI summary background. Persisted across sessions. */
  aiBgEnabled = $state<boolean>(false);
  /** Lifecycle/availability for the UI status line. */
  aiBgStatus = $state<AiBgStatus>('off');
  /** Model download progress 0..1 while aiBgStatus === 'downloading'. */
  aiBgProgress = $state<number>(0);
  /** Latest AI-generated summary text of the visible feed, or '' when none. */
  aiBgSummary = $state<string>('');
  /** SVG markup derived from aiBgSummary, rendered as the faint background. */
  aiBgSvg = $state<string>('');
  /**
   * Diagnostic snapshot of the last summarization run (source range, counts,
   * char budget, render mode, scene). Surfaced in the AI debug panel and logged
   * to the console. Runtime-only; reset when the feature is turned off.
   */
  aiBgDebug = $state<AiBgDebug>(emptyAiBgDebug());
  /** System prompt for the SVG model. Editable from the UI; applied on next
   *  model start. Persisted across sessions. */
  aiSystemPrompt = $state<string>(DEFAULT_SVG_SYSTEM_PROMPT);
  /** User-prompt template for the SVG model ({summary} is replaced with the
   *  feed text). Editable from the UI; applied live. Persisted across sessions. */
  aiUserPrompt = $state<string>(DEFAULT_SVG_USER_PROMPT);

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

  /**
   * Cheap signature of the *set* of visible notes (count + first/last id). It
   * changes only when notes enter/leave the window, NOT on every animation frame
   * (playheadMs ticks but the visible set is usually unchanged), so an effect
   * keyed on this value fires on meaningful context change rather than per-frame.
   */
  aiContextSig = $derived.by<string>(() => {
    const v = this.visibleNotes;
    if (v.length === 0) return '';
    return `${v.length}:${v[0].id}:${v[v.length - 1].id}`;
  });

  // ---- internal (non-reactive) ----
  #ids = new Set<string>();
  #subs: SubCloser[] = [];
  #raf: number | null = null;
  #lastFrame = 0;
  /**
   * FIFO queue of notes awaiting speech, drained one at a time. Each entry
   * carries its author (pubkey) so mute can be re-checked at drain time, not
   * only when the note was enqueued.
   */
  #ttsQueue: { id: string; pubkey: string; text: string }[] = [];
  /** The note currently in flight (set at drain, cleared on finish), or null. */
  #current: { id: string; pubkey: string } | null = null;
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

  // ---- AI summary background (non-reactive) ----
  /**
   * Optional Summarizer session (Gemini Nano), used to condense the visible feed
   * text before it is handed to the SVG generator. Best-effort: when null we
   * send the trimmed feed text directly. Never the background generator itself.
   */
  #summarizer: SummarizerInstance | null = null;
  /**
   * The Prompt API (LanguageModel / Gemini Nano) session that generates the
   * background SVG markup DIRECTLY, or null when unavailable. This is the only
   * source of the background — there is no fallback. When it is null, or when
   * its output fails strict validation, no background is shown.
   */
  #svgModel: LanguageModelInstance | null = null;
  /** Heartbeat interval handle for periodic re-summarization. */
  #aiTimer: ReturnType<typeof setInterval> | null = null;
  /** Disposes the $effect that reacts to context changes. */
  #aiEffectStop: (() => void) | null = null;
  /** Epoch ms of the last summary, for throttling (AI_MIN_GAP_MS). */
  #aiLastAt = 0;
  /** Signature of the last summarized input, so identical text is skipped. */
  #aiLastInput = '';
  /** True while a summarize() call is in flight (prevents overlap). */
  #aiBusy = false;
  /** Guards against a stale start() resolving after the user toggled off. */
  #aiRunId = 0;

  // ---- persistence (IndexedDB via persist.ts) ----
  #persistReady = false; // true once persistence init has started (reentrancy guard)
  #hydrated = false; // true only after saved state (incl. mutedPubkeys) is applied
  #persistStop: (() => void) | null = null; // disposes the save effect
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingPlayheadMs: number | null = null; // paused playhead awaiting history load
  // A view range from a share link (?start=&end=), applied during connect() so
  // it overrides persisted playback. Epoch ms; either bound may be undefined.
  #pendingShare: { startMs?: number; endMs?: number } | null = null;

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
    // If the AI background was left on last session, try to resume it (no user
    // gesture here, so a model download may need a re-toggle — handled inside).
    void this.#resumeAiBackgroundIfEnabled();
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
      // Now that earliestMs reflects real history, settle the restored playhead
      // (fetching deeper history first if it lands before the loaded range).
      await this.#applyPendingPlayhead();
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
      if (typeof saved.aiBgEnabled === 'boolean') {
        this.aiBgEnabled = saved.aiBgEnabled;
      }
      if (typeof saved.aiSystemPrompt === 'string') {
        this.aiSystemPrompt = saved.aiSystemPrompt;
      }
      if (typeof saved.aiUserPrompt === 'string') {
        this.aiUserPrompt = saved.aiUserPrompt;
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

    // A share link (?start=&end=) overrides any persisted playback: end becomes
    // the playhead and end-start becomes the window, so the link reproduces the
    // captured range. Window applies now (history-independent); the playhead is
    // re-clamped after history loads, like the restored paused playhead above.
    const share = this.#pendingShare;
    if (share) {
      this.#pendingShare = null;
      const { startMs, endMs } = share;
      if (
        typeof startMs === 'number' &&
        typeof endMs === 'number' &&
        endMs - startMs >= 1000
      ) {
        this.windowMs = endMs - startMs;
      }
      // Right edge = end if given, else the start time (a bare jump target).
      const target = typeof endMs === 'number' ? endMs : startMs;
      if (typeof target === 'number') {
        this.isLive = false;
        this.isPlaying = false;
        this.#pendingPlayheadMs = target;
        this.playheadMs = target; // provisional; re-clamped post-history
      }
    }

    // Saved state (including mutedPubkeys) is now fully applied; TTS may run.
    this.#hydrated = true;

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
        void this.aiBgEnabled;
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

  /**
   * Persist the current settings slice immediately, cancelling any pending
   * debounced save. Used for state the user must not lose on a quick refresh
   * (e.g. TTS mute/unmute): the async IDB write is kicked off right away instead
   * of after the 400ms debounce, so a reload moments later cannot drop it.
   */
  #saveNow(): void {
    if (!this.#persistReady) return;
    if (this.#saveTimer !== null) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    void savePlayback(this.#snapshot());
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
      aiBgEnabled: this.aiBgEnabled,
      aiSystemPrompt: this.aiSystemPrompt,
      aiUserPrompt: this.aiUserPrompt,
    };
  }

  /** Apply a restored paused playhead once real history (earliestMs) is known. */
  async #applyPendingPlayhead(): Promise<void> {
    if (this.#pendingPlayheadMs === null) return;
    const ms = this.#pendingPlayheadMs;
    this.#pendingPlayheadMs = null;
    // If the user already went LIVE or seeked during the await, leave their
    // choice alone.
    if (this.isLive) return;
    const now = Date.now();
    // The restored/shared target predates the loaded history (the initial fetch
    // only grabs the newest page). Sit there provisionally — so the note cap
    // keeps the target region, not the live tail — and fetch the target-range
    // slice before clamping, exactly like an explicit jumpTo.
    if (ms < this.earliestMs) {
      this.isPlaying = false;
      this.playheadMs = clamp(ms, 0, now);
      await this.ensureHistoryFor(ms);
      if (this.isLive) return; // user went LIVE mid-fetch
    }
    this.playheadMs = clamp(ms, this.earliestMs, now);
    // Mirror seekTo: a target at/beyond now means "follow live" — relevant for
    // share links whose end is the current edge (a restored paused playhead is
    // always in the past, so this never flips it).
    if (this.playheadMs >= now) {
      this.isLive = true;
      this.isPlaying = true;
    } else {
      // A shared/restored window can be sparse or empty; settle on the nearest
      // real notes instead of freezing on a blank span.
      this.#anchorPlayheadToVisibleNote();
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

    // Insert keeping ascending order by (created_at, id). created_at is only
    // second-precise, so same-second notes would otherwise land in arrival
    // order, which differs run-to-run; breaking ties by the (stable, unique)
    // event id gives a deterministic left-to-right and lane assignment order so
    // the horizontal layout reads the same every time.
    const arr = this.notes;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = arr[mid];
      const before =
        m.created_at < note.created_at ||
        (m.created_at === note.created_at && m.id < note.id);
      if (before) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, note);

    // Cap the buffer. Drop notes from whichever edge is FARTHER from the
    // playhead, so the notes around the current view always survive — including a
    // deep-past jump target whose freshly-fetched batch is the oldest in the
    // array. When live or near the live edge (the common case) the playhead sits
    // at the new edge, so this drops the oldest, exactly as before.
    if (arr.length > MAX_NOTES) {
      const overflow = arr.length - MAX_NOTES;
      const head = this.playheadMs;
      const oldestMs = arr[0].created_at * 1000;
      const newestMs = arr[arr.length - 1].created_at * 1000;
      const removed =
        newestMs - head > head - oldestMs
          ? // Playhead nearer the old edge (paused in the past): drop the newest.
            arr.splice(arr.length - overflow, overflow)
          : // Playhead at/near the live edge (normal/live): drop the oldest.
            arr.splice(0, overflow);
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
    if (!this.#hydrated) return; // never speak before mutedPubkeys is restored
    if (!this.#ttsLive || !this.isLive) return;
    if (this.mutedPubkeys.has(note.pubkey)) return; // permanently muted author
    this.#ttsQueue.push({ id: note.id, pubkey: note.pubkey, text: note.content });
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
    if (!this.#hydrated) return; // never speak before mutedPubkeys is restored
    if (this.isLive) return; // live arrivals are handled by #enqueueTts
    const head = this.headNote;
    if (!head) return;
    if (head.id === this.#lastPlayheadSpokenId) return;
    // Record the head as handled even when muted, so unmuting later doesn't make
    // an already-passed note suddenly speak.
    this.#lastPlayheadSpokenId = head.id;
    if (this.mutedPubkeys.has(head.pubkey)) return; // permanently muted author
    this.#ttsQueue.push({ id: head.id, pubkey: head.pubkey, text: head.content });
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
    // Re-check mute at drain time: an author muted after a note was queued must
    // still be silenced, so skip (drop) any queued notes now from muted authors.
    let next = this.#ttsQueue.shift();
    while (next && this.mutedPubkeys.has(next.pubkey)) {
      next = this.#ttsQueue.shift();
    }
    if (!next) return;
    this.#ttsBusy = true;
    this.#current = next;
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
      this.#current = null;
      this.#drainTts();
    }
  }

  /** Mark the current utterance done and move on to the next queued note. */
  #finishTts(id: string): void {
    // Ignore stale callbacks (e.g. a late onend from an utterance we cancelled
    // when muting) that no longer match the note currently in flight.
    if (!this.#current || this.#current.id !== id) return;
    if (this.speakingId === id) this.speakingId = null;
    this.#current = null;
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
    this.#current = null;
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

  /**
   * Stage a shared view range to apply on the next connect(). Call before
   * connect() so it overrides persisted playback; the playhead is clamped into
   * the loaded range once history arrives. start/end are epoch ms (either may be
   * undefined). No-op once connect() has consumed the staged range.
   */
  applyShareRange(opts: { startMs?: number; endMs?: number }): void {
    this.#pendingShare = opts;
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

  /**
   * Load the history needed to render a deep-past jump target.
   *
   * The playhead is the RIGHT edge of the visible window, so a jump to `targetMs`
   * needs the slice `[target - windowMs, target]` (plus a little backfill before
   * it). Rather than paging the newest notes downward from the live tail, we
   * issue ONE bounded query that asks the relays directly for that slice:
   *
   *   { kinds:[1], authors, since: target - windowMs - anchor, until: target }
   *
   * so a jump to e.g. 2023 fetches the 2023 window in a single round — the
   * `since` bound makes the relays return notes inside the target window instead
   * of the 500 newest notes that merely happen to precede `until`. Events are
   * appended via addNote (dedup + sorted insert), which leaves `earliestMs` at
   * the oldest fetched note (at/below `target - windowMs` thanks to the anchor)
   * so the window's left edge is anchored coherently.
   *
   * Fallback: if that bounded slice is empty (the authors posted nothing in that
   * span), fall back to the older-only paging loop so the jump still lands at the
   * nearest available older notes instead of snapping to the live tail.
   *
   * No-op when the loaded range already reaches the target.
   */
  async ensureHistoryFor(targetMs: number): Promise<void> {
    if (this.earliestMs <= targetMs) return;
    const authors = this.mode === 'follows' ? this.#followAuthors : FALLBACK_AUTHORS;
    if (authors.length === 0) return; // nothing to query against
    const relays = this.activeReadRelays;

    this.historyLoading = true;
    try {
      const got = await this.#fetchTargetRange(targetMs, authors, relays);
      // If the direct slice yielded nothing AND we still haven't reached the
      // target, the window around `target` is empty for these authors. Fall back
      // to paging older notes so the jump lands at the nearest available point.
      if (!got && this.earliestMs > targetMs) {
        await this.#fetchOlderUntil(targetMs, authors, relays);
      }
    } finally {
      this.historyLoading = false;
    }
  }

  /**
   * Fetch the visible-window slice for a jump target in one bounded query and add
   * the events. Returns true if any events came back.
   *
   * The `until` bound is the target itself; the `since` bound is the window's
   * left edge widened by TARGET_RANGE_ANCHOR_MS, so the result covers
   * `[target - windowMs - anchor, target]`. Caller owns the historyLoading flag.
   */
  async #fetchTargetRange(
    targetMs: number,
    authors: string[],
    relays: string[],
  ): Promise<boolean> {
    const sinceMs = targetMs - this.windowMs - TARGET_RANGE_ANCHOR_MS;
    let events: Event[];
    try {
      events = await pool.querySync(relays, {
        kinds: [1],
        authors,
        since: Math.max(0, Math.floor(sinceMs / 1000)),
        until: Math.floor(targetMs / 1000),
        limit: HISTORY_LIMIT,
      });
    } catch {
      return false; // relay error: keep whatever we already have
    }
    for (const e of events) this.addNote(e);
    return events.length > 0;
  }

  /**
   * Fallback for an empty target slice: page older history (`until`-only) until
   * the oldest loaded note is at or before `targetMs`, the relays run dry, or the
   * safety round cap is hit. Used only when #fetchTargetRange found nothing in the
   * window, so a deep jump into a sparse span still lands near real notes rather
   * than snapping to the live tail. Caller owns the historyLoading flag.
   */
  async #fetchOlderUntil(
    targetMs: number,
    authors: string[],
    relays: string[],
  ): Promise<void> {
    // Seconds-precision upper bound; query notes at/older than the target.
    let until = Math.floor(targetMs / 1000);
    for (let round = 0; round < DEEP_HISTORY_MAX_ROUNDS; round++) {
      if (this.earliestMs <= targetMs || until <= 0) break;
      let events: Event[];
      try {
        events = await pool.querySync(relays, {
          kinds: [1],
          authors,
          until,
          limit: HISTORY_LIMIT,
        });
      } catch {
        break; // relay error: keep whatever we already have
      }
      if (events.length === 0) break; // nothing older exists

      const before = this.earliestMs;
      let oldest = until;
      for (const e of events) {
        this.addNote(e);
        if (e.created_at < oldest) oldest = e.created_at;
      }
      // A short page means the relays have no more older notes for these
      // authors; no point asking again.
      if (events.length < HISTORY_LIMIT) break;
      // No forward progress (every event was a duplicate) — avoid a tight loop.
      if (this.earliestMs >= before) break;
      // Page further back, strictly older than the oldest event seen.
      until = oldest - 1;
    }
  }

  /**
   * After a deep jump / shared-range restore settles the playhead, the loaded
   * notes nearest the target can all fall *before* the visible window's left
   * edge, leaving `[playhead - windowMs, playhead]` empty. This happens when the
   * requested span is sparse: either #fetchTargetRange came back empty and the
   * fallback paged to much-older notes, or the slice only yielded notes in the
   * TARGET_RANGE_ANCHOR_MS backfill margin below the visible window. Left as-is
   * the timeline would freeze on a blank window. Pull the playhead back onto the
   * most recent note at/behind it so that note sits at the window's right edge
   * and any surrounding context fills in behind it.
   *
   * No-op when the current window already contains a note (preserves the exact
   * landing for the common, non-sparse case) or when nothing is loaded.
   */
  #anchorPlayheadToVisibleNote(): void {
    const arr = this.notes;
    if (arr.length === 0) return;
    const head = this.playheadMs;
    // Binary search for the latest note at/behind the playhead. notes is sorted
    // ascending by created_at, so this is the upper-bound index minus one.
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].created_at * 1000 <= head) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return; // nothing at/behind the playhead (can't happen post-clamp)
    const nearestMs = arr[lo - 1].created_at * 1000;
    // Already visible (within [head - windowMs, head])? leave the landing alone.
    if (nearestMs >= head - this.windowMs) return;
    // Sparse window: settle on the nearest prior note so it's actually shown.
    this.playheadMs = nearestMs;
  }

  /**
   * Seek to an absolute epoch-ms, fetching deeper history first when the target
   * predates the loaded range. Unlike seekTo (which clamps into the currently
   * loaded range), this is the path for an explicit Jump to an arbitrary past
   * moment: it issues a direct target-range query (via ensureHistoryFor) for the
   * slice around the target's visible window, then settles there paused. Targets
   * at/after the loaded edge behave exactly like seekTo, so LIVE catch-up is
   * preserved.
   */
  async jumpTo(ms: number): Promise<void> {
    const now = Date.now();
    // Future / at-now / within loaded range: identical to a plain seek.
    if (ms >= this.earliestMs) {
      this.seekTo(ms);
      return;
    }
    // Deep past: settle at the target provisionally (so the note cap keeps the
    // target region while paging), load history, then clamp into the now-wider
    // range. Paused so the rAF clock doesn't drift the playhead during the fetch.
    this.isLive = false;
    this.isPlaying = false;
    this.#stopSpeech();
    this.playheadMs = clamp(ms, 0, now);
    await this.ensureHistoryFor(ms);
    this.playheadMs = clamp(ms, this.earliestMs, now);
    if (this.playheadMs >= now) {
      this.isLive = true;
      this.isPlaying = true;
    } else {
      // The requested window may be sparse/empty; settle on real notes so the
      // jump lands on something visible rather than a frozen blank window.
      this.#anchorPlayheadToVisibleNote();
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
    // Take effect immediately, not just for future arrivals: drop this author's
    // already-queued utterances...
    this.#ttsQueue = this.#ttsQueue.filter((q) => q.pubkey !== pubkey);
    // ...and cut off their note if it is the one being spoken right now, then
    // move on to the next queued note. (A late onend from the cancelled
    // utterance is ignored by #finishTts via the #current guard.)
    if (this.#current?.pubkey === pubkey) {
      cancelSpeech();
      this.speakingId = null;
      this.#current = null;
      this.#ttsBusy = false;
      this.#drainTts();
    }
    this.#saveNow();
  }

  /** Un-mute a previously muted author (persisted). No-op if not muted. */
  unmuteAuthor(pubkey: string): void {
    if (!this.mutedPubkeys.has(pubkey)) return;
    const next = new Set(this.mutedPubkeys);
    next.delete(pubkey);
    this.mutedPubkeys = next;
    this.#saveNow();
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
  // AI summary background (Chrome built-in AI / Gemini Nano)
  // ============================================================
  /**
   * Toggle the AI summary background. MUST be reachable from a user gesture so
   * enabling can trigger the on-device model download — the Summarizer spec
   * requires transient activation for the first create(). Enabling brings the
   * summarizer online and starts the heartbeat; disabling tears it all down but
   * keeps the user's choice (persisted via aiBgEnabled).
   */
  async toggleAiBackground(): Promise<void> {
    this.aiBgEnabled = !this.aiBgEnabled;
    if (this.aiBgEnabled) {
      await this.#startAiBackground();
    } else {
      this.#stopAiBackground();
    }
  }

  /**
   * On restore: if the user left the feature on last session, try to resume it.
   * There is no user gesture here, so a model *download* may be refused — that's
   * fine; #startAiBackground surfaces the state and the user can re-toggle to
   * grant activation. If the model is already present this resumes seamlessly.
   */
  async #resumeAiBackgroundIfEnabled(): Promise<void> {
    if (!this.aiBgEnabled) return;
    await this.#startAiBackground();
  }

  /**
   * Bring the Gemini-Nano SVG generator (Prompt API / LanguageModel) online and
   * start the heartbeat + context-change effect. This generator is the ONLY
   * source of the background — there is no fallback — so we gate on it directly:
   * if the Prompt API is unsupported or the model is unavailable, we surface that
   * and draw nothing. The Summarizer is brought up separately, best-effort, only
   * to condense the prompt input. Never throws to the caller; every failure mode
   * lands in aiBgStatus + aiBgDebug.failureReason. Leaves aiBgEnabled untouched.
   */
  async #startAiBackground(): Promise<void> {
    const runId = ++this.#aiRunId;
    this.#teardownAiSession(); // drop any previous session first

    const supported = isLanguageModelSupported();
    this.aiBgDebug = {
      ...this.aiBgDebug,
      promptApiSupported: supported,
      promptApiAvailability: supported ? 'unknown' : 'unsupported',
      svgModelReady: false,
      directSvgUsed: false,
      svgValid: false,
      failureReason: '',
    };
    if (!supported) {
      this.aiBgStatus = 'unsupported';
      this.aiBgDebug = {
        ...this.aiBgDebug,
        failureReason:
          'Chrome built-in AI Prompt API (LanguageModel) is not available in ' +
          'this browser, so no AI background can be generated.',
      };
      return;
    }

    const avail = await languageModelAvailability();
    if (runId !== this.#aiRunId) return; // toggled off while awaiting
    this.aiBgDebug = { ...this.aiBgDebug, promptApiAvailability: avail };
    if (avail === 'unavailable') {
      this.aiBgStatus = 'unavailable';
      this.aiBgDebug = {
        ...this.aiBgDebug,
        failureReason:
          'The on-device Gemini Nano model is unavailable on this device, so ' +
          'no AI background can be generated.',
      };
      return;
    }

    this.aiBgProgress = 0;
    this.aiBgStatus =
      avail === 'downloadable' || avail === 'downloading' ? 'downloading' : 'ready';
    try {
      const model = await createSvgModel((frac) => {
        if (runId !== this.#aiRunId) return;
        this.aiBgProgress = frac;
        this.aiBgStatus = frac >= 1 ? 'ready' : 'downloading';
      }, this.aiSystemPrompt);
      if (runId !== this.#aiRunId) {
        // Toggled off during create(): discard the freshly made session.
        try {
          model.destroy();
        } catch {
          // ignore
        }
        return;
      }
      this.#svgModel = model;
      this.aiBgStatus = 'ready';
      this.aiBgProgress = 1;
      this.aiBgDebug = { ...this.aiBgDebug, svgModelReady: true };
    } catch (err) {
      if (runId !== this.#aiRunId) return;
      // create() refused — most often a missing user gesture for the download,
      // or the model failing to initialize. Surface it; the toggle can retry.
      this.aiBgStatus = 'error';
      this.aiBgDebug = {
        ...this.aiBgDebug,
        failureReason:
          'Could not start the Gemini Nano SVG generator: ' + errMessage(err),
      };
      return;
    }

    // Best-effort, non-blocking: bring up the Summarizer to condense the feed
    // text we feed the SVG prompt. When absent we send trimmed text directly;
    // its absence never blocks the (working) background generator.
    void this.#initSummarizer(runId);

    // Heartbeat: periodic refresh even when the visible set is stable.
    this.#aiTimer = setInterval(() => void this.#maybeSummarize(), AI_INTERVAL_MS);
    // React to meaningful context changes (notes entering/leaving the window).
    // Both paths are throttled inside #maybeSummarize so they never spam create.
    this.#aiEffectStop = $effect.root(() => {
      $effect(() => {
        void this.aiContextSig; // track; act on change
        // #maybeSummarize() reads reactive state (aiBgDebug, visibleNotes,
        // playheadMs, windowMs) and then WRITES aiBgDebug. In Svelte runes,
        // reads inside a function called from an effect are tracked by that
        // effect, so without untrack the write to aiBgDebug would re-trigger
        // this effect → a self-sustaining loop (effect_update_depth_exceeded).
        // We only want to react to aiContextSig changes, so run the call
        // untracked: its internal reads/writes don't become dependencies.
        if (this.#svgModel) untrack(() => void this.#maybeSummarize());
      });
      return () => {};
    });
  }

  /**
   * Best-effort: bring up the optional Summarizer (Gemini Nano) session used to
   * condense the visible feed before it is handed to the SVG generator. To avoid
   * a second large download surprise we only create it when the on-device model
   * is already 'available'; otherwise the SVG prompt simply receives the trimmed
   * raw text. Never touches aiBgStatus — the background generator is independent.
   */
  async #initSummarizer(runId: number): Promise<void> {
    if (!isSummarizerSupported()) return;
    try {
      const avail = await summarizerAvailability();
      if (runId !== this.#aiRunId) return; // toggled off while awaiting
      if (avail !== 'available') return; // don't trigger a model download here
      const summarizer = await createSummarizer();
      if (runId !== this.#aiRunId) {
        try {
          summarizer.destroy();
        } catch {
          // ignore
        }
        return;
      }
      this.#summarizer = summarizer;
      console.info('[nosplay/ai-bg] Summarizer ready (condensing feed text for the SVG prompt)');
    } catch {
      this.#summarizer = null; // optional; send trimmed raw text instead
      console.info('[nosplay/ai-bg] Summarizer unavailable — sending trimmed feed text to the SVG generator');
    }
  }

  /**
   * Generate the background by asking Gemini Nano (the Prompt API) for SVG markup
   * DIRECTLY, then strictly validating/sanitizing it. There is NO fallback: if no
   * model session exists, generation throws, or the markup fails validation, this
   * returns an empty SVG with a reason and the caller draws nothing. `valid` is
   * true only for markup that both came from the model AND passed validation.
   *
   * Retries (up to AI_SVG_MAX_ATTEMPTS) ONLY a model-FORMATTING miss — when the
   * raw output is empty, has no <svg> block at all, or wraps the markup in prose
   * / code fences — since a re-prompt can plausibly fix that. The retry decision
   * comes straight from inspectSvg() (stage + prefix/suffix noise); it never
   * weakens the validator. A genuine validation failure (disallowed element/
   * attribute, unsafe value, malformed XML, too large/many) is NOT a formatting
   * miss — re-prompting won't make it safe — so it stops immediately. The first
   * successful, validated output stops the loop at once.
   */
  async #generateBackgroundSvg(
    summary: string,
  ): Promise<{ svg: string; valid: boolean; rawChars: number; reason: string }> {
    if (!this.#svgModel) {
      return {
        svg: '',
        valid: false,
        rawChars: 0,
        reason: 'Gemini Nano SVG generator is not available.',
      };
    }

    let lastReason = '';
    let lastRawChars = 0;
    for (let attempt = 1; attempt <= AI_SVG_MAX_ATTEMPTS; attempt++) {
      let raw: string;
      try {
        raw = await promptSvg(this.#svgModel, summary, undefined, this.aiUserPrompt);
      } catch (err) {
        // A thrown prompt (aborted / model error) isn't a formatting miss we can
        // re-prompt our way out of — stop without retrying.
        return {
          svg: '',
          valid: false,
          rawChars: 0,
          reason:
            'SVG generation failed: ' +
            errMessage(err) +
            (attempt > 1 ? ` (after ${attempt} attempts)` : ''),
        };
      }

      const result = inspectSvg(raw);
      if (result.ok) {
        // Success — stop immediately.
        return { svg: result.svg, valid: true, rawChars: raw.length, reason: '' };
      }

      // Make the runtime reason precise: the failure stage plus, when the model
      // wrapped the <svg> in prose, how much of the raw output was actually the
      // SVG block and on which side the noise sat.
      const noise =
        result.hasPrefixNoise || result.hasSuffixNoise
          ? ` (extracted ${result.extractedLength} of ${result.rawLength} chars; ` +
            `${[result.hasPrefixNoise ? 'leading' : '', result.hasSuffixNoise ? 'trailing' : '']
              .filter(Boolean)
              .join('+')} text around <svg>)`
          : '';
      lastReason = `Generated SVG failed validation [${result.stage}]: ${result.reason}${noise}`;
      lastRawChars = raw.length;

      // Classify straight from inspectSvg: a formatting miss (empty output, no
      // <svg> at all, or prose/code fences around the markup) is worth a
      // re-prompt; anything else is a real validation failure and stops now.
      const retryable =
        result.stage === 'empty' ||
        result.stage === 'no-svg-found' ||
        result.hasPrefixNoise ||
        result.hasSuffixNoise;
      if (!retryable) {
        return { svg: '', valid: false, rawChars: raw.length, reason: lastReason };
      }
      // Retryable formatting miss: loop again if attempts remain.
    }

    // Exhausted every attempt on retryable formatting misses — no fallback, so
    // report the last failure and note how many tries it took.
    return {
      svg: '',
      valid: false,
      rawChars: lastRawChars,
      reason: `${lastReason} (gave up after ${AI_SVG_MAX_ATTEMPTS} attempts)`,
    };
  }

  /**
   * Collect a trimmed, recent slice of visible note text for summarization,
   * along with the metadata the debug panel needs: how many notes were visible
   * vs actually used, the created_at span of the used slice, and whether the
   * text was clipped to the char budget.
   */
  #collectVisibleSlice(): {
    text: string;
    visibleCount: number;
    usedCount: number;
    sliceStartMs: number;
    sliceEndMs: number;
    truncated: boolean;
  } {
    const notes = this.visibleNotes;
    const empty = {
      text: '',
      visibleCount: notes.length,
      usedCount: 0,
      sliceStartMs: 0,
      sliceEndMs: 0,
      truncated: false,
    };
    if (notes.length === 0) return empty;
    const recent = notes.slice(-AI_MAX_NOTES);
    const used = recent
      .map((n) => ({ ms: n.created_at * 1000, text: n.content.replace(/\s+/g, ' ').trim() }))
      .filter((n) => n.text.length > 0);
    if (used.length === 0) return { ...empty, visibleCount: notes.length };
    let text = used.map((n) => n.text).join('\n');
    // Keep the most recent tail if we're over the char budget.
    const truncated = text.length > AI_MAX_CHARS;
    if (truncated) text = text.slice(text.length - AI_MAX_CHARS);
    return {
      text,
      visibleCount: notes.length,
      usedCount: used.length,
      sliceStartMs: used[0].ms,
      sliceEndMs: used[used.length - 1].ms,
      truncated,
    };
  }

  /**
   * Condense the visible feed (best-effort, via the Summarizer) and regenerate
   * the background by asking Gemini Nano for SVG markup DIRECTLY — but only when
   * worth it: skips when disabled / no SVG model / already running, when there is
   * too little text, when the input is unchanged since last time, or when called
   * again within AI_MIN_GAP_MS (throttle). This is what keeps the feature from
   * churning despite a per-frame timeline and a 30s heartbeat. There is NO
   * fallback: a generation/validation failure clears the background and records
   * the reason rather than drawing anything.
   */
  async #maybeSummarize(): Promise<void> {
    if (!this.aiBgEnabled || !this.#svgModel || this.#aiBusy) return;
    const slice = this.#collectVisibleSlice();
    const now = Date.now();
    // Snapshot the source metadata on EVERY run (even ones we skip below) so the
    // debug panel always reflects what the current window looks like.
    const base: AiBgDebug = {
      ...this.aiBgDebug,
      lastRunAt: now,
      windowStartMs: this.playheadMs - this.windowMs,
      windowEndMs: this.playheadMs,
      visibleCount: slice.visibleCount,
      summarizedCount: slice.usedCount,
      sliceStartMs: slice.sliceStartMs,
      sliceEndMs: slice.sliceEndMs,
      inputChars: slice.text.length,
      inputTruncated: slice.truncated,
      svgModelReady: this.#svgModel !== null,
    };

    if (slice.text.length < AI_MIN_CHARS) {
      // Not enough text to summarize — make that explicit for the debug panel
      // rather than failing silently.
      this.aiBgDebug = {
        ...base,
        notEnoughText: true,
        charsNeeded: AI_MIN_CHARS - slice.text.length,
      };
      return;
    }
    this.aiBgDebug = { ...base, notEnoughText: false, charsNeeded: 0 };

    if (slice.text === this.#aiLastInput) return; // unchanged content
    if (now - this.#aiLastAt < AI_MIN_GAP_MS) return; // throttle churn

    this.#aiBusy = true;
    this.#aiLastAt = now;
    this.#aiLastInput = slice.text;
    const runId = this.#aiRunId;
    try {
      // Condense the feed text for the SVG prompt when the Summarizer is up;
      // otherwise hand the trimmed raw text straight to the generator.
      let summary = slice.text;
      if (this.#summarizer) {
        this.aiBgStatus = 'summarizing';
        summary = (await this.#summarizer.summarize(slice.text)).trim();
        if (runId !== this.#aiRunId) return; // stopped/restarted meanwhile
      }
      this.aiBgSummary = summary;
      if (!summary) {
        // Nothing meaningful to draw from — clear the background, say so.
        this.aiBgSvg = '';
        this.aiBgStatus = 'summary-empty';
        this.aiBgDebug = {
          ...this.aiBgDebug,
          summaryChars: 0,
          svgChars: 0,
          rawSvgChars: 0,
          renderMode: 'none',
          directSvgUsed: false,
          svgValid: false,
          failureReason: 'Summary came back empty — nothing to draw.',
        };
        return;
      }

      // Ask Gemini Nano for the SVG directly, then strictly validate it.
      this.aiBgStatus = 'generating';
      const { svg, valid, rawChars, reason } =
        await this.#generateBackgroundSvg(summary);
      if (runId !== this.#aiRunId) return; // stopped/restarted while generating

      if (valid) {
        this.aiBgSvg = svg;
        this.aiBgStatus = 'ready';
        this.aiBgDebug = {
          ...this.aiBgDebug,
          lastSummaryAt: Date.now(),
          summaryChars: summary.length,
          svgChars: svg.length,
          rawSvgChars: rawChars,
          renderMode: 'direct-svg',
          directSvgUsed: true,
          svgValid: true,
          failureReason: '',
        };
      } else {
        // No fallback: drop any previous background and record exactly why.
        this.aiBgSvg = '';
        // A validation failure (model returned markup, but it was unsafe) is
        // distinct from a generation failure (the model never produced usable
        // markup), so the status line can tell the user which happened.
        this.aiBgStatus = rawChars > 0 ? 'invalid-svg' : 'error';
        this.aiBgDebug = {
          ...this.aiBgDebug,
          summaryChars: summary.length,
          svgChars: 0,
          rawSvgChars: rawChars,
          renderMode: 'none',
          directSvgUsed: false,
          svgValid: false,
          failureReason: reason,
        };
        console.warn('[nosplay/ai-bg] direct SVG not shown —', reason);
      }
      // The structured console log is emitted from reportAiBgDom() once the
      // Timeline view has measured where this SVG landed in the DOM, so the
      // logged `dom` evidence matches the SVG that was just set above.
    } catch (err) {
      if (runId !== this.#aiRunId) return;
      this.aiBgSvg = '';
      this.aiBgStatus = 'error';
      this.aiBgDebug = {
        ...this.aiBgDebug,
        renderMode: 'none',
        directSvgUsed: false,
        svgValid: false,
        failureReason: 'AI background failed: ' + errMessage(err),
      };
      // Allow a retry on the next change/heartbeat rather than wedging on this text.
      this.#aiLastInput = '';
      console.warn('[nosplay/ai-bg] summarize/generate failed', err);
    } finally {
      this.#aiBusy = false;
    }
  }

  /**
   * Log a structured snapshot of the last AI background run to the console.
   * Always on (not DEV-gated) — the whole point is to make the feature easy to
   * inspect in any build. The headline line answers the only question that
   * matters at a glance — "is SVG generation working?" — as a literal YES/NO,
   * and the attached object groups the supporting evidence (generation, DOM
   * insertion + layering, source slice) so a NO is self-explanatory. The full
   * generated SVG markup rides along under `svg` so it can be copied straight
   * out of the console — kept inside the same object (not a separate log) so the
   * output stays a single collapsible group rather than a wall of lines.
   *
   * Called from reportAiBgDom() (the DOM-verification phase) so the logged
   * `dom` fields reflect the SVG that was actually measured on the page, not a
   * stale prior render. `phase` notes what triggered the log.
   */
  #logAiDebug(phase: 'render' | 'cleared' | 'toggle'): void {
    const d = this.aiBgDebug;
    const v = aiBgVerdict(d, this.aiBgSvg, this.aiBgEnabled);
    console.info(
      `[nosplay/ai-bg] Gemini Nano direct SVG: ${d.directSvgUsed ? 'YES' : 'NO'} · ` +
        `valid: ${d.svgValid ? 'YES' : 'NO'} · ` +
        `on screen: ${v.visible ? 'YES' : 'NO'}` +
        (d.failureReason ? ` · ${d.failureReason}` : '') +
        (v.reasons.length ? ` · ${v.reasons.join('; ')}` : ''),
      {
        phase,
        verdict: v,
        status: this.aiBgStatus,
        generation: {
          renderMode: d.renderMode,
          promptApiSupported: d.promptApiSupported,
          promptApiAvailability: d.promptApiAvailability,
          svgModelReady: d.svgModelReady,
          directSvgUsed: d.directSvgUsed,
          svgValid: d.svgValid,
          failureReason: d.failureReason,
          summaryChars: d.summaryChars,
          rawSvgChars: d.rawSvgChars,
          svgChars: d.svgChars,
        },
        dom: {
          inserted: d.domInserted,
          svgChars: d.domSvgChars,
          viewBox: d.viewBox,
          width: d.domWidth,
          height: d.domHeight,
          opacity: d.opacity,
          zIndex: d.zIndex,
          checkedAt: d.domCheckedAt,
        },
        source: {
          visibleCount: d.visibleCount,
          summarizedCount: d.summarizedCount,
          inputChars: d.inputChars,
          inputTruncated: d.inputTruncated,
          windowMs: { start: d.windowStartMs, end: d.windowEndMs },
          sliceMs: { start: d.sliceStartMs, end: d.sliceEndMs },
        },
        lastRunAt: d.lastRunAt,
        lastSummaryAt: d.lastSummaryAt,
        summary: this.aiBgSummary,
        // Full generated markup, alongside generation.svgChars (its length), so
        // the exact SVG can be inspected/copied from the console.
        svg: this.aiBgSvg,
      },
    );
  }

  /**
   * Record where the rendered SVG ended up in the DOM, as measured by the
   * Timeline view after Svelte flushes each `aiBgSvg` change. This is what lets
   * the debug verdict distinguish "SVG generated but not on screen" from
   * "generated and visible". Pass null when the layer is absent (feature off,
   * no SVG, or the element isn't mounted). Also emits the structured console
   * log, so the log always carries fresh DOM evidence.
   */
  reportAiBgDom(m: AiBgDomMeasurement | null): void {
    const prev = this.aiBgDebug;
    const next = {
      domInserted: m?.inserted ?? false,
      domSvgChars: m?.svgChars ?? 0,
      viewBox: m?.viewBox ?? '',
      domWidth: m?.width ?? 0,
      domHeight: m?.height ?? 0,
      opacity: m?.opacity ?? 0,
      zIndex: m?.zIndex ?? '',
    };
    // Idempotency guard. This runs from a Timeline `$effect`, and the spread of
    // `prev` below reads aiBgDebug — which makes aiBgDebug a tracked dependency
    // of that effect. Writing a *fresh* object every call (the old behaviour,
    // where domCheckedAt: Date.now() guaranteed inequality) therefore re-dirtied
    // the effect and re-ran it without end → effect_update_depth_exceeded. When
    // the DOM measurement hasn't actually changed we must NOT write, so the
    // effect settles. domCheckedAt is intentionally excluded from the compare
    // (a re-measure with identical results is not a meaningful change).
    const unchanged =
      prev.domInserted === next.domInserted &&
      prev.domSvgChars === next.domSvgChars &&
      prev.viewBox === next.viewBox &&
      prev.domWidth === next.domWidth &&
      prev.domHeight === next.domHeight &&
      prev.opacity === next.opacity &&
      prev.zIndex === next.zIndex;
    if (unchanged) return;
    this.aiBgDebug = {
      ...prev,
      ...next,
      domCheckedAt: m ? Date.now() : 0,
    };
    // Only log meaningful transitions: a rendered SVG (m present) or the layer
    // going away while the feature is still on (cleared). Skip the null report
    // that fires merely because the feature was toggled off — #stopAiBackground
    // resets everything and the panel reflects it.
    if (m) this.#logAiDebug('render');
    else if (this.aiBgEnabled) this.#logAiDebug('cleared');
  }

  /** Stop the feature: tear down the session and clear all derived output. */
  #stopAiBackground(): void {
    this.#aiRunId++; // invalidate any in-flight start()/summarize()
    this.#teardownAiSession();
    this.aiBgStatus = 'off';
    this.aiBgProgress = 0;
    this.aiBgSummary = '';
    this.aiBgSvg = '';
    this.aiBgDebug = emptyAiBgDebug();
    this.#aiLastInput = '';
    this.#aiLastAt = 0;
  }

  /** Dispose the timer, context effect, and summarizer session (idempotent). */
  #teardownAiSession(): void {
    if (this.#aiTimer !== null) {
      clearInterval(this.#aiTimer);
      this.#aiTimer = null;
    }
    if (this.#aiEffectStop) {
      this.#aiEffectStop();
      this.#aiEffectStop = null;
    }
    if (this.#summarizer) {
      try {
        this.#summarizer.destroy();
      } catch {
        // ignore
      }
      this.#summarizer = null;
    }
    if (this.#svgModel) {
      try {
        this.#svgModel.destroy();
      } catch {
        // ignore
      }
      this.#svgModel = null;
    }
    this.#aiBusy = false;
  }

  // ============================================================
  // Teardown
  // ============================================================
  disconnect(): void {
    this.stop();
    this.#stopSpeech();
    this.#stopAiBackground();
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
    this.#hydrated = false; // re-gate TTS until the next connect re-hydrates
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
