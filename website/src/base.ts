/**
 * The site's base path with a trailing slash. `import.meta.env.BASE_URL` has
 * none when `base` is set without one, as the Pages deploy does (`/RPC`), so
 * `${BASE_URL}pwa/` would become `/RPCpwa/`.
 */
export const BASE = import.meta.env.BASE_URL.replace(/\/?$/, "/");
