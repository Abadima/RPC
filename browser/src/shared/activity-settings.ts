import type { ActivityInfo, ActivitySetting, SettingValue } from "../core/activity";
import {
  saveActivityState,
  settingShown,
  settingValues,
  watchActivityStates,
  loadActivityStates,
  type ActivityStates,
} from "../core/activity-state";
import type { SettingValues } from "../core/registry";
import { controlRow, el, select, switchRow } from "./settings-view";

/** A typed-in setting; saved when the field is left or Enter is pressed. */
function field(
  setting: ActivitySetting,
  value: SettingValue,
  save: (value: SettingValue) => void,
): HTMLElement {
  const input = el("input", "text-field");
  input.type = setting.type === "number" ? "number" : "text";
  input.value = String(value);
  if (setting.type === "text") input.maxLength = 256;
  if (setting.placeholder) input.placeholder = setting.placeholder;
  input.addEventListener("change", () => {
    if (setting.type === "text") save(input.value);
    else if (input.value !== "" && Number.isFinite(input.valueAsNumber)) save(input.valueAsNumber);
  });
  return controlRow(setting.title, setting.description ?? "", input);
}

function settingRow(
  setting: ActivitySetting,
  values: SettingValues,
  save: (value: SettingValue) => void,
): HTMLElement {
  const value = values[setting.id] ?? setting.default;
  switch (setting.type) {
    case "boolean": {
      const row = switchRow(setting.title, setting.description ?? "", save);
      row.input.checked = value === true;
      return row.row;
    }
    case "choice": {
      const choices = (setting.choices ?? []).map((label, index): [string, string] => [
        String(index),
        label,
      ]);
      const control = select(choices, (chosen) => save(Number(chosen)));
      control.input.value = String(value);
      return controlRow(setting.title, setting.description ?? "", control.wrapper);
    }
    case "text":
    case "number":
      return field(setting, value, save);
  }
}

/** The rows for `info`'s settings that show now (its `when` conditions, what its script hid), each saved as it changes. */
export function activitySettingRows(info: ActivityInfo, states: ActivityStates): HTMLElement[] {
  const values = settingValues(info, states);
  const hidden = states[info.id]?.hidden ?? [];
  return (info.settings ?? [])
    .filter((setting) => settingShown(setting, values, hidden))
    .map((setting) =>
      settingRow(setting, values, (value) => {
        void saveActivityState(info.id, { settings: { [setting.id]: value } });
      }),
    );
}

/**
 * `info`'s settings in a `.settings-group`, kept current as they change
 * (a setting's `when` can show or hide others), for the dashboard's
 * Activity page and the popup. `onEmpty` hears whether any show.
 */
export function activitySettings(
  info: ActivityInfo,
  onEmpty: (empty: boolean) => void = () => {},
): { element: HTMLElement; destroy(): void } {
  const element = el("div", "settings-group");
  const render = (states: ActivityStates): void => {
    const rows = activitySettingRows(info, states);
    element.replaceChildren(...rows);
    element.hidden = rows.length === 0;
    onEmpty(rows.length === 0);
  };
  render({});
  void loadActivityStates().then(render, () => {});
  const destroy = watchActivityStates(render);
  return { element, destroy };
}
