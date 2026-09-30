/** The manifest fields the userscript's metadata block repeats. */
export interface HeaderSource {
  version: string;
  description: string;
}

/**
 * A userscript manager only recognizes a script as a userscript, and only
 * knows what to run it on, from an `==UserScript==` metadata block (and a
 * `.user.js` file name to offer installing it). The one grant is a menu
 * command for checking the connection, since a userscript has no popup.
 * `@inject-into content` (Violentmonkey) and `@sandbox DOM` (Tampermonkey)
 * run it in the isolated world, out of reach of the page's own scripts.
 * `@noframes` keeps embedded iframes from each opening their own connection.
 * Matching every site mirrors the extension's own `tabs` permission: broad
 * reach is inherent to "detect activity on whatever site the user is on".
 */
export function userscriptHeader({ version, description }: HeaderSource): string {
  return [
    "// ==UserScript==",
    "// @name         Parousia",
    "// @namespace    https://github.com/Abadima/RPC",
    `// @version      ${version}`,
    `// @description  ${description}`,
    "// @license      Apache-2.0",
    "// @match        *://*/*",
    "// @run-at       document-start",
    "// @noframes",
    "// @inject-into  content",
    "// @sandbox      DOM",
    "// @grant        GM_registerMenuCommand",
    "// ==/UserScript==",
    "",
  ].join("\n");
}
