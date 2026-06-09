// Optional display-name resolution from kind:0 metadata events.
import type { Event } from 'nostr-tools';
import { pool } from './pool';

export interface ProfileMeta {
  name?: string;
  /** Avatar image URL from the kind:0 `picture` field, if present. */
  picture?: string;
}

/**
 * Fetch kind:0 metadata for the given authors and return a map of
 * pubkey -> { name, picture }. Defensive: malformed JSON is ignored.
 */
export async function fetchProfiles(
  authors: string[],
  relays: string[],
): Promise<Map<string, ProfileMeta>> {
  const out = new Map<string, ProfileMeta>();
  if (authors.length === 0 || relays.length === 0) return out;

  try {
    const events = await pool.querySync(relays, { kinds: [0], authors, limit: authors.length });
    // Keep only the newest kind:0 per pubkey.
    const newestByPk = new Map<string, Event>();
    for (const e of events) {
      const prev = newestByPk.get(e.pubkey);
      if (!prev || e.created_at > prev.created_at) newestByPk.set(e.pubkey, e);
    }
    for (const [pk, e] of newestByPk) {
      try {
        const parsed = JSON.parse(e.content) as {
          name?: unknown;
          display_name?: unknown;
          displayName?: unknown;
          picture?: unknown;
        };
        // Prefer an explicit display name, fall back to the handle.
        const displayName =
          typeof parsed.display_name === 'string' && parsed.display_name.trim()
            ? parsed.display_name
            : typeof parsed.displayName === 'string' && parsed.displayName.trim()
              ? parsed.displayName
              : undefined;
        const handle =
          typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : undefined;
        const name = displayName ?? handle;
        const picture =
          typeof parsed.picture === 'string' && /^https?:\/\//i.test(parsed.picture)
            ? parsed.picture
            : undefined;
        out.set(pk, { name, picture });
      } catch {
        // ignore malformed metadata
      }
    }
  } catch {
    // ignore network failures; names are non-essential
  }

  return out;
}
