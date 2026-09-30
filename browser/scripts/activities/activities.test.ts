import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCatalog, parseHosts, parseIndex, parseManifest } from "../../src/activities/manifest";
import type { ActivityInfo } from "../../src/core/activity";
import { buildActivities, type ActivitiesBuild } from "./build";
import { activityId, folderLetter, websiteFolders } from "./discover";
import { discover, linkVariants, websiteKey } from "./pipeline";
import { extractClientIds, mapPremidSettings } from "./premid";
import { SOURCE_ENV } from "./sources";

const FIXTURES = join(import.meta.dir, "fixtures");
const PAROUSIA = join(FIXTURES, "parousia");
const PREMID = join(FIXTURES, "premid");

describe("one pipeline for both sources", () => {
  test("both are walked as websites/<letter>/<Name>/, the same way", async () => {
    expect((await websiteFolders(PAROUSIA)).map((folder) => folder.path)).toEqual([
      "websites/E/Example Site",
      "websites/T/Tunes",
    ]);
    expect((await websiteFolders(PREMID)).map((folder) => folder.path)).toEqual([
      "websites/B/Blocked",
      "websites/D/Deps",
      "websites/E/Example",
      "websites/F/Future",
      "websites/N/NoClient",
      "websites/T/Tunes",
      "websites/V/Versioned",
    ]);
    expect(folderLetter("Jena")).toBe("J");
    expect(folderLetter("9anime")).toBe("0-9");
    expect(folderLetter("Ютюб")).toBe("#");
    expect(activityId("YouTube Music")).toBe("youtube-music");
    expect(activityId("Café & Bar")).toBe("cafe-bar");
  });

  test("and both come out as the same manifest: catalog entry, matcher, settings, page data, sites", async () => {
    const native = await discover("parousia", PAROUSIA);
    const premid = await discover("premid", PREMID);
    expect(native.problems).toEqual([]);
    const tunes = native.native.find((found) => found.manifest.info.id === "tunes")?.manifest;
    const example = premid.premid.find(
      (found) => found.manifest.info.id === "premid:Example",
    )?.manifest;
    expect(tunes).toEqual({
      info: {
        id: "tunes",
        name: "Tunes",
        description: "What's playing on tunes.example, for tests.",
        hosts: ["tunes.example"],
        source: "parousia",
        icon: "https://tunes.example/icon.png",
        data: ["media", "thumbnails"],
        origins: ["https://tunes.example/*"],
      },
      match: { patterns: ["https://tunes.example/listen*"] },
    });
    expect(example?.info).toEqual({
      id: "premid:Example",
      name: "Example",
      description: "Example, for tests.",
      hosts: ["example.com", "www.example.com"],
      source: "premid",
      icon: "https://cdn.example/example.png",
      keywords: ["Ejemplo", "video", "videos"],
      discordClientId: "503557087041683458",
      data: ["media", "thumbnails", "creatorIcons"],
      origins: ["*://example.com/*", "*://www.example.com/*"],
      settings: expect.any(Array),
    });
    expect(example?.match).toEqual({ regExp: "^https?[:][/][/](www[.])?example[.]com[/]" });
    expect(example?.script).toEqual({
      file: "",
      clientIds: ["503557087041683458", "503557087041683459"],
      iframe: { regExp: "^https?[:][/][/]player[.]example[/]" },
      fixed: { lang: "en" },
    });
    // What differs is only what each needs to run: a module, or a script.
    expect(Object.keys(tunes ?? {}).sort()).toEqual(["info", "match"]);
    expect(Object.keys(example ?? {}).sort()).toEqual(["info", "match", "script"]);
  });

  test("an Activity without page data needs no sites", async () => {
    const native = await discover("parousia", PAROUSIA);
    const site = native.native.find((found) => found.manifest.info.id === "example-site")?.manifest
      .info;
    expect(site?.data).toBeUndefined();
    expect(site?.origins).toBeUndefined();
  });
});

