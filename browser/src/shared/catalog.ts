import type { ActivityInfo } from "../core/activity";

/** Activities per page: enough to scan, few enough to render instantly at any catalog size. */
export const PAGE_SIZE = 24;

/** One collator for every comparison: `localeCompare` with a locale builds a new one each time, about 30 times slower over a catalog. */
const collator = new Intl.Collator("en", { numeric: true });

const fold = (text: string): string =>
  text.normalize("NFKD").replaceAll(/\p{M}/gu, "").toLowerCase();

/** An Activity with its searchable text folded once, so each keystroke only compares strings. */
export interface IndexedActivity {
  info: ActivityInfo;
  haystack: string;
}

export function indexActivities(activities: readonly ActivityInfo[]): IndexedActivity[] {
  return activities
    .map((info) => ({
      info,
      // "premid" finds PreMiD's; other names and tags find what a site's also called.
      haystack: fold(
        [
          info.name,
          info.description ?? "",
          ...info.hosts,
          ...(info.keywords ?? []),
          info.source === "premid" ? "premid" : "",
        ].join(" "),
      ),
    }))
    .sort((a, b) => collator.compare(a.info.name, b.info.name));
}

/** Every word of `query` has to appear somewhere in the name, description, sites, or keywords. */
export function searchActivities(index: readonly IndexedActivity[], query: string): ActivityInfo[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return index
    .filter(({ haystack }) => words.every((word) => haystack.includes(word)))
    .map(({ info }) => info);
}

export interface Page<T> {
  items: T[];
  /** 1-based, clamped into range. */
  page: number;
  pageCount: number;
  total: number;
  /** 1-based positions of the first and last item shown; 0 when empty. */
  first: number;
  last: number;
}

export function paginate<T>(items: readonly T[], page: number, size = PAGE_SIZE): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * size;
  const shown = items.slice(start, start + size);
  return {
    items: shown,
    page: current,
    pageCount,
    total: items.length,
    first: shown.length > 0 ? start + 1 : 0,
    last: start + shown.length,
  };
}

/**
 * Page buttons to show: always the first and last, the current one and its
 * neighbours, and a gap wherever pages are skipped, so 59 pages still fit
 * on one line: 1 … 4 5 6 … 59.
 */
export function pageNumbers(page: number, pageCount: number): Array<number | "gap"> {
  const wanted = new Set([1, pageCount, page - 1, page, page + 1]);
  const pages = [...wanted].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const result: Array<number | "gap"> = [];
  for (const n of pages) {
    const previous = result.at(-1);
    if (typeof previous === "number" && n - previous > 1) {
      // A single skipped page is shown rather than hidden behind a gap.
      if (n - previous === 2) result.push(previous + 1);
      else result.push("gap");
    }
    result.push(n);
  }
  return result;
}

/** Rows of cards that fit in `room` pixels (never fewer than `minRows`, so short windows still page sensibly). */
export function rowsThatFit(room: number, rowHeight: number, gap: number, minRows = 3): number {
  if (rowHeight <= 0) return minRows;
  return Math.max(minRows, Math.floor((room + gap) / (rowHeight + gap)));
}

/** The page that shows item `index` (0-based) at `size` per page, so resizing keeps your place. */
export function pageOf(index: number, size: number): number {
  return Math.floor(Math.max(0, index) / Math.max(1, size)) + 1;
}
