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

/** Persist the given playback state. Best-effort; swallows errors. */
export async function savePlayback(state: PlaybackState): Promise<void> {
  try {
    const d = await db();
    await d.put(STORE, state, KEY);
  } catch {
    // best effort — settings persistence is non-essential
  }
}
