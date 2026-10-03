import type { Activity, ActivityInfo } from "./activity";

/** Discord takes an image of at most this many UTF-16 units; Desktop and the app's mapping drop a longer one. */
export const MAX_IMAGE = 256;

/**
 * Whether Discord can show `value` as an image: an `https` address within the
 * limit, or a short asset key of the Discord Application it's shown as.
 * Anything else is dropped further on, and Discord then shows the
 * Application's own icon (Parousia's logo, for every Activity without an
 * Application of its own).
 */
export function isShowableImage(value: string | undefined): value is string {
  if (!value) return false;
  if (/^https:\/\//i.test(value)) return value.length <= MAX_IMAGE;
  return /^[\w-]{1,64}$/.test(value);
}

/**
 * A tab's favicon as an Activity image: `https`, no credentials, no query
 * string or fragment (nothing but the icon's own address leaves the browser),
 * and not a format Discord can't be relied on to show.
 */
export function faviconImage(value: string | undefined): string | undefined {
  if (!value || value.length > MAX_IMAGE * 2) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (/\.(svg|ico)$/i.test(url.pathname)) return undefined;
    url.search = "";
    url.hash = "";
    return isShowableImage(url.href) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `activity` with a large image Discord can show. Its own stays when it can be
 * shown (a song's artwork, a channel's picture); otherwise the matched
 * website's logo (the Activity's icon), then its favicon, whichever is
 * reliable. With neither, a large image that couldn't be shown is left out
 * rather than sent to be dropped, and Discord's Application icon shows.
 */
export function withSiteImage(
  activity: Activity,
  info: Pick<ActivityInfo, "icon">,
  favicon?: string,
): Activity {
  const own = activity.assets?.largeImage;
  if (isShowableImage(own)) return activity;
  const image = isShowableImage(info.icon) ? info.icon : faviconImage(favicon);
  if (!image && own === undefined) return activity;
  const { largeImage: _dropped, ...assets } = activity.assets ?? {};
  const next = image ? { ...assets, largeImage: image } : assets;
  const { assets: _old, ...rest } = activity;
  return Object.keys(next).length > 0 ? { ...rest, assets: next } : rest;
}
