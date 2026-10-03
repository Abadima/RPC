import { t } from "../core/i18n";
import { renderPresence } from "../shared/presence-view";
import {
  DEFAULT_ACTIVITY_LIMITS,
  EMPTY_DEFAULT_ACTIVITY,
  defaultActivityProblems,
  loadDefaultActivity,
  saveDefaultActivity,
  watchDefaultActivity,
  type DefaultActivity,
  type DefaultActivityField,
} from "../core/default-activity";
import { el, group, sectionLabel, switchRow } from "../shared/settings-view";
import { presenceIcons } from "../shared/views";
import { fromTemplate, slot, type View } from "./view";

type TextField = Exclude<DefaultActivityField, "buttons">;
const TEXT_FIELDS: readonly TextField[] = [
  "name",
  "details",
  "state",
  "largeImage",
  "largeText",
  "smallImage",
  "smallText",
  "discordClientId",
];

interface Field {
  input: HTMLInputElement;
  error: HTMLElement;
}

/** A labelled text box with room under it for what's wrong. */
function field(
  id: string,
  label: string,
  hint: string,
  max: number,
  type: "text" | "url" = "text",
): Field & { element: HTMLElement } {
  const element = el("div", "form-field");
  const labelElement = el("label", "setting-title", label);
  labelElement.htmlFor = id;
  const input = el("input", "text-field");
  input.id = id;
  input.type = type;
  input.maxLength = max;
  input.autocomplete = "off";
  input.spellcheck = type === "text";
  const detail = el("p", "setting-detail", hint);
  detail.id = `${id}-hint`;
  const error = el("p", "field-error");
  error.id = `${id}-error`;
  error.hidden = true;
  input.setAttribute("aria-describedby", `${detail.id} ${error.id}`);
  element.append(labelElement, input, detail, error);
  return { element, input, error };
}

/**
 * The Default Activity (`#default`): a presence written by hand, shared
 * whenever the tab you're on has no Activity. It goes through the same
 * runtime as a detected Activity, so Privacy settings, private windows, the
 * idle timeout, and Settings > Platforms apply to it too. The form saves
 * only when everything in it can be shown; the switch turns it on and off.
 */
