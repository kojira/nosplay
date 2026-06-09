// Publish a kind:1 text note via a NIP-07 signer (no private key handling).
import { pool } from './pool';
import type { EventTemplate, SignedEvent } from './types';

/** True when a NIP-07 extension (window.nostr) is available. */
export function hasNip07(): boolean {
  return typeof window !== 'undefined' && !!window.nostr;
}

/**
 * Sign a kind:1 note with window.nostr and publish it to the given write relays.
 * Resolves with the signed event on success. Throws a clear Error if no signer
 * is present, the content is empty, or every relay rejects the event.
 */
export async function publishNote(content: string, writeRelays: string[]): Promise<SignedEvent> {
  const text = content.trim();
  if (!text) throw new Error('Cannot post an empty note.');
  if (!hasNip07() || !window.nostr) {
    throw new Error('Install a NIP-07 extension to post.');
  }
  if (writeRelays.length === 0) {
    throw new Error('No write relays available to publish to.');
  }

  const template: EventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: text,
  };

  const signed = await window.nostr.signEvent(template);

  const results = await Promise.allSettled(pool.publish(writeRelays, signed));
  const accepted = results.some((r) => r.status === 'fulfilled');
  if (!accepted) {
    throw new Error('All relays rejected the note.');
  }

  return signed;
}
