// End-to-end check of the themes (Settings > Appearance) in playwright-core's
// Chromium, on the extension as built in dist/chromium. No Desktop is
// needed: pages show their not-connected states, which is enough to draw
// every surface.
//
// Covers:
// - Atelier by default; choosing with the keyboard (arrow keys in a native
//   radio group) applies at once, persists in storage, and survives a reload.
// - The first paint: theme.js sets the theme while <head> is parsed, before
//   <body> exists, and storage's answer corrects a stale cached copy.
// - A choice in one view reaches the others (dashboard -> popup).
// - Isolation: each theme preview is drawn with its own theme's tokens,
//   whatever the page's theme.
// - Every surface in every theme: text contrast measured on the rendered
//   page (computed colors over the real stack of backgrounds), and a visible
//   focus ring on every control reachable with Tab.
// - prefers-reduced-motion: no animations or transitions.
//
// THEME_SHOTS=<dir> also saves a screenshot of every surface in every theme.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  QUIET_DISCORD,
  STEP_TIMEOUT_MS,
  assert,
  browserDir,
  logger,
  waitUntil,
} from "./e2e/lib.mjs";

const log = logger("themes");
const extensionDir = join(browserDir, process.env.PAROUSIA_BUILD_DIR ?? "dist", "chromium");
const shots = process.env.THEME_SHOTS;
const THEMES = ["atelier", "botanique", "monolith"];
const BACKGROUNDS = {
  atelier: "rgb(43, 35, 34)",
  botanique: "rgb(22, 34, 31)",
  monolith: "rgb(28, 27, 25)",
};

const DASHBOARD = [
  "#overview",
  "#activities",
  "activity",
  "#default",
  "#settings/general",
  "#settings/appearance",
  "#settings/privacy",
  "#settings/access",
  "#settings/platforms",
  "#settings/connections",
  "#settings/about",
];

/**
 * Runs in the page: every visible text's contrast against what's actually
 * behind it (background colors composited up the ancestors), and its size
 * for AA's large-text rule. Disabled controls are exempt (WCAG 1.4.3).
 */
function measureText() {
  const parse = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value);
    if (!match) return null;
    const [r, g, b, a = 1] = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return [r, g, b, a];
  };
  const over = (top, bottom) =>
    [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const backdrop = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color[3] > 0) layers.push(color);
      if (color && color[3] === 1) break;
    }
    return layers.reverse().reduce((under, layer) => over(layer, under));
  };
  const results = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const element = text.parentElement;
    if (!element || !text.textContent.trim()) continue;
    if (element.closest("[hidden], [aria-hidden='true'], .visually-hidden, template, :disabled"))
      continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const background = backdrop(element);
    const color = over(parse(style.color), background);
    const size = Number.parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    results.push({
      text: text.textContent.trim().slice(0, 40),
      ratio: ratio(color, background),
      required: large ? 3 : 4.5,
    });
  }
  return results;
}

