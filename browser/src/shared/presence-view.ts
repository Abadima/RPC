import { t } from "../core/i18n";

/** Just enough of an Activity to display; deliberately independent of `core/` data. */
export interface PresenceActivity {
  name: string;
  details?: string;
  state?: string;
  /** When the Activity started, in Unix milliseconds; shown as elapsed time. */
  startedAt?: number;
}

export interface PresenceSnapshot {
  activity: PresenceActivity | null;
}

export type PresenceIconName = "empty" | "elapsed";

export interface PresenceViewOptions {
  /** Icons for the view, from the icon set the host bundles; without it the view draws none. */
  icon?: (name: PresenceIconName) => Element;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function iconFor(options: PresenceViewOptions, name: PresenceIconName): Element[] {
  return options.icon ? [options.icon(name)] : [];
}

/** `h:mm:ss`, or `m:ss` under an hour; negative (clock skew) counts as zero. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** One ticking clock per root, stopped whenever that root re-renders. */
const clocks = new WeakMap<HTMLElement, ReturnType<typeof setInterval>>();

function renderEmpty(root: HTMLElement, options: PresenceViewOptions): void {
  const wrapper = element("div", "presence-empty");
  wrapper.append(
    element("div", "presence-empty-visual"),
    element("p", "presence-empty-title", t("No activity detected")),
    element("p", "presence-empty-subtitle", t("Browse a supported site and it shows up here.")),
  );
  wrapper.firstElementChild?.append(...iconFor(options, "empty"));
  root.append(wrapper);
}

function renderActivity(
  root: HTMLElement,
  activity: PresenceActivity,
  options: PresenceViewOptions,
): void {
  const card = element("article", "presence-card");
  card.setAttribute("aria-label", t("Sharing {name}", { name: activity.name }));

  const top = element("div", "presence-top");
  const monogram = element("span", "presence-monogram", activity.name.trim().charAt(0));
  monogram.setAttribute("aria-hidden", "true");
  const source = element("div", "presence-source");
  source.append(
    element("p", "presence-name", activity.name),
    element("p", "presence-kind", t("Sharing now")),
  );
  const live = element("span", "presence-live");
  live.setAttribute("aria-hidden", "true");
  top.append(monogram, source, live);
  card.append(top);

  if (activity.details || activity.state) {
    const body = element("div", "presence-body");
    if (activity.details) body.append(element("p", "presence-detail", activity.details));
    if (activity.state) body.append(element("p", "presence-state", activity.state));
    card.append(body);
  }

  const startedAt = activity.startedAt;
  if (startedAt !== undefined) {
    const footer = element("p", "presence-elapsed");
    const time = element("time", "presence-elapsed-time");
    const tick = (): void => {
      time.textContent = formatElapsed(Date.now() - startedAt);
    };
    tick();
    // Where the clock goes in "2:03 elapsed" depends on the language.
    const [before = "", after = ""] = t("{time} elapsed").split("{time}");
    footer.append(...iconFor(options, "elapsed"), before, time, after);
    card.append(footer);
    clocks.set(root, setInterval(tick, 1000));
  }

  root.append(card);
}

/** Renders the Activity being shared, or the empty state; never a placeholder or a simulated one. */
export function renderPresence(
  root: HTMLElement,
  snapshot: PresenceSnapshot,
  options: PresenceViewOptions = {},
): void {
  clearInterval(clocks.get(root));
  clocks.delete(root);
  root.replaceChildren();
  if (snapshot.activity) {
    renderActivity(root, snapshot.activity, options);
  } else {
    renderEmpty(root, options);
  }
}
