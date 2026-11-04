import type { ActivityStatus } from "./activity-catalog";

/** What the popup shows: what's being shared, the tab's site Activity's state, or nothing about the site. */
export type Sharing = "nothing" | "default" | "activity";
/** `none`: nothing about the site. `note`: its Activity is on, and nothing is shared. `offer`: a card to turn it on, or to say why it can't run. */
export type SiteOffer = "none" | "note" | "offer";

/**
 * What the popup says about the tab's site Activity. The Default Activity is
 * shared on a site with nothing running there, so it keeps the offer: the
 * site's Activity is still the one to turn on. Only a site Activity that's
 * being shared hides it.
 */
export function siteOffer(sharing: Sharing, status: ActivityStatus | null): SiteOffer {
  if (status === null || sharing === "activity") return "none";
  return sharing === "nothing" && status === "on" ? "note" : "offer";
}
