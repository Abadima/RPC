import {
  SETTINGS_PAGES,
  categoryList,
  pageTitle,
  settingsPage,
  type SettingsPageId,
} from "../shared/settings-view";
import { fromTemplate, slot, type View, type ViewContext } from "./view";

function isPage(value: string | undefined): value is SettingsPageId {
  return SETTINGS_PAGES.some((page) => page.id === value);
}

/** Categories beside the chosen one's page; `#settings/privacy` opens Privacy. */
export function settingsView(context: ViewContext, segment: string | undefined): View {
  const element = fromTemplate("settings");
  const current = isPage(segment) ? segment : "general";
  const page = settingsPage(current, context.settings);
  slot(element, "nav").append(
    categoryList((next) => {
      location.hash = `#settings/${next}`;
    }, current),
  );
  slot(element, "title").textContent = pageTitle(current);
  slot(element, "page").append(page.element);
  return {
    title: `${pageTitle(current)} Settings`,
    element,
    update: (shell) => page.update(shell.settings),
    destroy: () => page.destroy?.(),
  };
}