export function defaultView(): View {
  const element = fromTemplate("default");
  const form = slot<HTMLFormElement>(element, "form");
  const preview = slot(element, "preview");
  const status = slot(element, "status");
  const { text, image, label, link } = DEFAULT_ACTIVITY_LIMITS;
  let saved: DefaultActivity = EMPTY_DEFAULT_ACTIVITY;

  const toggle = switchRow(
    t("Show a Default Activity"),
    t(
      "Shared whenever the tab you're on has no Activity: a site none covers, a browser page, a new tab.",
    ),
    (on) => void setEnabled(on),
    "default-on",
  );
  slot(element, "toggle").replaceChildren(group(toggle.row));

  const fields: Record<TextField, Field & { element: HTMLElement }> = {
    name: field(
      "default-name",
      t("Name"),
      t('Shown as what you\'re doing, like "Playing <name>". Required.'),
      text,
    ),
    details: field("default-details", t("Details"), t("The first line under the name."), text),
    state: field("default-state", t("State"), t("The second line."), text),
    largeImage: field(
      "default-largeImage",
      t("Large image"),
      t("An https image link, or an asset name from your own Discord Application."),
      image,
    ),
    largeText: field(
      "default-largeText",
      t("Large image text"),
      t("Shown when someone hovers over it."),
      text,
    ),
    smallImage: field(
      "default-smallImage",
      t("Small image"),
      t("Shown in the large image's corner."),
      image,
    ),
    smallText: field(
      "default-smallText",
      t("Small image text"),
      t("Shown when someone hovers over it."),
      text,
    ),
    discordClientId: field(
      "default-discordClientId",
      t("Discord Application ID"),
      t("Optional: show it as your own Discord Application instead of Parousia."),
      20,
    ),
  };
  const buttons = [0, 1].map((n) => ({
    label: field(
      `default-button-${n}-label`,
      t("Button {n}", { n: n + 1 }),
      t("Its label."),
      label,
    ),
    url: field(
      `default-button-${n}-url`,
      t("Button {n} link", { n: n + 1 }),
      t("Where it goes."),
      link,
      "url",
    ),
  }));
  const buttonsError = el("p", "field-error");
  buttonsError.hidden = true;
  buttonsError.setAttribute("role", "alert");

  const elapsed = switchRow(
    t("Show elapsed time"),
    t("How long it's been shown, counted from when it started."),
    () => renderPreview(),
    "default-elapsed",
  );

  form.append(
    sectionLabel(t("Text")),
    group(fields.name.element, fields.details.element, fields.state.element),
    sectionLabel(t("Images")),
    group(
      fields.largeImage.element,
      fields.largeText.element,
      fields.smallImage.element,
      fields.smallText.element,
    ),
    sectionLabel(t("Buttons")),
    group(...buttons.flatMap((button) => [button.label.element, button.url.element]), buttonsError),
    sectionLabel(t("More")),
    group(elapsed.row, fields.discordClientId.element),
  );
  const save = el("button", "button", t("Save"));
  save.type = "submit";
  const actions = el("div", "form-actions");
  actions.append(save, status);
  form.append(actions);

  /** What the form says now, on or off as saved. */
  function read(): DefaultActivity {
    const value = (name: TextField): string => fields[name].input.value;
    return {
      enabled: saved.enabled,
      name: value("name"),
      details: value("details"),
      state: value("state"),
      largeImage: value("largeImage"),
      largeText: value("largeText"),
      smallImage: value("smallImage"),
      smallText: value("smallText"),
      buttons: buttons.map((button) => ({
        label: button.label.input.value,
        url: button.url.input.value,
      })),
      elapsed: elapsed.input.checked,
      discordClientId: value("discordClientId").trim(),
    };
  }

  function fill(activity: DefaultActivity): void {
    saved = activity;
    toggle.input.checked = activity.enabled;
    for (const name of TEXT_FIELDS) fields[name].input.value = activity[name];
    buttons.forEach((button, n) => {
      button.label.input.value = activity.buttons[n]?.label ?? "";
      button.url.input.value = activity.buttons[n]?.url ?? "";
    });
    elapsed.input.checked = activity.elapsed;
    renderPreview();
  }

  /** Marks each field with what's wrong with it; true when nothing is. */
  function showProblems(activity: DefaultActivity): boolean {
    const problems = defaultActivityProblems(activity);
    for (const name of TEXT_FIELDS) {
      const problem = problems[name];
      fields[name].error.textContent = problem ?? "";
      fields[name].error.hidden = !problem;
      fields[name].input.setAttribute("aria-invalid", String(Boolean(problem)));
    }
    buttonsError.textContent = problems.buttons ?? "";
    buttonsError.hidden = !problems.buttons;
    for (const button of buttons) {
      for (const part of [button.label, button.url]) {
        part.input.setAttribute("aria-invalid", String(Boolean(problems.buttons)));
      }
    }
    return Object.keys(problems).length === 0;
  }

  function renderPreview(): void {
    const activity = read();
    const name = activity.name.trim();
    renderPresence(
      preview,
      {
        activity: name
          ? {
              name,
              ...(activity.details.trim() && { details: activity.details.trim() }),
              ...(activity.state.trim() && { state: activity.state.trim() }),
              ...(activity.elapsed && { startedAt: Date.now() }),
            }
          : null,
      },
      presenceIcons,
    );
  }

  async function setEnabled(on: boolean): Promise<void> {
    const activity = { ...read(), enabled: on };
    // It turns on only as something that can be shown.
    if (on && !showProblems(activity)) {
      toggle.input.checked = false;
      status.textContent = t("Fix what's marked, then turn it on.");
      return;
    }
    fill(await saveDefaultActivity(on ? activity : { ...saved, enabled: false }));
    status.textContent = on ? t("On.") : t("Off.");
  }

  form.addEventListener("input", () => {
    status.textContent = "";
    renderPreview();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const activity = read();
    if (!showProblems(activity)) {
      status.textContent = t("Not saved: fix what's marked.");
      return;
    }
    void saveDefaultActivity(activity).then((next) => {
      fill(next);
      status.textContent = next.enabled
        ? t("Saved. It's shown when no Activity is.")
        : t("Saved. Turn it on above to share it.");
    });
  });

  const stop = watchDefaultActivity((next) => {
    // Someone saved it elsewhere (another dashboard): show that.
    if (JSON.stringify(next) !== JSON.stringify(saved)) fill(next);
  });
  void loadDefaultActivity().then(fill, () => fill(EMPTY_DEFAULT_ACTIVITY));

  return {
    title: t("Default Activity"),
    element,
    update() {},
    destroy: stop,
  };
}
