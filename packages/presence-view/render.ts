import type {
  PresenceActivity,
  PresenceIconName,
  PresenceSnapshot,
  PresenceViewOptions,
} from "./types";

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

function renderMessage(
  root: HTMLElement,
  options: PresenceViewOptions,
  iconName: PresenceIconName,
  title: string,
  subtitle: string,
): void {
  const wrapper = element("div", "presence-empty");
  wrapper.append(
    element("div", "presence-empty-visual"),
    element("p", "presence-empty-title", title),
    element("p", "presence-empty-subtitle", subtitle),
  );
  wrapper.firstElementChild?.append(...iconFor(options, iconName));
  root.append(wrapper);
}

function renderActivity(
  root: HTMLElement,
  activity: PresenceActivity,
  options: PresenceViewOptions,
): void {
  const card = element("article", "presence-card");
  card.setAttribute("aria-label", `Sharing ${activity.name}`);

  const top = element("div", "presence-top");
  const monogram = element("span", "presence-monogram", activity.name.trim().charAt(0));
  monogram.setAttribute("aria-hidden", "true");
  const source = element("div", "presence-source");
  source.append(
    element("p", "presence-name", activity.name),
    element("p", "presence-kind", "Sharing now"),
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
    footer.append(...iconFor(options, "elapsed"), time, " elapsed");
    card.append(footer);
    clocks.set(root, setInterval(tick, 1000));
  }

  root.append(card);
}

export type PresenceViewState = "unavailable" | "empty" | "activity";

/** Pulled out of renderPresence so the state decision is testable without a DOM. */
export function classifyPresence(snapshot: PresenceSnapshot): PresenceViewState {
  if (!snapshot.available) {
    return "unavailable";
  }
  return snapshot.activity ? "activity" : "empty";
}

/** Renders one of exactly three real states, never a placeholder or a simulated one. */
export function renderPresence(
  root: HTMLElement,
  snapshot: PresenceSnapshot,
  options: PresenceViewOptions = {},
): void {
  clearInterval(clocks.get(root));
  clocks.delete(root);
  root.replaceChildren();
  if (!snapshot.available) {
    renderMessage(
      root,
      options,
      "unavailable",
      "No extension detected",
      "Install the Parousia browser extension to see your presence here.",
    );
  } else if (snapshot.activity) {
    renderActivity(root, snapshot.activity, options);
  } else {
    renderMessage(
      root,
      options,
      "empty",
      "No activity detected",
      "Browse a supported site and it shows up here.",
    );
  }
}
