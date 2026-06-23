// Persist playback settings/state across sessions using IndexedDB (idb).
// Falls back silently when IndexedDB is unavailable (e.g. private mode / SSR).
import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'nosplay';
const STORE = 'kv';
const KEY = 'playback';
const DB_VERSION = 1;

/** The slice of timeline state we remember between sessions. */
export interface PlaybackState {
  windowMs: number;
  speed: number;
  ttsEnabled: boolean;
  /** Web Speech utterance rate for TTS playback. */
  ttsRate: number;
  /** User-selected TTS voice (voiceURI), or null for the Japanese auto-pick. */
  selectedVoiceURI: string | null;
  isLive: boolean;
  playheadMs: number;
  /** How manual relays combine with follow-derived ones ('auto' | 'merge' | 'manual'). */
  relayMode: 'auto' | 'merge' | 'manual';
  /** User-entered read relays (manual override / merge source). */
  manualRelays: string[];
  /** Whether to auto re-login via NIP-07 on the next session. */
  rememberLogin: boolean;
  /** Hex pubkeys whose notes are permanently muted for TTS. */
  mutedPubkeys: string[];
  /** Whether the AI (Gemini Nano) summary background is enabled. */
  aiBgEnabled: boolean;
  /** User-editable system prompt for the SVG model (applied on next model start). */
  aiSystemPrompt?: string;
  /** User-editable user-prompt template for the SVG model ({summary} placeholder). */
  aiUserPrompt?: string;
}

let dbp: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      },
    });
  }
  return dbp;
}

/** Load the saved playback state, or null if none / on any failure. */
export async function loadPlayback(): Promise<Partial<PlaybackState> | null> {
  try {
    const d = await db();
    const v = await d.get(STORE, KEY);
    return (v as Partial<PlaybackState> | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Strip any non-cloneable wrappers (e.g. Svelte $state proxies) so the value
 * is safe for structuredClone / IndexedDB. A JSON round-trip yields plain
 * objects, arrays, and primitives — which is exactly the shape PlaybackState is.
 */
function toPlain(state: PlaybackState): PlaybackState {
  return JSON.parse(JSON.stringify(state)) as PlaybackState;
}

/** Persist the given playback state. Best-effort; swallows errors. */
export async function savePlayback(state: PlaybackState): Promise<void> {
  try {
    const d = await db();
    // Serialize to plain data first: collections like manualRelays may be
    // Svelte state proxies, which IndexedDB cannot structuredClone.
    await d.put(STORE, toPlain(state), KEY);
  } catch (err) {
    // best effort — settings persistence is non-essential
    if (import.meta.env?.DEV) console.warn('[persist] savePlayback failed', err);
  }
}
