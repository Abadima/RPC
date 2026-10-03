import type { ActivityInfo } from "../core/activity";
import { t, tn } from "../core/i18n";
import {
  isActivityOn,
  loadActivityStates,
  watchActivityStates,
  type ActivityStates,
} from "../core/activity-state";
import { NO_GRANTS, missingSites, type Grants } from "../core/site-access";
import {
  activityStatus,
  bulkPlan,
  disableAll,
  enableAll,
  listed,
  readGrants,
  turnOff,
  turnOn,
  watchGrants,
} from "../shared/activity-catalog";
import {
  NO_FILTERS,
  filterActivities,
  filterCount,
  parseFilters,
  serializeFilters,
  sortActivities,
  type ActivityFilters,
} from "../shared/activity-list";
import { activityIcon } from "../shared/activity-ui";
import {
  PAGE_SIZE,
  indexActivities,
  pageNumbers,
  pageOf,
  paginate,
  rowsThatFit,
  searchActivities,
  type IndexedActivity,
} from "../shared/catalog";
import { el } from "../shared/settings-view";
import { fromTemplate, slot, type View, type ViewContext } from "./view";

const SEARCH_DELAY_MS = 120;
const RESIZE_DELAY_MS = 150;
const count = (n: number): string => tn(n, "{n} Activity", "{n} Activities");

/** Where an Activity's own page is: `#activities/<id>`. */
export const activityHash = (id: string): string => `#activities/${encodeURIComponent(id)}`;

/** Which step "Enable or disable all" is on. */
type BulkStep = "choose" | "enable" | "disable";

/**
 * The Activity catalog: search, filters, and pages, so only one page of cards
 * is ever in the DOM however large the catalog grows. A page is as many cards
 * as fit the screen (full rows, from a phone to 8K), and resizing keeps your
 * place. The query, filters, and page live in the URL
 * (`#activities?q=…&filter=…&page=…`), so reloading or going back keeps them.
 * Each card opens the Activity's page, and has its own switch to turn it on
 * or off right there.
 *
 * Enabled Activities come first, then disabled ones, each by name. That order
 * is worked out when the list is built or when you search or filter, not when
 * you switch a card: one that moved to the top the moment you turned it on
 * would be hard to follow.
 */
