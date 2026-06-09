// Resolve a user's follow list (NIP-02 kind:3) and read relays (NIP-65 kind:10002).
import type { Event } from 'nostr-tools';
import { pool } from './pool';
import { BOOTSTRAP_RELAYS } from './relays';

export interface ResolvedFollows {
  /** Unique hex pubkeys this account follows. */
  authors: string[];
  /** Read relays declared in the account's NIP-65 relay list. */
  readRelays: string[];
}

/**
 * Fetch the account's NIP-65 read relays (kind:10002) and NIP-02 contacts
 * (kind:3). Defensive: any missing data yields empty arrays.
 */
export async function resolveFollows(pubkey: string): Promise<ResolvedFollows> {
  const readRelays: string[] = [];
  const authors: string[] = [];

  try {
    const [relayList, contacts] = await Promise.all([
      pool.querySync(BOOTSTRAP_RELAYS, { kinds: [10002], authors: [pubkey], limit: 1 }),
      pool.querySync(BOOTSTRAP_RELAYS, { kinds: [3], authors: [pubkey], limit: 1 }),
    ]);

    const newestRelayList = newest(relayList);
    if (newestRelayList) {
      const seen = new Set<string>();
      for (const tag of newestRelayList.tags) {
        if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue;
        const url = tag[1];
        // Third element may be 'read'/'write'; absent means both. We want read.
        const marker = tag[2];
        if (marker === 'write') continue;
        if (!seen.has(url)) {
          seen.add(url);
          readRelays.push(url);
        }
      }
    }

    const newestContacts = newest(contacts);
    if (newestContacts) {
      const seen = new Set<string>();
      for (const tag of newestContacts.tags) {
        if (tag[0] !== 'p' || typeof tag[1] !== 'string') continue;
        const pk = tag[1];
        if (!seen.has(pk)) {
          seen.add(pk);
          authors.push(pk);
        }
      }
    }
  } catch {
    // Network/parse failure -> caller falls back to LIMITED mode.
  }

  return { authors, readRelays };
}

function newest(events: Event[]): Event | undefined {
  let best: Event | undefined;
  for (const e of events) {
    if (!best || e.created_at > best.created_at) best = e;
  }
  return best;
}
