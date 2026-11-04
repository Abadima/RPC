import type { ActivityStatus } from "./activity-catalog";

/**
 * What's being shared: nothing; something that isn't the tab's own Activity
 * (the Default Activity, or music or video kept from another tab); or the
 * tab's own.
 */
export type Sharing = "nothing" | "other" | "activity";
/** `none`: nothing about the site. `note`: its Activity is on, and nothing is shared. `offer`: a card to turn it on, or to say why it can't run. */
export type SiteOffer = "none" | "note" | "offer";

/**
 * What the popup says about the tab's site Activity. Something else is shared
 * on a site with nothing running there, so it keeps the offer: the site's
 * Activity is still the one to turn on, and Show media presence stays as it
 * is. Only the tab's own Activity being shared hides it.
 */
export function siteOffer(sharing: Sharing, status: ActivityStatus | null): SiteOffer {
  if (status === null || sharing === "activity") return "none";
  return sharing === "nothing" && status === "on" ? "note" : "offer";
}
