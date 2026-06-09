// Well-known public relays and example public author pubkeys.
// All relays are widely-used public Nostr relays; all author pubkeys below are
// public, well-known accounts used here only as real fallback example authors.

export const BOOTSTRAP_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
];

export const FALLBACK_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.wine',
  'wss://relay.snort.social',
];

// Public, well-known active accounts (hex pubkeys) used as real fallback authors.
export const FALLBACK_AUTHORS: string[] = [
  '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d', // fiatjaf
  '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2', // jack
  '32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245', // jb55
  '04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9', // odell
  'e88a691e98d9987c964521dff60025f60700378a4879180dcbbb4a5027850411', // NVK
];
