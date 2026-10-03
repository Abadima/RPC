// Watches the real YouTube and YouTube Music Activities (PreMiD's, run
// unchanged) on the real sites, in playwright-core's Chromium with Desktop
// and a stand-in Discord: what reaches Discord as a video loads, plays,
// pauses, and as the page navigates without reloading. Needs the network.
//
// A browser grants a site only through a prompt automation can't answer, so
// this build's manifest already holds the sites (as in verify-activities).
//
// Prerequisites: `bun run activities:fetch`, `cargo build` in ../desktop.
// Linux only; port 57179 must be free.

import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { startFakeDiscord } from "./e2e/fake-discord.mjs";
import {
  QUIET_DISCORD,
  STEP_TIMEOUT_MS,
  assert,
  browserDir,
  control,
  logger,
  sleep,
  startDesktop,
  waitUntil,
  workspace,
  readManifest,
} from "./e2e/lib.mjs";

const log = logger("youtube");
const run = promisify(execFile);

const YOUTUBE = "premid:YouTube";
const MUSIC = "premid:YouTube Music";
const VIDEO = process.env.YOUTUBE_VIDEO ?? "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const SONG = process.env.YOUTUBE_MUSIC ?? "https://music.youtube.com/watch?v=dQw4w9WgXcQ";
const PATIENCE_MS = 45_000;

const ws = await workspace("pyt");
const discord = await startFakeDiscord(ws.discordDir);
const extensionDir = join(ws.dir, "extension");
let desktop;
let context;

