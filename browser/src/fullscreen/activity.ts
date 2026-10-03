import type { ActivityInfo } from "../core/activity";
import { t } from "../core/i18n";
import {
  chosenVariant,
  isActivityOn,
  loadActivityStates,
  needsAccess,
  watchActivityStates,
  type ActivityStates,
} from "../core/activity-state";
import { NO_GRANTS, missingSites, siteName, type Grants } from "../core/site-access";
import {
  activityStatus,
  chooseVariant,
  loadActivityInfo,
  readGrants,
  requestAccess,
  turnOff,
  turnOn,
  watchGrants,
} from "../shared/activity-catalog";
import { activitySettings } from "../shared/activity-settings";
import { activityIcon } from "../shared/activity-ui";
import { el, group, switchRow } from "../shared/settings-view";
import { activityHash } from "./activities";
import { fromTemplate, slot, type View, type ViewContext } from "./view";

const SOURCES: Record<ActivityInfo["source"], string> = {
  parousia: "Parousia",
  premid: "PreMiD",
};

/** The sites an Activity reads, for a sentence: "www.youtube.com and m.youtube.com". */
function sitesText(origins: readonly string[]): string {
  const names = [...new Set(origins.map(siteName))];
  const [first = "", second = ""] = names;
  if (names.length <= 2) {
    return names.length === 2 ? t("{first} and {second}", { first, second }) : first;
  }
  return t("{first}, {second}, and {n} more", { first, second, n: names.length - 2 });
}

/** What turning it on means, next to its switch. */
function switchNote(info: ActivityInfo): string {
  if (!needsAccess(info)) {
    return t("Reads only the address and title of its pages, so it needs no site access.");
  }
  const sites = sitesText(info.origins ?? []);
  return info.source === "premid"
    ? t("Its own code reads its pages. Turning it on asks your browser for access to {sites}.", {
        sites,
      })
    : t(
        "Parousia reads what's playing on its pages. Turning it on asks your browser for access to {sites}.",
        { sites },
      );
}

/**
 * One Activity's page (`#activities/<id>`): whether it's on, which
 * implementation runs when both sources have its website, where it stands
 * with site access, and its settings. Site access isn't switched here: an
 * Activity that reads pages asks for its sites when it's turned on, and
 * without them it doesn't run. What Activities may read is one choice for
 * all of them, in Settings > Privacy.
 */
