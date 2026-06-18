// Image-URL extraction for kind:1 notes.
//
// First pass at "images are visible": given a Note (content + tags), find a
// single best image URL to preview. Three practical routes, in priority order:
//   1. NIP-92 `imeta` tags ("imeta", "url …", "m image/…", …)
//   2. NIP-94-style `url` tags, biased to accept when a sibling `m`/`mime`
//      tag declares an image/* type
//   3. Direct image URLs in the content text (http/https ending in a known
//      image extension, query/hash suffixes allowed)
// Only http/https URLs are ever returned, so nothing exotic (javascript:,
// data:, etc.) can slip through into an <img src>.
import type { Note } from './types';

/** Image file extensions we treat as previewable (checked on the URL path). */
const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|avif|bmp|svgz?)$/i;

/** Find http/https URLs in free text; stops at whitespace and common closers. */
const URL_RE = /https?:\/\/[^\s<>"'()]+/gi;

/** Return the canonical http/https URL for `raw`, or null if it isn't one. */
function asHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** True if the URL's path ends in a known image extension (query/hash ignored). */
function hasImageExt(url: string): boolean {
  try {
    return IMAGE_EXT_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Parse a NIP-92 `imeta` tag's space-delimited "key value" parts. */
function parseImeta(tag: string[]): { url?: string; mime?: string } {
  const out: { url?: string; mime?: string } = {};
  for (let i = 1; i < tag.length; i++) {
    const part = tag[i];
    const sp = part.indexOf(' ');
    if (sp === -1) continue;
    const key = part.slice(0, sp);
    const val = part.slice(sp + 1).trim();
    if (key === 'url' && out.url === undefined) out.url = val;
    else if ((key === 'm' || key === 'mime') && out.mime === undefined) out.mime = val;
  }
  return out;
}

/** Upper bound on previewable images per note, so a gallery post can't explode. */
const MAX_IMAGES = 4;

/**
 * All previewable image URLs for a note, in priority order and de-duplicated,
 * capped at MAX_IMAGES. Tags win over content; an image/* mime hint accepts a
 * URL even without a recognised image extension. The same three routes as
 * before, but now collecting *every* match instead of stopping at the first —
 * so multi-image (NIP-92 gallery, several content links) notes show more than
 * one thumbnail. Only http/https URLs are ever returned.
 */
export function getNoteImageUrls(note: Pick<Note, 'content' | 'tags'>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string | null): void => {
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };

  const tags = note.tags;
  if (tags) {
    // 1. NIP-92 imeta tags (one image per tag; a note may carry several).
    for (const tag of tags) {
      if (tag[0] !== 'imeta') continue;
      const { url, mime } = parseImeta(tag);
      if (!url) continue;
      const http = asHttpUrl(url);
      if (http && (hasImageExt(http) || mime?.startsWith('image/'))) push(http);
    }

    // 2. NIP-94-style url tags, biased by a sibling image/* mime tag.
    const mimeIsImage = tags.some(
      (t) => (t[0] === 'm' || t[0] === 'mime') && t[1]?.startsWith('image/'),
    );
    for (const tag of tags) {
      if (tag[0] !== 'url' || !tag[1]) continue;
      const http = asHttpUrl(tag[1]);
      if (http && (hasImageExt(http) || mimeIsImage)) push(http);
    }
  }

  // 3. Direct image URLs inside the content text (every occurrence).
  const matches = note.content.match(URL_RE);
  if (matches) {
    for (const m of matches) {
      const http = asHttpUrl(m);
      if (http && hasImageExt(http)) push(http);
    }
  }

  return out.slice(0, MAX_IMAGES);
}

/**
 * Best single image URL to preview for a note, or null when none is found.
 * Thin wrapper over getNoteImageUrls() preserved for existing callers.
 */
export function getNoteImageUrl(note: Pick<Note, 'content' | 'tags'>): string | null {
  return getNoteImageUrls(note)[0] ?? null;
}