try {
  await run("bun", ["run", "build.ts"], {
    cwd: browserDir,
    env: { ...process.env, PAROUSIA_BUILD_DIR: join(ws.dir, "dist") },
  });
  await cp(join(ws.dir, "dist", "chromium"), extensionDir, { recursive: true });
  const origins = [];
  for (const id of [YOUTUBE, MUSIC]) {
    const manifest = await readManifest(extensionDir, id);
    assert(manifest, `${id} is packaged`);
    origins.push(...manifest.info.origins);
  }
  const manifestPath = join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.permissions = [...manifest.permissions, "scripting"];
  manifest.host_permissions = origins;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  log(`built; sites held as granted: ${origins.join(", ")}`);

  desktop = startDesktop(ws);
  await desktop.waitFor(/listening on 127\.0\.0\.1:57179/);
  context = await chromium.launchPersistentContext(join(ws.dir, "profile"), {
    channel: "chromium",
    headless: true,
    // YouTube Music turns away a browser that says it's headless.
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: STEP_TIMEOUT_MS }));
  const extension = `chrome-extension://${new URL(worker.url()).host}`;
  await worker.evaluate(QUIET_DISCORD);
  await control(ws, "allow", extension);
  // Native Activities for the same websites exist too, and run unless PreMiD's is chosen.
  await worker.evaluate(
    (ids) =>
      chrome.storage.local.set({
        activities: {
          ...Object.fromEntries(ids.map((id) => [id, { on: true }])),
          youtube: { use: ids[0] },
          "youtube-music": { use: ids[1] },
        },
      }),
    [YOUTUBE, MUSIC],
  );

  const lastShown = () => discord.activities.at(-1) ?? null;
  const describe = (activity) =>
    activity
      ? `${activity.name} | ${activity.details ?? ""} | ${activity.state ?? ""} | image ${String(activity.assets?.large_image ?? "none").slice(0, 70)}`
      : "nothing";

  /** The popup's line for `page`'s tab. */
  async function popupLine(page) {
    await page.bringToFront();
    const opened = context.waitForEvent("page", (p) => p.url().endsWith("/popup.html"));
    await worker.evaluate(() =>
      chrome.windows.create({ url: chrome.runtime.getURL("popup.html"), focused: false }),
    );
    const popup = await opened;
    await popup.waitForLoadState();
    await sleep(800);
    const text = (await popup.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200);
    await popup.close();
    await page.bringToFront();
    return text;
  }

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.text().includes("Parousia")) log(`page console: ${message.text().slice(0, 200)}`);
  });

  /** Waits for what Discord shows to pass `check`, and logs it. */
  async function showing(check, description, timeoutMs = PATIENCE_MS) {
    const activity = await waitUntil(
      () => {
        const last = lastShown();
        return last && check(last) ? last : false;
      },
      `Discord to show ${description} (last: ${describe(lastShown())})`,
      timeoutMs,
    );
    log(`${description}: ${describe(activity)}`);
    return activity;
  }
  const consent = (target) =>
    target
      .locator('button:has-text("Accept all"), button:has-text("Reject all")')
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});
  const play = (target) =>
    target.evaluate(
      () =>
        void document
          .querySelector("video")
          ?.play()
          .catch(() => {}),
    );

  // --- YouTube: a video, as it loads, plays, pauses, resumes, and moves on ---
  await page.goto(VIDEO, { waitUntil: "domcontentloaded" });
  await consent(page);
  await page.locator("video").first().waitFor({ state: "attached", timeout: PATIENCE_MS });
  await play(page);
  const playing = await showing(
    (a) => a.name === "YouTube" && a.details && a.details !== "Watching a video",
    "the video being watched",
  );
  assert(playing.timestamps?.start, `with elapsed time (${JSON.stringify(playing.timestamps)})`);
  // YouTube's default image setting draws the thumbnail onto a canvas and hands over a
  // PNG far larger than a message may be. It has to arrive as the picture's own address.
  const videoId = new URL(VIDEO).searchParams.get("v");
  assert(
    String(playing.assets?.large_image ?? "").startsWith(`https://i3.ytimg.com/vi/${videoId}/`),
    `with the video's own thumbnail, not the logo (${playing.assets?.large_image})`,
  );
  log(`popup, while playing: ${await popupLine(page)}`);

  await page.evaluate(() => document.querySelector("video")?.pause());
  await showing(
    (a) => !a.timestamps?.start && a.details === playing.details,
    "the same video, paused",
  );
  await play(page);
  await showing((a) => a.timestamps?.start && a.details === playing.details, "and playing again");

  // A page with no video, reached without a reload (YouTube is a single-page app): the same
  // Activity says it's browsing, and the video's details are gone.
  await page.evaluate(() => document.querySelector("video")?.pause());
  await page.locator("a#logo, ytd-topbar-logo-renderer a").first().click({ timeout: 10_000 });
  await showing(
    (a) => a.name === "YouTube" && a.details !== playing.details,
    "what's shown after leaving the video through the page's own navigation",
  );
  log(`popup, on the home page: ${await popupLine(page)}`);
  await page.goto(VIDEO, { waitUntil: "domcontentloaded" });
  await play(page);
  await showing(
    (a) =>
      a.details === playing.details &&
      String(a.assets?.large_image ?? "").includes(`/vi/${videoId}/`),
    "the video again after a full load, thumbnail included",
  );

  // Another video through the page's own navigation: its title and its thumbnail follow.
  const next = await page
    .locator('a[href^="/watch?v="]')
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute("href"))
        .find((href) => href && !href.includes("list=")),
    );
  const nextId = new URLSearchParams(String(next).split("?")[1]).get("v");
  // The link may be in a collapsed sidebar; a click event still goes through YouTube's own router.
  await page
    .locator(`a[href^="/watch?v=${nextId}"]`)
    .first()
    .evaluate((link) => link.click());
  await play(page);
  const moved = await showing(
    (a) =>
      a.name === "YouTube" &&
      a.details !== playing.details &&
      String(a.assets?.large_image ?? "").includes(`/vi/${nextId}/`),
    "the next video, with its own thumbnail",
  );
  log(`next video: ${describe(moved)}`);

  // --- YouTube Music ---
  const music = await context.newPage();
  await music.goto(SONG, { waitUntil: "domcontentloaded" });
  await consent(music);
  await music
    .locator("video")
    .first()
    .waitFor({ state: "attached", timeout: PATIENCE_MS })
    .catch(async () => {
      log(
        `YouTube Music has no player: ${await music.title()} | ${(await music.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200)}`,
      );
      await music.screenshot({ path: join(ws.dir, "music.png") });
      log(`screenshot: ${join(ws.dir, "music.png")}`);
    });
  await music.bringToFront();
  await play(music);
  const song = await showing(
    (a) => a.name === "YouTube Music" && a.details && a.details !== "Browsing...",
    "YouTube Music's song",
  ).catch(async (error) => {
    log(`YouTube Music showed nothing: ${error.message.slice(0, 200)}`);
    log(`popup: ${await popupLine(music)}`);
    return null;
  });
  if (song) {
    assert(
      String(song.assets?.large_image ?? "").startsWith("https://") &&
        !String(song.assets.large_image).includes("/PreMiD/websites/"),
      `YouTube Music's artwork reached Discord (${song.assets?.large_image})`,
    );
    log(`popup, on YouTube Music: ${await popupLine(music)}`);
  } else {
    throw new Error("YouTube Music showed no song");
  }
  log("done");
} finally {
  await context?.close().catch(() => {});
  await desktop?.stop();
  await discord.stop();
  await ws.cleanup();
}
