import {
  currentLanguage,
  fetchDictionary,
  resolveLanguage,
  setLanguage,
  translateTree,
} from "../core/i18n";
import { loadPreferences, watchPreferences } from "../core/preferences";

/**
 * Before a view builds anything: reads the language chosen in Settings (or
 * the browser's), loads its strings, and translates the page's own text. A
 * change of language in any view reloads the others, which is simpler and
 * cheaper than redrawing every string in place. Whatever goes wrong, the view
 * still opens, in English.
 */
export async function loadLanguage(): Promise<void> {
  try {
    const preferences = await loadPreferences().catch(() => null);
    const browser = chrome.i18n.getUILanguage();
    const chosen = resolveLanguage(preferences?.language ?? "auto", browser);
    setLanguage(chosen, chosen === "en" ? {} : await fetchDictionary(chosen));
    document.documentElement.lang = chosen;
    translateTree(document);
    watchPreferences((next) => {
      if (resolveLanguage(next.language, browser) !== currentLanguage()) location.reload();
    });
  } catch {
    setLanguage("en");
  }
}
