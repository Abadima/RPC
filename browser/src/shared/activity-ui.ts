import type { ActivityInfo } from "../core/activity";
import { el } from "./settings-view";

/**
 * An Activity's icon: its image once it loads, its first letter until then,
 * or for good if there's no image or it doesn't load. The image is fetched
 * lazily, without a referrer, only for the cards on screen.
 */
export function activityIcon(info: ActivityInfo): HTMLElement {
  const tile = el("span", "tile tile-letter activity-icon");
  tile.setAttribute("aria-hidden", "true");
  tile.dataset.icon = "letter";
  tile.append(el("span", "activity-letter", info.name.charAt(0)));
  if (info.icon?.startsWith("https://")) {
    const image = el("img", "activity-image");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.width = image.height = 40;
    image.addEventListener("load", () => {
      tile.dataset.icon = "image";
    });
    image.addEventListener("error", () => image.remove());
    image.src = info.icon;
    tile.append(image);
  }
  return tile;
}
