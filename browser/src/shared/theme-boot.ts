import { applyTheme, loadTheme, readThemeHint, watchTheme } from "./appearance";

// theme.js: a classic script in each page's <head>, so it runs before the
// first paint. The cached copy first, then storage's answer (which also
// repairs a missing or stale copy), then every change from any view.
applyTheme(readThemeHint());
loadTheme().then(applyTheme, () => {});
watchTheme(applyTheme);