/** Tabs through the page; every focused control must show a ring (its own, or its field's). */
async function checkFocusRings(page, label) {
  await page.evaluate(() => document.activeElement?.blur());
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      const ring = (node) => {
        const style = getComputedStyle(node);
        return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2
          ? style.outlineColor
          : null;
      };
      return {
        key: element.outerHTML.slice(0, 80),
        ring: ring(element) ?? (element.parentElement && ring(element.parentElement)),
      };
    });
    if (!focus || seen.has(focus.key)) break;
    seen.add(focus.key);
    assert(focus.ring, `${label}: no focus ring on ${focus.key}`);
  }
  return seen.size;
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "parousia-themes-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: STEP_TIMEOUT_MS }));
    await worker.evaluate(QUIET_DISCORD);
    const base = `chrome-extension://${new URL(worker.url()).host}`;
    const stored = () =>
      worker.evaluate(async () => (await chrome.storage.local.get("theme")).theme);
    if (shots) await mkdir(shots, { recursive: true });

    // Every change to data-theme, and whether <body> existed yet when it happened. This
    // can run before <html> exists, so it watches the whole document.
    await context.addInitScript(() => {
      window.__themeLog = [];
      new MutationObserver((mutations) => {
        for (const mutation of mutations)
          if (mutation.attributeName === "data-theme")
            window.__themeLog.push({
              theme: document.documentElement.dataset.theme,
              body: document.body !== null,
            });
      }).observe(document, { subtree: true, attributeFilter: ["data-theme"] });
    });

    const page = await context.newPage();
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.goto(`${base}/fullscreen.html#overview`);
    assert((await theme()) === "atelier", "Atelier is the default");
    assert((await background()) === BACKGROUNDS.atelier, "Atelier draws Deep Espresso");
    log("a new profile opens in Atelier");

    // --- Choosing with the keyboard ---
    await page.goto(`${base}/fullscreen.html#settings/appearance`);
    const group = page.locator("[role=radiogroup][aria-labelledby=theme-label]");
    assert((await group.locator("input[type=radio]").count()) === 3, "three themes offered");
    const names = await group
      .locator("input[type=radio]")
      .evaluateAll((inputs) =>
        inputs.map(
          (input) => document.getElementById(input.getAttribute("aria-labelledby")).textContent,
        ),
      );
    assert(names.join() === "Atelier,Botanique,Monolith", `radios are named ${names}`);
    await page.focus("input[name=theme]:checked");
    assert(
      (await page.inputValue("input[name=theme]:checked")) === "atelier",
      "Atelier is checked",
    );
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert(ring === "solid", "the focused radio shows a ring");
    await page.keyboard.press("ArrowDown");
    await waitUntil(async () => (await stored()) === "botanique", "Botanique stored");
    assert((await theme()) === "botanique", "ArrowDown applies Botanique at once");
    assert((await background()) === BACKGROUNDS.botanique, "Botanique draws its pine");
    await page.keyboard.press("ArrowDown");
    await waitUntil(async () => (await stored()) === "monolith", "Monolith stored");
    assert((await background()) === BACKGROUNDS.monolith, "Monolith draws its charcoal");
    log("arrow keys move through the themes, each applied and stored at once");

    // --- Isolation: previews use their own theme's tokens ---
    const previews = await page.$$eval(".theme-preview", (nodes) =>
      nodes.map((node) => [node.dataset.theme, getComputedStyle(node).backgroundColor]),
    );
    for (const [id, color] of previews)
      assert(color === BACKGROUNDS[id], `${id} preview draws ${color}`);
    const themed = await page.$$eval(
      "[data-theme]",
      (nodes) =>
        nodes.filter((node) => node !== document.documentElement && !node.matches(".theme-preview"))
          .length,
    );
    assert(themed === 0, "no element but the previews sets a theme of its own");
    log("each preview draws its own theme inside a Monolith page; nothing else is themed apart");

    // --- Persistence and the first paint ---
    await page.reload();
    assert((await theme()) === "monolith", "Monolith survives a reload");
    let history = await page.evaluate(() => window.__themeLog);
    assert(history[0]?.theme === "monolith" && !history[0].body, "set before <body> was parsed");
    // A stale cached copy (another theme in localStorage) is corrected by storage.
    await page.evaluate(() => localStorage.setItem("parousia-theme", "botanique"));
    await page.reload();
    await waitUntil(async () => (await theme()) === "monolith", "storage's theme wins");
    history = await page.evaluate(() => window.__themeLog);
    assert(
      history[0]?.theme === "botanique" && !history[0].body,
      "cached copy applied before <body>",
    );
    assert(
      await page.evaluate(() => localStorage.getItem("parousia-theme") === "monolith"),
      "cache repaired",
    );
    // No cached copy at all (cleared site data): storage alone restores it.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitUntil(async () => (await theme()) === "monolith", "storage restores the theme");
    log(
      "the theme is on before <body> is parsed, persists, and a stale or missing cache is repaired",
    );

    // --- Other views follow ---
    const popupPage = await context.newPage();
    await popupPage.setViewportSize({ width: 360, height: 640 });
    await popupPage.goto(`${base}/popup.html`);
    assert(
      (await popupPage.evaluate(() => document.documentElement.dataset.theme)) === "monolith",
      "popup opens in Monolith",
    );
    await page.click("label.theme-option:has(input[value=atelier])");
    await waitUntil(
      () => popupPage.evaluate(() => document.documentElement.dataset.theme === "atelier"),
      "the popup to follow",
    );
    log("a choice in the dashboard reaches an open popup");

    // --- Every surface in every theme ---
    await page.goto(`${base}/fullscreen.html#activities`);
    await page.waitForSelector(".activity-link");
    const activity = await page.getAttribute(".activity-link", "href");
    let measured = 0;
    let lowest = { ratio: Infinity };
    const record = (results, label) => {
      for (const result of results) {
        measured++;
        if (result.ratio / result.required < (lowest.ratio ?? Infinity) / (lowest.required ?? 1))
          lowest = { ...result, label };
        assert(
          result.ratio >= result.required,
          `${label}: "${result.text}" is ${result.ratio.toFixed(2)}:1, under ${result.required}`,
        );
      }
    };
    let rings = 0;
    for (const id of THEMES) {
      await worker.evaluate((value) => chrome.storage.local.set({ theme: value }), id);
      for (const route of DASHBOARD) {
        const hash = route === "activity" ? activity : route;
        await page.goto(`${base}/fullscreen.html${hash}`);
        await waitUntil(async () => (await theme()) === id, `${id} on ${hash}`);
        await page.waitForTimeout(250);
        await page.mouse.move(0, 0);
        record(await page.evaluate(measureText), `${id} ${hash}`);
        rings += await checkFocusRings(page, `${id} ${hash}`);
        if (shots)
          await page.screenshot({
            path: join(shots, `${id}-dashboard-${hash.replace(/\W+/g, "-")}.png`),
            fullPage: true,
          });
      }
      await popupPage.goto(`${base}/popup.html`);
      await waitUntil(
        () => popupPage.evaluate((v) => document.documentElement.dataset.theme === v, id),
        `popup in ${id}`,
      );
      await popupPage.waitForTimeout(250);
      const popupViews = [
        ["home", async () => {}],
        ["settings", () => popupPage.click("#settings-button")],
        ["appearance", () => popupPage.click(".category:has-text('Appearance')")],
      ];
      for (const [name, open] of popupViews) {
        await open();
        await popupPage.waitForTimeout(150);
        record(await popupPage.evaluate(measureText), `${id} popup ${name}`);
        rings += await checkFocusRings(popupPage, `${id} popup ${name}`);
        if (shots)
          await popupPage.screenshot({
            path: join(shots, `${id}-popup-${name}.png`),
            fullPage: true,
          });
      }
    }
    log(
      `${DASHBOARD.length} dashboard pages and 3 popup views in each theme: ${measured} texts all pass AA` +
        ` (closest: ${lowest.ratio.toFixed(2)}:1 for "${lowest.text}", ${lowest.label}), ${rings} focus stops all ringed`,
    );

    // --- Reduced motion ---
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${base}/fullscreen.html#settings/appearance`);
    const motion = await page.evaluate(() => {
      const dot = document.getElementById("status-dot");
      dot.dataset.tone = "busy";
      const option = document.querySelector(".theme-option");
      return {
        animation: getComputedStyle(dot).animationName,
        transition: getComputedStyle(document.querySelector(".nav-link")).transitionDuration,
        option: getComputedStyle(option).transitionDuration,
      };
    });
    assert(motion.animation === "none", `busy dot animates: ${motion.animation}`);
    assert(
      motion.transition === "0s" && motion.option === "0s",
      `transitions run: ${JSON.stringify(motion)}`,
    );
    log("with prefers-reduced-motion, nothing animates or transitions");

    log("done");
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

await main();
