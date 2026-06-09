// Shared SimplePool singleton. Constructing this does not open any sockets;
// connections are opened lazily on the first subscribe/query/publish call.
import { SimplePool } from 'nostr-tools/pool';

export const pool = new SimplePool();
