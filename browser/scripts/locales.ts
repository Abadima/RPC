/**
 * A locale file as the package carries it (src/core/i18n.ts reads it): minified,
 * and without the strings that are their own translation, since a string with
 * no entry is shown as it is. The file in `src/locales/` stays the readable one.
 */
export function packLocale(source: string): string {
  const entries: unknown = JSON.parse(source);
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    throw new Error("a locale file is an object of strings and plural forms");
  }
  const packed = Object.fromEntries(
    Object.entries(entries).filter(([english, translation]) => translation !== english),
  );
  return JSON.stringify(packed);
}