export function activitiesView(context: ViewContext, params: URLSearchParams): View {
  const element = fromTemplate("activities");
  const input = slot<HTMLInputElement>(element, "query");
  const list = slot(element, "list");
  const pager = slot(element, "pager");
  const filterToggle = slot<HTMLButtonElement>(element, "filter-toggle");
  const filterMenu = slot(element, "filter-menu");
  const filterBadge = slot(element, "filter-count");
  const filterInputs = [...filterMenu.querySelectorAll<HTMLInputElement>("input[data-filter]")];
  const bulkToggle = slot<HTMLButtonElement>(element, "bulk-toggle");
  const bulkPanel = slot(element, "bulk");
  const bulkBody = slot(element, "bulk-body");
  let index: IndexedActivity[] = [];
  /** The listed Activities that match the search and filters, in the order shown. */
  let arranged: ActivityInfo[] = [];
  let listedKey = "";
  let catalog: readonly ActivityInfo[] = [];
  let states: ActivityStates = {};
  let grants: Grants = NO_GRANTS;
  /** Activities whose sites the browser was just refused, for their cards to say so. */
  const refused = new Set<string>();
  let loaded = false;
  let shown = false;
  let query = params.get("q") ?? "";
  let filters: ActivityFilters = parseFilters(params.get("filter"));
  let page = Number(params.get("page") ?? "1");
  let size = PAGE_SIZE;
  let bulkStep: BulkStep = "choose";
  let bulkBusy = false;
  let bulkMessage = "";
  input.value = query;
  slot(element, "catalog").hidden = true;

  /** Search, filter, and sort. Run when those change, not on every switch (see above). */
  function arrange(): void {
    arranged = sortActivities(
      filterActivities(searchActivities(index, query), states, filters),
      states,
    );
  }

  /** The listed Activities, rebuilt when a website's chosen implementation changes. */
  function relist(): boolean {
    const now = listed(catalog, states);
    const key = now.map((info) => info.id).join("\n");
    if (key === listedKey) return false;
    listedKey = key;
    index = indexActivities(now);
    return true;
  }

  function pageButton(label: string, target: number, current: boolean, disabled = false): Element {
    const button = el("button", "pager-button", label);
    button.type = "button";
    button.disabled = disabled;
    if (current) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => {
      page = target;
      render();
      slot(element, "summary").scrollIntoView({ block: "nearest" });
    });
    return button;
  }

  /**
   * Turns an Activity on or off from its card. Called straight from the
   * switch's change event: a browser only asks for sites then. A refusal
   * leaves it off, and its card says why.
   */
  function change(info: ActivityInfo, toggle: HTMLInputElement): void {
    toggle.disabled = true;
    refused.delete(info.id);
    const done = toggle.checked
      ? turnOn(info, grants)
      : turnOff(info, catalog, grants).then(() => true);
    void done.then((ok) => {
      if (!ok) {
        toggle.checked = false;
        refused.add(info.id);
        render();
      }
      toggle.disabled = false;
    });
  }

  function card(info: ActivityInfo): HTMLElement {
    const link = el("a", "activity-link");
    link.href = activityHash(info.id);
    const text = el("span", "row-text");
    text.append(
      el("span", "row-title", info.name),
      el("span", "row-subtitle", info.description ?? info.hosts.join(", ")),
    );
    const pills = el("span", "card-pills");
    const on = isActivityOn(info, states);
    const status = activityStatus(info, states, grants);
    if (status === "needs-access") pills.append(el("span", "pill pill-warn", t("Needs access")));
    else if (!on && refused.has(info.id)) {
      pills.append(el("span", "pill pill-warn", t("Access declined")));
    }
    if (info.source === "premid") pills.append(el("span", "pill pill-quiet", "PreMiD"));
    if ((info.variants?.length ?? 0) > 1) pills.append(el("span", "pill pill-quiet", t("multi")));
    link.append(activityIcon(info), text, pills);

    const toggle = el("input", "switch");
    toggle.type = "checkbox";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", t("Show {name}", { name: info.name }));
    toggle.checked = on;
    toggle.addEventListener("change", () => change(info, toggle));

    const item = el("li", "activity-card");
    item.dataset.activity = info.id;
    item.append(link, toggle);
    return item;
  }

  // Filter menu

  function setFilterMenu(open: boolean): void {
    filterMenu.hidden = !open;
    filterToggle.setAttribute("aria-expanded", String(open));
  }

  function renderFilters(): void {
    const chosen = new Set(serializeFilters(filters).split(","));
    for (const box of filterInputs) box.checked = chosen.has(box.value);
    const active = filterCount(filters);
    filterBadge.hidden = active === 0;
    filterBadge.textContent = String(active);
    filterToggle.setAttribute(
      "aria-label",
      active > 0 ? t("Filter, {n} selected", { n: active }) : t("Filter"),
    );
  }

  function refilter(next: ActivityFilters): void {
    filters = next;
    page = 1;
    arrange();
    render();
  }

  filterToggle.addEventListener("click", () => setFilterMenu(Boolean(filterMenu.hidden)));
  for (const box of filterInputs) {
    box.addEventListener("change", () =>
      refilter(
        parseFilters(
          filterInputs
            .filter((b) => b.checked)
            .map((b) => b.value)
            .join(","),
        ),
      ),
    );
  }
  slot(element, "filter-clear").addEventListener("click", () => refilter(NO_FILTERS));

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !filterMenu.hidden) {
      setFilterMenu(false);
      filterToggle.focus();
    }
  };
  const onPointer = (event: MouseEvent): void => {
    const box = filterToggle.parentElement;
    if (!filterMenu.hidden && box && event.target instanceof Node && !box.contains(event.target)) {
      setFilterMenu(false);
    }
  };

  // Enable or disable all

  function bulkButton(label: string, onClick: () => void, quiet = true, disabled = false) {
    const button = el("button", quiet ? "button button-quiet" : "button", label);
    button.type = "button";
    button.disabled = disabled || bulkBusy;
    button.addEventListener("click", onClick);
    return button;
  }

  function goto(step: BulkStep, message = ""): void {
    bulkStep = step;
    bulkMessage = message;
    renderBulk(true);
  }

  /**
   * Called straight from the confirming click: the browser only asks for
   * sites then, so the request goes out before anything else happens.
   */
  function runEnable(): void {
    const plan = bulkPlan(arranged, states, grants);
    for (const info of plan.enable) refused.delete(info.id);
    const done = enableAll(plan, grants);
    bulkBusy = true;
    renderBulk();
    void done
      .then(({ changed, declined }) => {
        for (const id of declined) refused.add(id);
        if (declined.length === 0) return t("Enabled {count}.", { count: count(changed) });
        if (changed === 0) {
          return t("Nothing was enabled: your browser didn't grant access to their sites.");
        }
        return tn(
          declined.length,
          "Enabled {count}. {n} Activity stayed off because its sites weren't granted.",
          "Enabled {count}. {n} Activities stayed off because their sites weren't granted.",
          { count: count(changed) },
        );
      })
      .catch(() => t("Couldn't change the Activities. Try again."))
      .then((message) => {
        bulkBusy = false;
        goto("choose", message);
        render();
      });
  }

  function runDisable(): void {
    bulkBusy = true;
    renderBulk();
    void disableAll(arranged, catalog, grants)
      .then((changed) =>
        changed === 0 ? t("Nothing was on.") : t("Disabled {count}.", { count: count(changed) }),
      )
      .catch(() => t("Couldn't change the Activities. Try again."))
      .then((message) => {
        bulkBusy = false;
        goto("choose", message);
        render();
      });
  }

  /** `moveFocus` is for a step change; a redraw for anything else leaves the focus alone. */
  function renderBulk(moveFocus = false): void {
    if (bulkPanel.hidden) return;
    const plan = bulkPlan(arranged, states, grants);
    const parts: HTMLElement[] = [];
    const scope = el(
      "p",
      "bulk-scope",
      arranged.length === 0
        ? t("No Activities match, so there is nothing to change.")
        : t("This applies to the {count} matching your search and filters, on every page.", {
            count: count(arranged.length),
          }),
    );

    if (bulkStep === "enable") {
      const readers = plan.enable.filter((info) => missingSites(info, grants).length > 0).length;
      const sites = plan.sites.length;
      parts.push(
        el("p", "bulk-question", t("Enable {count}?", { count: count(plan.enable.length) })),
        el(
          "p",
          "bulk-warning",
          sites > 0
            ? `${tn(readers, "{n} Activity reads pages.", "{n} Activities read pages.")} ${tn(
                sites,
                "Your browser will ask for access to {n} site in one prompt, which can be long. Anything you decline stays off.",
                "Your browser will ask for access to {n} sites in one prompt, which can be long. Anything you decline stays off.",
              )}`
            : t("None of them needs access to a new site, so your browser won't ask for anything."),
        ),
      );
      const actions = el("div", "bulk-actions");
      const cancel = bulkButton(t("Cancel"), () => goto("choose"));
      actions.append(
        bulkButton(
          t("Enable {count}", { count: count(plan.enable.length) }),
          runEnable,
          false,
          plan.enable.length === 0,
        ),
        cancel,
      );
      parts.push(actions);
      bulkBody.replaceChildren(...parts);
      // The safe answer has the focus, so pressing Enter twice can't turn everything on.
      if (moveFocus) cancel.focus();
      return;
    }

    if (bulkStep === "disable") {
      const cancel = bulkButton(t("Cancel"), () => goto("choose"));
      const actions = el("div", "bulk-actions");
      actions.append(
        bulkButton(
          t("Disable {count}", { count: count(plan.disable.length) }),
          runDisable,
          false,
          plan.disable.length === 0,
        ),
        cancel,
      );
      bulkBody.replaceChildren(
        el("p", "bulk-question", t("Disable {count}?", { count: count(plan.disable.length) })),
        el("p", "bulk-scope", t("Sites only they used are given back to your browser.")),
        actions,
      );
      if (moveFocus) cancel.focus();
      return;
    }

    const actions = el("div", "bulk-actions");
    actions.append(
      bulkButton(
        t("Enable all ({n})", { n: plan.enable.length }),
        () => goto("enable"),
        true,
        plan.enable.length === 0,
      ),
      bulkButton(
        t("Disable all ({n})", { n: plan.disable.length }),
        () => goto("disable"),
        true,
        plan.disable.length === 0,
      ),
    );
    parts.push(scope, actions);
    if (bulkMessage) {
      const message = el("p", "bulk-message", bulkMessage);
      message.setAttribute("role", "status");
      parts.push(message);
    }
    bulkBody.replaceChildren(...parts);
  }

  bulkToggle.addEventListener("click", () => {
    const open = Boolean(bulkPanel.hidden);
    bulkPanel.hidden = !open;
    bulkToggle.setAttribute("aria-expanded", String(open));
    if (open) goto("choose");
  });

  function render(): void {
    const shownPage = paginate(arranged, page, size);
    page = shownPage.page;

    const search = new URLSearchParams();
    if (query) search.set("q", query);
    if (filterCount(filters) > 0) search.set("filter", serializeFilters(filters));
    if (page > 1) search.set("page", String(page));
    const hash = `#activities${search.size > 0 ? `?${search}` : ""}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);

    slot(element, "summary").textContent =
      shownPage.total === 0
        ? ""
        : t("{first}–{last} of {total}", {
            first: shownPage.first,
            last: shownPage.last,
            total: shownPage.total,
          });
    slot(element, "no-results").hidden = shownPage.total > 0;
    list.replaceChildren(...shownPage.items.map(card));
    renderFilters();
    if (!bulkBusy) renderBulk();

    pager.hidden = shownPage.pageCount <= 1;
    pager.replaceChildren(
      pageButton(t("Previous"), shownPage.page - 1, false, shownPage.page === 1),
      ...pageNumbers(shownPage.page, shownPage.pageCount).map((n) => {
        if (n !== "gap") return pageButton(String(n), n, n === shownPage.page);
        return el("span", "pager-gap", "…");
      }),
      pageButton(t("Next"), shownPage.page + 1, false, shownPage.page === shownPage.pageCount),
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      query = input.value.trim();
      page = 1;
      arrange();
      render();
    }, SEARCH_DELAY_MS);
  });

  /** Full rows that fill the window below the list's top, leaving room for the pager. */
  function fittingSize(): number {
    const style = getComputedStyle(list);
    const columns = style.gridTemplateColumns.split(" ").filter(Boolean).length;
    const cardHeight = list.firstElementChild?.getBoundingClientRect().height ?? 0;
    const room = window.innerHeight - list.getBoundingClientRect().top - pager.offsetHeight * 2;
    return Math.max(1, columns) * rowsThatFit(room, cardHeight, parseFloat(style.rowGap) || 0);
  }

  function fit(): void {
    if (!loaded || !shown || index.length === 0) return;
    const next = fittingSize();
    if (next === size) return;
    page = pageOf((page - 1) * size, next);
    size = next;
    render();
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fit, RESIZE_DELAY_MS);
  };

  const stopWatching = watchActivityStates((next) => {
    states = next;
    // Which implementation of a website is listed may have changed; a switch alone doesn't reorder.
    if (relist()) arrange();
    if (loaded && index.length > 0) render();
  });
  const stopGrants = watchGrants(() => {
    void readGrants().then((next) => {
      grants = next;
      if (loaded && index.length > 0) render();
    });
  });
  void Promise.all([
    context.catalog(),
    loadActivityStates().catch(() => ({})),
    readGrants().catch(() => NO_GRANTS),
  ]).then(([activities, stored, granted]) => {
    catalog = activities;
    states = stored;
    grants = granted;
    relist();
    arrange();
    loaded = true;
    const empty = index.length === 0;
    slot(element, "catalog").hidden = empty;
    slot(element, "empty").hidden = !empty;
    if (empty) return;
    render();
    fit();
  });

  return {
    title: t("Activities"),
    element,
    update() {},
    mounted() {
      shown = true;
      fit();
      window.addEventListener("resize", onResize);
      document.addEventListener("keydown", onKey);
      document.addEventListener("click", onPointer);
    },
    destroy() {
      stopWatching();
      stopGrants();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onPointer);
      clearTimeout(resizeTimer);
      clearTimeout(timer);
    },
  };
}
