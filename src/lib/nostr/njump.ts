// njump.me deep-links for individual events.
//
// njump (https://njump.me) is a web viewer for Nostr events: given a bech32
// `note1…` identifier it renders that specific note. We build the link from a
// raw event id by encoding it with nostr-tools' NIP-19 helper (never by hand),
// so only valid 64-hex ids produce a URL and the encoding stays spec-correct.
import { nip19 } from 'nostr-tools';

/** Encode a raw hex event id to its NIP-19 `note1…` form, or null if invalid. */
export function noteIdToNote1(id: string): string | null {
  try {
    return nip19.noteEncode(id);
  } catch {
    // noteEncode throws on a malformed (non 32-byte hex) id.
    return null;
  }
}

/**
 * The njump.me URL that opens a specific event, e.g.
 * `https://njump.me/note1…`, or null when the id can't be encoded.
 */
export function njumpUrl(id: string): string | null {
  const note1 = noteIdToNote1(id);
  return note1 ? `https://njump.me/${note1}` : null;
}