export function activityView(context: ViewContext, id: string): View {
  const element = fromTemplate("activity");
  let info: ActivityInfo | null = null;
  let catalog: readonly ActivityInfo[] = [];
  let states: ActivityStates = {};
  let grants: Grants = NO_GRANTS;
  let busy = false;
  let refused = false;
  let stopSettings: (() => void) | null = null;

  const toggle = switchRow(t("Show this Activity"), "", (on) => change(on), "activity-on");
  slot(element, "toggle").replaceChildren(group(toggle.row));
  const notice = slot(element, "notice");
  const noticeText = slot(notice, "notice-text");
  const allow = slot<HTMLButtonElement>(notice, "allow");

  function settle(done: Promise<boolean>, refusal: boolean): void {
    busy = true;
    refused = false;
    render();
    void done.then((ok) => {
      busy = false;
      refused = refusal && !ok;
      render();
    });
  }

  // Straight from the switch or button: a browser only asks for sites then.
  function change(on: boolean): void {
    if (!info || busy) return;
    if (!on) {
      settle(
        turnOff(info, catalog, grants).then(() => true),
        false,
      );
      return;
    }
    const chosen = chosenVariant(info, states) === info.id;
    settle(
      chosen ? turnOn(info, grants) : chooseVariant(info, catalog, states, grants, true),
      true,
    );
  }

  allow.addEventListener("click", () => {
    if (info && !busy) settle(requestAccess(info, grants), true);
  });

  function renderNotice(activity: ActivityInfo): void {
    const status = activityStatus(activity, states, grants);
    const missing = missingSites(activity, grants);
    let text = "";
    if (refused && status === "off") {
      text = t("It stays off: your browser didn't allow access to {sites}.", {
        sites: sitesText(missing),
      });
    } else if (refused && status === "needs-access") {
      text = t("Your browser didn't allow access to {sites}, so it still doesn't run there.", {
        sites: sitesText(missing),
      });
    } else if (status === "needs-access") {
      text = t(
        "It's on, but can't read {sites}, so it doesn't run there. Access was declined or taken back.",
        { sites: sitesText(missing) },
      );
    }
    notice.hidden = text === "";
    noticeText.textContent = text;
    // After a refusal it's off; turning it on again asks again.
    allow.hidden = status !== "needs-access";
    allow.disabled = busy;
  }

  function renderVariants(activity: ActivityInfo): void {
    const variants = (activity.variants ?? [])
      .map((variant) => catalog.find((entry) => entry.id === variant))
      .filter((entry): entry is ActivityInfo => entry !== undefined);
    const section = slot(element, "variants-section");
    section.hidden = variants.length < 2;
    if (variants.length < 2) return;
    const current = chosenVariant(activity, states);
    const premid = variants.filter((variant) => variant.source === "premid").length;
    const buttons = variants.map((variant) => {
      const label =
        variant.source === "premid" && premid > 1
          ? t("PreMiD: {name}", { name: variant.name })
          : SOURCES[variant.source];
      const button = el("button", "segment", label);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(variant.id === current));
      button.dataset.variant = variant.id;
      button.disabled = busy;
      button.addEventListener("click", () => {
        if (variant.id === current || busy) return;
        busy = true;
        render();
        void chooseVariant(variant, catalog, states, grants).then((ok) => {
          busy = false;
          if (ok) location.hash = activityHash(variant.id);
          else render();
        });
      });
      return button;
    });
    slot(element, "variants").replaceChildren(...buttons);
  }

  function render(): void {
    if (!info) return;
    toggle.input.checked = isActivityOn(info, states);
    toggle.input.disabled = busy;
    renderNotice(info);
    renderVariants(info);
  }

  function show(activity: ActivityInfo): void {
    info = activity;
    document.title = `${activity.name} · Parousia`;
    slot(element, "icon").replaceChildren(activityIcon(activity));
    slot(element, "name").textContent = activity.name;
    slot(element, "description").textContent = activity.description ?? "";
    slot(element, "source").textContent = SOURCES[activity.source];
    toggle.row.querySelector(".setting-detail")?.replaceChildren(switchNote(activity));

    const facts = slot(element, "facts");
    facts.replaceChildren();
    for (const [term, value] of [
      [t("Sites"), activity.hosts.join(", ")],
      [t("From"), t("{source} Activities", { source: SOURCES[activity.source] })],
    ] as const) {
      const row = el("div");
      row.append(el("dt", "", term), el("dd", "", value));
      facts.append(row);
    }

    const settings = activitySettings(activity, (empty) => {
      slot(element, "settings-label").hidden = empty;
    });
    stopSettings = settings.destroy;
    slot(element, "settings").replaceChildren(settings.element);
    slot(element, "body").hidden = false;
    render();
  }

  const stopWatching = watchActivityStates((next) => {
    states = next;
    render();
  });
  const stopGrants = watchGrants(() => {
    void readGrants().then((next) => {
      grants = next;
      render();
    });
  });
  void Promise.all([
    context.catalog(),
    loadActivityInfo(id),
    loadActivityStates().catch(() => ({})),
    readGrants().catch(() => NO_GRANTS),
  ]).then(([loaded, activity, stored, granted]) => {
    catalog = loaded;
    states = stored;
    grants = granted;
    // The manifest carries no description; the catalog does (in the view's language).
    const description = loaded.find((info) => info.id === id)?.description;
    if (activity) show(description === undefined ? activity : { ...activity, description });
    else slot(element, "missing").hidden = false;
  });

  return {
    title: t("Activity"),
    element,
    update() {},
    destroy() {
      stopWatching();
      stopGrants();
      stopSettings?.();
    },
  };
}
