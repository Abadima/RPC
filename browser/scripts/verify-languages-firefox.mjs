// End-to-end check of the languages (Settings > General) in the Firefox
// installed on this machine (Developer Edition, over WebDriver BiDi; see
// e2e/firefox.mjs), on the extension as built for Firefox. No Desktop is
// needed: the pages show their not-connected states, which is enough to show
// their words. The Chromium side is `languages:verify`.
//
// Covers, in Firefox: each language in the popup and the dashboard (the
// page's own text, the code's text, a plural, `<html lang>`); Automatic
// following Firefox's own interface language; and a PreMiD Activity's description in the chosen
// language.
//
// Prerequisites: `bun run activities:fetch` and Firefox Developer Edition at
// /opt/firefox (or FIREFOX_BIN). Linux only.

import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { EXPECTED } from "./e2e/languages.mjs";
import { launchFirefox, prepareProfile } from "./e2e/firefox.mjs";
import { assert, browserDir, logger, waitUntil, workspace } from "./e2e/lib.mjs";

const log = logger("languages-firefox");
const run = promisify(execFile);
const PAROUSIA_ID = "parousia@abadima.dev";
const PAROUSIA_UUID = "8d7c6b5a-4e3f-4a2b-9c1d-0e1f2a3b4c5d";
const EXTENSION = `moz-extension://${PAROUSIA_UUID}`;

const ws = await workspace("pavl");
const dist = join(ws.dir, "dist");
await run("bun", ["run", "build.ts"], {
  cwd: browserDir,
  env: { ...process.env, PAROUSIA_BUILD_DIR: dist },
});
const xpi = join(ws.dir, "parousia.xpi");
await run(
  "bun",
  [
    "-e",
    `import { writeZip } from "./scripts/zip.ts"; await writeZip(${JSON.stringify(join(dist, "firefox"))}, ${JSON.stringify(xpi)});`,
  ],
  { cwd: browserDir },
);

/** Firefox in `locale` (its own interface language, which `i18n.getUILanguage()` reports). */
async function launch(locale, name) {
  const profileDir = join(ws.dir, `firefox-${name}`);
  await prepareProfile(profileDir, [{ id: PAROUSIA_ID, xpi, uuid: PAROUSIA_UUID }]);
  await appendFile(
    join(profileDir, "user.js"),
    `\n${Object.entries({
      "intl.locale.requested": locale,
      "general.useragent.locale": locale,
      "intl.accept_languages": locale,
    })
      .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
      .join("\n")}\n`,
  );
  const firefox = await launchFirefox({ profileDir, env: ws.env, port: 9444 });
  const ext = await firefox.openTab(`${EXTENSION}/popup.html`);
  await firefox.evaluate(
    ext,
    "browser.storage.local.set({ preferences: { discordRpcExtension: false } })",
  );
  const choose = (language) =>
    firefox.evaluate(
      ext,
      `browser.storage.local.set({ preferences: { language: ${JSON.stringify(language)}, discordRpcExtension: false } })`,
    );
  return { firefox, ext, choose };
}

/** The popup's and the dashboard's words, once the popup's footer reads `settled`. */
async function look({ firefox }, settled) {
  const popup = await firefox.openTab(`${EXTENSION}/popup.html`);
  const home = await waitUntil(async () => {
    const seen = await firefox.evaluate(
      popup,
      `({ lang: document.documentElement.lang, footer: document.getElementById("status-label").textContent })`,
    );
    return seen.footer === settled ? seen : false;
  }, `the popup's footer to read "${settled}"`);
  await firefox.evaluate(popup, 'document.getElementById("settings-button").click()');
  const settings = await firefox.evaluate(
    popup,
    '[...document.querySelectorAll(".category .row-title")].map((element) => element.textContent)',
  );
  await firefox.closeTab(popup);

  const dashboard = await firefox.openTab(`${EXTENSION}/fullscreen.html#activities`);
  await waitUntil(
    () => firefox.evaluate(dashboard, '!!document.querySelector(".activity-card")'),
    "the dashboard's Activities",
  );
  const shown = await firefox.evaluate(
    dashboard,
    `({
      nav: [...document.querySelectorAll(".nav-link")].map((element) => element.textContent.trim()),
      summary: document.querySelector('[data-slot="summary"]').textContent,
    })`,
  );
  await firefox.closeTab(dashboard);
  return { home, settings, ...shown };
}

try {
  {
    const browser = await launch("en-US", "en");
    try {
      for (const [language, expected] of Object.entries(EXPECTED)) {
        await browser.choose(language);
        const seen = await look(browser, expected.footer);
        assert(seen.home.lang === language, `${language}: <html lang> is ${seen.home.lang}`);
        assert(
          expected.settings.every((word, i) => seen.settings[i] === word),
          `${language}: settings are ${seen.settings}`,
        );
        assert(
          expected.nav.every((word, i) => seen.nav[i] === word),
          `${language}: navigation is ${seen.nav}`,
        );
        assert(expected.summary.test(seen.summary), `${language}: summary is ${seen.summary}`);
        log(`${language}: popup and dashboard are in it`);
      }

      // A PreMiD Activity's description in each language PreMiD has one in.
      for (const language of ["fr", "de"]) {
        await browser.choose(language);
        const translated = JSON.parse(
          await readFile(
            join(dist, "firefox", "activities", "descriptions", `${language}.json`),
            "utf8",
          ),
        );
        const [[activity, description]] = Object.entries(translated);
        const page = await browser.firefox.openTab(
          `${EXTENSION}/fullscreen.html#activities/${encodeURIComponent(activity)}`,
        );
        await waitUntil(
          async () =>
            (await browser.firefox.evaluate(
              page,
              `document.querySelector('[data-slot="description"]')?.textContent`,
            )) === description,
          `${activity}'s description in ${language}`,
        );
        await browser.firefox.closeTab(page);
      }
      log("a PreMiD Activity's description is in the chosen language where PreMiD has one");

      await browser.choose("auto");
      assert((await look(browser, EXPECTED.en.footer)).home.lang === "en", "automatic, English");
      log("automatic: an English Firefox gets English");
    } finally {
      await browser.firefox.close();
    }
  }

  // Automatic follows Firefox's own interface language (`i18n.getUILanguage()`), not
  // the languages it asks websites for. Firefox Developer Edition has no language
  // packs here, so asking for German leaves its interface, and so Automatic, English;
  // that a German interface gets German is covered by `resolveLanguage`'s unit tests
  // and by `languages:verify`, where Chromium's interface language can be set.
  {
    const browser = await launch("de", "auto-de");
    try {
      const seen = await look(browser, EXPECTED.en.footer);
      assert(
        seen.home.lang === "en",
        `Firefox asking for German but in English: ${seen.home.lang}`,
      );
      log("automatic: follows the interface language, not the languages asked of websites");
    } finally {
      await browser.firefox.close();
    }
  }
  console.log("[languages-firefox] ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
