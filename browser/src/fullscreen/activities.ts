import {
  PAGE_SIZE,
  indexActivities,
  pageNumbers,
  pageOf,
  paginate,
  rowsThatFit,
  searchActivities,
} from "../shared/catalog";
import { fromTemplate, slot, type View, type ViewContext } from "./view";

const SEARCH_DELAY_MS = 120;
const RESIZE_DELAY_MS = 150;
const number = new Intl.NumberFormat("en");

/**
 * The Activity catalog: search plus pages, so only one page of cards is ever
 * in the DOM however large the catalog grows. A page is as many cards as fit
 * the screen (full rows, from a phone to 8K), and resizing keeps your place.
 * The query and page live in the URL (`#activities?q=…&page=…`), so
 * reloading or going back keeps them.
 */
export function activitiesView(context: ViewContext, params: URLSearchParams): View {
  const element = fromTemplate("activities");
  const index = indexActivities(context.activities);
  const input = slot<HTMLInputElement>(element, "query");
  const list = slot(element, "list");
  const pager = slot(element, "pager");
  let query = params.get("q") ?? "";
  let page = Number(params.get("page") ?? "1");
  let size = PAGE_SIZE;
  input.value = query;

  const empty = index.length === 0;
  slot(element, "catalog").hidden = empty;
  slot(element, "empty").hidden = !empty;

  function pageButton(label: string, target: number, current: boolean, disabled = false): Element {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pager-button";
    button.textContent = label;
    button.disabled = disabled;
    if (current) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => {
      page = target;
      render();
      slot(element, "summary").scrollIntoView({ block: "nearest" });
    });
    return button;
  }

  function render(): void {
    const results = searchActivities(index, query);
    const shown = paginate(results, page, size);
    page = shown.page;

    const search = new URLSearchParams();
    if (query) search.set("q", query);
    if (page > 1) search.set("page", String(page));
    const hash = `#activities${search.size > 0 ? `?${search}` : ""}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);

    slot(element, "summary").textContent =
      shown.total === 0
        ? ""
        : `${number.format(shown.first)}–${number.format(shown.last)} of ${number.format(shown.total)}`;
    slot(element, "no-results").hidden = shown.total > 0 || empty;

    list.replaceChildren(
      ...shown.items.map((info) => {
        const item = document.createElement("li");
        item.className = "activity-card";
        const tile = document.createElement("span");
        tile.className = "tile tile-letter";
        tile.setAttribute("aria-hidden", "true");
        tile.textContent = info.name.charAt(0);
        const text = document.createElement("span");
        text.className = "row-text";
        const name = document.createElement("span");
        name.className = "row-title";
        name.textContent = info.name;
        const detail = document.createElement("span");
        detail.className = "row-subtitle";
        detail.textContent = info.description ?? info.hosts.join(", ");
        text.append(name, detail);
        item.append(tile, text);
        return item;
      }),
    );

    pager.hidden = shown.pageCount <= 1;
    pager.replaceChildren(
      pageButton("Previous", shown.page - 1, false, shown.page === 1),
      ...pageNumbers(shown.page, shown.pageCount).map((n) => {
        if (n !== "gap") return pageButton(String(n), n, n === shown.page);
        const gap = document.createElement("span");
        gap.className = "pager-gap";
        gap.textContent = "…";
        return gap;
      }),
      pageButton("Next", shown.page + 1, false, shown.page === shown.pageCount),
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      query = input.value.trim();
      page = 1;
      render();
    }, SEARCH_DELAY_MS);
  });

  /** Full rows that fill the window below the list's top, leaving room for the pager. */
  function fittingSize(): number {
    const style = getComputedStyle(list);
    const columns = style.gridTemplateColumns.split(" ").filter(Boolean).length;
    const card = list.firstElementChild?.getBoundingClientRect().height ?? 0;
    const room = window.innerHeight - list.getBoundingClientRect().top - pager.offsetHeight * 2;
    return Math.max(1, columns) * rowsThatFit(room, card, parseFloat(style.rowGap) || 0);
  }

  function fit(): void {
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

  if (!empty) render();
  return {
    title: "Activities",
    element,
    update() {},
    mounted() {
      if (empty) return;
      fit();
      window.addEventListener("resize", onResize);
    },
    destroy() {
      window.removeEventListener("resize", onResize);
      clearTimeout(resizeTimer);
      clearTimeout(timer);
    },
  };
}