describe("native Activities (parousia-project/activities)", () => {
  test("anything out of place or out of format stops the build, and says why", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-"));
    const place = async (path: string, metadata: object): Promise<void> => {
      await mkdir(join(root, "websites", path), { recursive: true });
      await writeFile(join(root, "websites", path, "metadata.json"), JSON.stringify(metadata));
      await writeFile(
        join(root, "websites", path, "activity.ts"),
        "export default { detect: () => null };\n",
      );
    };
    const valid = {
      apiVersion: 1,
      name: "Site",
      description: "A site.",
      version: "1.0.0",
      authors: [{ name: "Test" }],
      matches: ["https://site.example/*"],
    };
    try {
      await place("S/Site", { ...valid, id: "site" });
      await place("X/Misfiled", { ...valid, id: "misfiled" });
      await place("W/Wrong Id", { ...valid, id: "wrong" });
      await place("E/Everywhere", { ...valid, id: "everywhere", matches: ["*://*/*"] });
      await place("U/Unknown", { ...valid, id: "unknown", permissions: ["tabs"] });
      await place("C/Creators", { ...valid, id: "creators", data: ["creatorIcons"] });
      await place("I/Icon", { ...valid, id: "icon", icon: "http://site.example/icon.png" });
      const { native, problems } = await discover("parousia", root);
      expect(native.map((found) => found.manifest.info.id)).toEqual(["site"]);
      expect(problems).toEqual([
        'websites/C/Creators: data: "creatorIcons" isn\'t one of media, thumbnails',
        'websites/E/Everywhere: matches: "*://*/*" isn\'t a match pattern for particular sites',
        "websites/I/Icon: icon must be an https image URL of at most 256 characters",
        'websites/U/Unknown: unknown key "permissions"',
        'websites/W/Wrong Id: id must be "wrong-id", the folder\'s name in lowercase words joined by "-"',
        "websites/X/Misfiled: it goes in websites/M/",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("websites in both sources", () => {
  test("are linked by folder name, never by a site they happen to share", () => {
    const info = (id: string, source: "parousia" | "premid", hosts: string[]) => {
      const entry: ActivityInfo = { id, name: id, hosts, source };
      return { info: entry };
    };
    const native = [
      { site: "youtube", manifest: info("youtube", "parousia", ["www.youtube.com"]) },
      { site: "google", manifest: info("google", "parousia", ["google.com"]) },
    ];
    const premid = [
      { site: "youtube", manifest: info("premid:YouTube", "premid", ["m.youtube.com"]) },
      { site: "google-docs", manifest: info("premid:Google Docs", "premid", ["google.com"]) },
    ];
    linkVariants(native, premid);
    expect(native[0]?.manifest.info.variants).toEqual(["youtube", "premid:YouTube"]);
    expect(premid[0]?.manifest.info.variants).toEqual(["youtube", "premid:YouTube"]);
    expect(native[1]?.manifest.info.variants).toBeUndefined();
    expect(premid[1]?.manifest.info.variants).toBeUndefined();
  });
});

describe("the identity of a website across sources", () => {
  const entry = (id: string, source: "parousia" | "premid", name = id) => {
    const info: ActivityInfo = { id, name, hosts: ["site.example"], source };
    return { info };
  };

  test("ignores punctuation and spacing in the folder name, never the display name", () => {
    expect(websiteKey(activityId("Discord.js"))).toBe("discordjs");
    expect(websiteKey(activityId("DiscordJS"))).toBe("discordjs");
    expect(websiteKey(activityId("Discord JS"))).toBe("discordjs");
    expect(websiteKey(activityId("YouTube Music"))).not.toBe(websiteKey(activityId("YouTube")));

    const native = [{ site: activityId("DiscordJS"), manifest: entry("discordjs", "parousia") }];
    // A different display name says nothing; the folder is what counts.
    const premid = [
      { site: activityId("Discord.js"), manifest: entry("premid:Discord.js", "premid", "Docs") },
      { site: activityId("Discord Bots"), manifest: entry("premid:Discord Bots", "premid") },
    ];
    linkVariants(native, premid);
    expect(native[0]?.manifest.info.variants).toEqual(["discordjs", "premid:Discord.js"]);
    expect(premid[0]?.manifest.info.variants).toEqual(["discordjs", "premid:Discord.js"]);
    expect(premid[1]?.manifest.info.variants).toBeUndefined();
  });

  test("every PreMiD implementation of a website joins its native one, native first", () => {
    const native = [{ site: "video", manifest: entry("video", "parousia") }];
    const premid = [
      { site: "video", manifest: entry("premid:Video", "premid") },
      { site: "vid-eo", manifest: entry("premid:Vid.eo", "premid") },
    ];
    linkVariants(native, premid);
    const all = ["video", "premid:Video", "premid:Vid.eo"];
    expect(native[0]?.manifest.info.variants).toEqual(all);
    expect(premid.map((found) => found.manifest.info.variants)).toEqual([all, all]);
  });

  test("a name with no letters or digits identifies nothing, so it links to nothing", () => {
    const native = [{ site: "", manifest: entry("odd", "parousia") }];
    const premid = [
      { site: "", manifest: entry("premid:巴哈姆特", "premid") },
      { site: "", manifest: entry("premid:라프텔", "premid") },
    ];
    linkVariants(native, premid);
    expect(native[0]?.manifest.info.variants).toBeUndefined();
    expect(premid[0]?.manifest.info.variants).toBeUndefined();
  });

  test("two native Activities can't be the same website", async () => {
    const root = await mkdtemp(join(tmpdir(), "parousia-twins-"));
    try {
      for (const [folder, id] of [
        ["D/Discord.js", "discord-js"],
        ["D/DiscordJS", "discordjs"],
      ] as const) {
        await mkdir(join(root, "websites", folder), { recursive: true });
        await writeFile(
          join(root, "websites", folder, "metadata.json"),
          JSON.stringify({
            apiVersion: 1,
            id,
            name: "Docs",
            description: "Docs.",
            version: "1.0.0",
            authors: [{ name: "Test" }],
            matches: ["https://discord.js.example/*"],
          }),
        );
        await writeFile(
          join(root, "websites", folder, "activity.ts"),
          "export default { detect: () => null };\n",
        );
      }
      const { native, problems } = await discover("parousia", root);
      expect(native.map((found) => found.manifest.info.id)).toEqual(["discord-js"]);
      expect(problems).toEqual([
        "websites/D/DiscordJS: it is the same website as websites/D/Discord.js's (names that differ only in punctuation or spacing)",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PreMiD Activities (PreMiD/Activities)", () => {
  test("found the way PreMiD's tooling finds them, and left out with a reason when they don't fit", async () => {
    const { premid, excluded } = await discover("premid", PREMID);
    expect(premid.map((found) => found.manifest.info.id)).toEqual([
      "premid:Example",
      "premid:Tunes",
      "premid:Versioned",
    ]);
    expect(premid.map((found) => found.site)).toEqual(["example", "tunes", "versioned"]);
    expect(premid[2]?.dir).toEndWith(join("V", "Versioned", "v1"));
    expect(excluded).toEqual([
      { service: "Blocked", reason: "it's on PreMiD's DMCA list" },
      {
        service: "Deps",
        reason: "it needs its own npm packages (p-limit), which Parousia doesn't install",
      },
      { service: "Future", reason: "Activity API 2 isn't supported yet" },
      { service: "NoClient", reason: "no Discord client id in its source" },
    ]);
    expect(premid[0]?.strings).toEqual({ "example.custom": "right now" });
  });

  test("settings map to Parousia's: switches, choices by index, text, numbers, and conditions", () => {
    const { settings, fixed } = mapPremidSettings([
      { id: "lang", multiLanguage: true },
      { id: "buttons", title: "Show Buttons", icon: "fad fa-link", value: true },
      { id: "cover", title: "Cover", value: 1, values: ["Logo", "Cover"], if: { buttons: true } },
      { id: "format", title: "Format", value: "%title%", placeholder: "%title%" },
      { id: "ttl", title: "Cache TTL", value: 360 },
      { id: "mode", title: "Cache mode", value: "session", values: ["off", "session"] },
      { id: "polish", title: "Polish only", value: false, if: { lang: "pl" } },
      { id: "english", title: "English only", value: false, if: { lang: "en", buttons: true } },
      { id: "untitled", value: true },
    ]);
    expect(fixed).toEqual({ lang: "en" });
    expect(settings).toEqual([
      { id: "buttons", title: "Show Buttons", type: "boolean", default: true },
      {
        id: "cover",
        title: "Cover",
        type: "choice",
        default: 1,
        choices: ["Logo", "Cover"],
        when: { buttons: true },
      },
      { id: "format", title: "Format", type: "text", default: "%title%", placeholder: "%title%" },
      { id: "ttl", title: "Cache TTL", type: "number", default: 360 },
      { id: "mode", title: "Cache mode", type: "choice", default: 1, choices: ["off", "session"] },
      {
        id: "english",
        title: "English only",
        type: "boolean",
        default: false,
        when: { buttons: true },
      },
    ]);
  });

  test("client ids are found as PreMiD's own check finds them", () => {
    expect(
      extractClientIds([
        "const presence = new Presence({ clientId: '463097721130188830' })",
        "enum Apps { A = '463097721130188831', B = \"463097721130188832\" }\nnew Presence({ clientId: Apps.B })",
        "const other = { clientId: 'not-a-number', id: '463097721130188833' }",
      ]),
    ).toEqual(["463097721130188830", "463097721130188831", "463097721130188832"]);
  });
});

describe("the packaged build", () => {
  let build: ActivitiesBuild;
  let out: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env[SOURCE_ENV.parousia] = PAROUSIA;
    process.env[SOURCE_ENV.premid] = PREMID;
    build = await buildActivities();
    out = await mkdtemp(join(tmpdir(), "activities-"));
    await build.writeTo(out);
  });

  afterAll(async () => {
    process.env = saved;
    await rm(out, { recursive: true, force: true });
  });

  const read = (path: string): Promise<unknown> => Bun.file(join(out, path)).json();

  test("packages one catalog for both sources, and the files each needs to run", async () => {
    const catalog = parseCatalog(await read("activities/catalog.json"));
    expect(catalog.activities.map((info) => info.id)).toEqual([
      "example-site",
      "tunes",
      "premid:Example",
      "premid:Tunes",
      "premid:Versioned",
    ]);
    expect(Object.keys(catalog.sources).sort()).toEqual(["parousia", "premid"]);
    expect(parseIndex(await read("activities/index.json")).files).toEqual({
      "example-site": "native/example-site",
      tunes: "native/tunes",
      "premid:Example": "premid/example",
      "premid:Tunes": "premid/tunes",
      "premid:Versioned": "premid/versioned",
    });
    expect(parseManifest(await read("activities/premid/example.json"))?.script?.file).toBe(
      "example",
    );
    // The list needs no settings, page data, or Discord Applications: each manifest has those.
    const example = catalog.activities.find((info) => info.id === "premid:Example");
    expect(example?.settings).toBeUndefined();
    expect(example?.data).toBeUndefined();
    expect(example?.discordClientId).toBeUndefined();
    expect(example?.origins).toEqual(["*://example.com/*", "*://www.example.com/*"]);
    const full = parseManifest(await read("activities/premid/example.json"))?.info;
    expect(full?.settings?.length).toBeGreaterThan(0);
    expect(full?.discordClientId).toBe("503557087041683458");
    expect(parseManifest(await read("activities/native/tunes.json"))?.info.data).toEqual([
      "media",
      "thumbnails",
    ]);
    expect(parseHosts(await read("activities/hosts.json")).hosts).toEqual({
      "example.site": ["native/example-site"],
      "tunes.example": ["native/tunes", "premid/tunes"],
      "example.com": ["premid/example"],
      "www.example.com": ["premid/example"],
      "versioned.example": ["premid/versioned"],
    });
    for (const file of [
      "activities/collector.js",
      "activities/premid/runtime.js",
      "activities/premid/example.js",
      "activities/premid/example.iframe.js",
      "activities/premid/versioned.js",
      "activities/premid/LICENSE.txt",
      "activities/premid/SOURCE.txt",
    ]) {
      expect(await Bun.file(join(out, file)).exists()).toBe(true);
    }
    expect(await Bun.file(join(out, "activities/premid/SOURCE.txt")).text()).toContain(
      "Mozilla Public License 2.0",
    );
  });

  test("a website in both sources is marked in both, native first, and listed once", async () => {
    const catalog = parseCatalog(await read("activities/catalog.json")).activities;
    const variants = ["tunes", "premid:Tunes"];
    expect(catalog.find((info) => info.id === "tunes")?.variants).toEqual(variants);
    expect(catalog.find((info) => info.id === "premid:Tunes")?.variants).toEqual(variants);
    expect(catalog.find((info) => info.id === "premid:Example")?.variants).toBeUndefined();
    // The background reads PreMiD's manifest and bundles the native one: both know.
    expect(parseManifest(await read("activities/premid/tunes.json"))?.info.variants).toEqual(
      variants,
    );
    expect(build.native.find((found) => found.site === "tunes")?.manifest.info.variants).toEqual(
      variants,
    );
    expect(build.summary).toContain("1 website is in both sources");
  });

  test("native Activities are bundled in through parousia:activities, as manifests with their modules", async () => {
    const entry = join(out, "entry.ts");
    await writeFile(
      entry,
      [
        'import { native } from "parousia:activities";',
        "export const found = native.map(({ manifest, module }) => [manifest.info.id, module.detect(",
        '  { url: new URL("https://tunes.example/listen/1?b"), title: "Home", granted: ["media"], media: { title: "Song" } },',
        "  {},",
        ")?.details]);",
      ].join("\n"),
    );
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      plugins: [build.plugin],
    });
    expect(result.success).toBe(true);
    const bundled = join(out, "bundled.mjs");
    await writeFile(bundled, (await result.outputs[0]?.text()) ?? "");
    const module: unknown = await import(bundled);
    expect(
      typeof module === "object" && module !== null && "found" in module ? module.found : null,
    ).toEqual([
      ["example-site", "undefined Home"],
      ["tunes", "Song"],
    ]);
  });

  test("an unmodified PreMiD Activity runs on Parousia's runtime and reports through its port", async () => {
    const runtime = await Bun.file(join(out, "activities/premid/runtime.js")).text();
    const script = await Bun.file(join(out, "activities/premid/example.js")).text();
    const posted: unknown[] = [];
    let receive: (message: unknown) => void = () => {};
    const scope = globalThis as Record<string, unknown>;
    const globals = ["window", "document", "chrome", "location"] as const;
    const before = new Map(globals.map((key) => [key, scope[key]]));
    const page = { top: undefined as unknown, addEventListener: () => {} };
    page.top = page;
    scope.window = page;
    scope.location = { href: "https://example.com/watch" };
    scope.document = {
      hidden: false,
      title: "A Video",
      readyState: "complete",
      addEventListener: () => {},
      getElementsByTagName: () => [],
    };
    scope.chrome = {
      runtime: {
        connect: () => ({
          postMessage: (message: unknown) => posted.push(message),
          onMessage: {
            addListener: (listener: (message: unknown) => void) => (receive = listener),
          },
          onDisconnect: { addListener: () => {} },
          disconnect: () => {},
        }),
      },
    };
    try {
      // Running the packaged files as a browser would inject them is the point of this test.
      // oxlint-disable-next-line no-eval
      (0, eval)(runtime);
      // oxlint-disable-next-line no-eval
      (0, eval)(script);
      // A second injection into the same document doesn't run it twice.
      // oxlint-disable-next-line no-eval
      (0, eval)(script);
      expect(posted).toEqual([
        { type: "hello", activity: "premid:Example", clientId: "503557087041683458" },
      ]);

      receive({ type: "settings", values: { lang: "en", buttons: true } });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const report = posted.at(-1) as {
        type: string;
        clientId: string;
        data: Record<string, unknown>;
      };
      expect(report.type).toBe("activity");
      expect(report.data).toMatchObject({
        details: "A Video",
        state: "Playing right now",
        buttons: [{ label: "Open", url: "https://example.com/watch" }],
      });
      expect(Number(report.data.endTimestamp) - Number(report.data.startTimestamp)).toBe(90);

      receive({ type: "settings", values: { lang: "en", buttons: false } });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const next = posted.at(-1) as { data: Record<string, unknown> };
      expect(next.data.buttons).toBeUndefined();

      // Stopped (turned off, or its site taken back), then turned on again: injected again, it runs anew.
      receive({ type: "stop" });
      // oxlint-disable-next-line no-eval
      (0, eval)(script);
      expect(posted.at(-1)).toEqual({
        type: "hello",
        activity: "premid:Example",
        clientId: "503557087041683458",
      });
      receive({ type: "stop" });
    } finally {
      for (const [key, value] of before) scope[key] = value;
    }
  });
});
