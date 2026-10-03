import type { ConnectionState } from "../core/desktop-connection";
import { t } from "../core/i18n";
import type { PreferenceArea } from "../core/preferences";
import { DESKTOP_DOWNLOAD } from "./links";

/**
 * What to tell someone whose Parousia Desktop and extension work together but
 * aren't the same release (core/version.ts): which side is behind, and a
 * choice to ignore it. Dismissing is remembered for that pair of versions, so
 * the next release of either side asks again.
 */
export interface UpdateNotice {
  /** The pair of versions it's about, to remember a dismissal by. */
  key: string;
  title: string;
  detail: string;
  /** Where to get the update, when it's a download. */
  href?: string;
  action?: string;
}

const STORAGE_KEY = "dismissedUpdate";

export function updateNotice(
  state: ConnectionState,
  extensionVersion: string,
): UpdateNotice | null {
  if (state.status !== "connected" || !state.update || !state.desktopVersion) return null;
  const key = `${state.update}:${extensionVersion}:${state.desktopVersion}`;
  return state.update === "desktop"
    ? {
        key,
        title: t("A newer Parousia Desktop is available"),
        detail: t(
          "This extension is newer than Parousia Desktop {version}. They still work together; update Desktop to get everything the extension offers.",
          { version: state.desktopVersion },
        ),
        href: DESKTOP_DOWNLOAD,
        action: t("Update Parousia Desktop"),
      }
    : {
        key,
        title: t("A newer Parousia extension is available"),
        detail: t(
          "Parousia Desktop {version} is newer than this extension. They still work together; update the extension from your browser's extension page.",
          { version: state.desktopVersion },
        ),
      };
}

export async function loadDismissedUpdate(
  area: PreferenceArea = chrome.storage.local,
): Promise<string | null> {
  const stored = (await area.get(STORAGE_KEY))[STORAGE_KEY];
  return typeof stored === "string" ? stored : null;
}

export async function dismissUpdate(
  key: string,
  area: PreferenceArea = chrome.storage.local,
): Promise<void> {
  await area.set({ [STORAGE_KEY]: key });
}

/**
 * Shows `notice` in `banner` (an element with a `[data-help]` body, as the
 * connection help uses), or hides it. A link to the update, if there is one,
 * and "Not now", which hides it and remembers.
 */
export function renderUpdateNotice(
  banner: HTMLElement,
  notice: UpdateNotice | null,
  dismissed: string | null,
  onDismiss: (key: string) => void,
): void {
  const body = banner.querySelector("[data-help]");
  banner.hidden = !notice || notice.key === dismissed || !body;
  if (!notice || banner.hidden || !body) return;
  const title = document.createElement("p");
  title.className = "banner-title";
  title.textContent = notice.title;
  const detail = document.createElement("p");
  detail.className = "banner-detail";
  detail.textContent = notice.detail;
  body.replaceChildren(title, detail);

  const actions = document.createElement("div");
  actions.className = "banner-actions";
  if (notice.href && notice.action) {
    const link = document.createElement("a");
    link.className = "button";
    link.href = notice.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = notice.action;
    actions.append(link);
  }
  const later = document.createElement("button");
  later.className = "link-button";
  later.type = "button";
  later.textContent = t("Not now");
  later.addEventListener("click", () => onDismiss(notice.key));
  actions.append(later);
  banner.querySelector(".banner-actions")?.remove();
  banner.append(actions);
}

/**
 * Keeps `banner` showing the notice for the latest state, once what was
 * dismissed before has been read (so a dismissed notice never flashes).
 * Call the returned function with every connection state.
 */
export function updateBanner(banner: HTMLElement): (state: ConnectionState) => void {
  let state: ConnectionState = { status: "idle" };
  let dismissed: string | null = null;
  let loaded = false;
  const show = (): void => {
    if (!loaded) return;
    renderUpdateNotice(
      banner,
      updateNotice(state, chrome.runtime.getManifest().version),
      dismissed,
      (key) => {
        dismissed = key;
        void dismissUpdate(key).catch(() => {});
        show();
      },
    );
  };
  loadDismissedUpdate()
    .catch(() => null)
    .then((key) => {
      dismissed = key;
      loaded = true;
      show();
    });
  return (next) => {
    state = next;
    show();
  };
}
