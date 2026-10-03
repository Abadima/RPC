// Fetches the real MAL-Sync and Discord-RPC-Extension into the cache that
// `malsync:real` reads (scripts/e2e/real-extensions.mjs). Needs the network.

import { cacheDir, fetchRealExtensions } from "./e2e/real-extensions.mjs";

await fetchRealExtensions();
console.log(`cached in ${cacheDir}`);
