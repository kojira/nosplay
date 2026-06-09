// Shared Nostr types for the nosplay logic core.

/** A minimal text-note (kind:1) representation used by the timeline. */
export interface Note {
  id: string;
  pubkey: string;
  /** Event creation time in UNIX SECONDS (as per the Nostr protocol). */
  created_at: number;
  content: string;
  tags?: string[][];
}

/** Template passed to a NIP-07 signer when creating an event. */
export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** A fully-signed Nostr event (subset we care about). */
export interface SignedEvent extends EventTemplate {
  id: string;
  pubkey: string;
  sig: string;
}

/** NIP-07 browser extension interface. */
export interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<SignedEvent>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

export {};
