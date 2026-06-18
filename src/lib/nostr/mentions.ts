// Legacy NIP-08 (`#[i]`) mention rendering.
//
// Before NIP-27's inline bech32 mentions, kind:1 notes referenced other events
// and profiles *positionally*: the content carried a `#[i]` token and the tag
// at index `i` was the actual reference — `["e", <event-id>]` for a note or
// `["p", <pubkey>]` for a profile. Modern clients resolve these; a raw `#[0]`
// left in the text is meaningless to a reader and, worse, its odd glyphs throw
// off the timeline's single-line width estimate (so cards mis-reserve lane
// space and overlap). This module rewrites those tokens into a compact,
// human-meaningful label so the timeline neither shows `#[0]` nor mis-measures
// it. Pure + typed: no Svelte/DOM deps, safe to unit test.
import { nip19 } from 'nostr-tools';

/** Matches a legacy positional reference token, capturing the tag index. */
const LEGACY_REF = /#\[(\d+)\]/g;

/** Shorten a bech32 identifier to `prefix1abcd…wxyz` for compact inline display. */
function shortBech32(b: string): string {
  return b.length > 18 ? `${b.slice(0, 12)}…${b.slice(-4)}` : b;
}

/** Last-resort short label when a value can't be bech32-encoded (malformed). */
function shortHex(hex: string): string {
  return hex.length > 10 ? `${hex.slice(0, 8)}…` : hex;
}

/**
 * Human-meaningful label for a single referenced tag, or null when the tag is
 * absent or not a kind we render inline (so the caller can keep the raw token).
 * `e` tags become `[mention: note1…]`, `p` tags become `[mention: npub1…]`,
 * each derived from the tag's value via NIP-19; a value that won't encode
 * degrades to a short hex label rather than throwing.
 */
function labelForTag(tag: string[] | undefined): string | null {
  if (!tag || tag.length < 2) return null;
  const kind = tag[0];
  const value = tag[1];
  if (!value) return null;
  if (kind === 'e') {
    try {
      return `[mention: ${shortBech32(nip19.noteEncode(value))}]`;
    } catch {
      return `[mention: ${shortHex(value)}]`;
    }
  }
  if (kind === 'p') {
    try {
      return `[mention: ${shortBech32(nip19.npubEncode(value))}]`;
    } catch {
      return `[mention: ${shortHex(value)}]`;
    }
  }
  return null;
}

/**
 * Rewrite legacy `#[i]` positional references in a note's content into compact
 * mention labels, using the note's tags to resolve each index. A token is only
 * replaced when `tags[i]` exists and is an `e`/`p` reference; out-of-range,
 * malformed, or unknown-kind references are left as the raw token so nothing is
 * silently lost and the function never throws. When there is nothing to do
 * (no tags, or no `#[` in the content) the original string is returned as-is.
 */
export function formatNoteContent(content: string, tags?: string[][]): string {
  if (!content || !tags || tags.length === 0 || !content.includes('#[')) {
    return content;
  }
  return content.replace(LEGACY_REF, (raw, idx: string) => {
    const i = Number(idx);
    const label = Number.isInteger(i) ? labelForTag(tags[i]) : null;
    return label ?? raw;
  });
}
