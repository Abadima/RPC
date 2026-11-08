import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostIds, manifestShard, parseCatalog, parseShard } from "../../src/activities/manifest";
import type { ActivityInfo } from "../../src/core/activity";
import { buildActivities, type ActivitiesBuild } from "./build";
import { activityId, folderLetter, websiteFolders } from "./discover";
import { versionFrom } from "./metadata";
import { discover, linkVariants, websiteKey } from "./pipeline";
import {
  compilePremid,
  descriptionFiles,
  extractClientIds,
  mapPremidSettings,
  readDescriptions,
  wrapScript,
  type PremidFound,
} from "./premid";
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
      "websites/V/VLC",
    ]);
    expect(folderLetter("Jena")).toBe("J");
    expect(folderLetter("9anime")).toBe("0-9");
    expect(folderLetter("Ютюб")).toBe("#");
    expect(activityId("YouTube Music")).toBe("youtube-music");
    expect(activityId("Café & Bar")).toBe("cafe-bar");
  });

  test("PreMiD's translated descriptions are kept for the languages the views have, and go to one file each", async () => {
    expect(
      readDescriptions({ en: "x", fr: " Bonjour ", de: "Hallo", es: "Hola", ja: " ", ru: 4 }),
    ).toEqual({
      fr: "Bonjour",
      de: "Hallo",
      es: "Hola",
    });
    expect(readDescriptions({ zh: "x".repeat(1000) }).zh).toHaveLength(256);
    expect(readDescriptions("Example")).toEqual({});
    const premid = await discover("premid", PREMID);
    const example = premid.premid.find((found) => found.manifest.info.id === "premid:Example");
    expect(example?.descriptions).toEqual({
      de: "Beispiel, für Tests.",
      fr: "Exemple, pour les tests.",
      zh: "示例，用于测试。",
    });
    const files = descriptionFiles(premid.premid);
    expect([...files.keys()].sort()).toEqual([
      "activities/descriptions/de.json",
      "activities/descriptions/fr.json",
      "activities/descriptions/zh.json",
    ]);
    expect(JSON.parse(files.get("activities/descriptions/fr.json") ?? "")).toEqual({
      "premid:Example": "Exemple, pour les tests.",
    });
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
        version: "1.2.3",
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
      version: "2.0.5",
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
      await place("V/Version", { ...valid, id: "version", version: "1.0" });
      const { native, problems } = await discover("parousia", root);
      expect(native.map((found) => found.manifest.info.id)).toEqual(["site"]);
      expect(problems).toEqual([
        'websites/C/Creators: data: "creatorIcons" isn\'t one of media, thumbnails',
        'websites/E/Everywhere: matches: "*://*/*" isn\'t a match pattern for particular sites',
        "websites/I/Icon: icon must be an https image URL of at most 256 characters",
        'websites/U/Unknown: unknown key "permissions"',
        "websites/V/Version: version must be MAJOR.MINOR.PATCH",
        'websites/W/Wrong Id: id must be "wrong-id", the folder\'s name in lowercase words joined by "-"',
        "websites/X/Misfiled: it goes in websites/M/",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("an Activity's version", () => {
  test("is MAJOR.MINOR.PATCH from its metadata.json, and anything else is no version", () => {
    expect(versionFrom("1.2.3")).toBe("1.2.3");
    expect(versionFrom("10.0.12")).toBe("10.0.12");
    for (const other of ["1.2", "v1.2.3", "1.2.3-beta", "1.2.3.4", " 1.2.3", "", 1.2, null]) {
      expect(versionFrom(other)).toBeUndefined();
    }
    expect(versionFrom(undefined)).toBeUndefined();
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
      {
        service: "VLC",
        reason: "its script assigns page text to innerHTML, which Parousia won't ship",
      },
    ]);
    expect(premid[0]?.strings).toEqual({ "example.custom": "right now" });
  });

  test("a script's wrapper is as short as it can be: it's in every packaged script", () => {
    expect(wrapScript("new Presence({});", "premid:A", {}, false)).toBe(
      'globalThis.__pmd?.bind("A",({Presence})=>{\nnew Presence({});\n});\n',
    );
    const frame = wrapScript("new iFrame;", "premid:A", { "a.b": "c" }, true);
    expect(frame).toStartWith('globalThis.__pmd?.bindFrame("A",({iFrame})=>{');
    expect(frame).toEndWith('\n},{"a.b":"c"});\n');
    expect(
      wrapScript("new Presence({}),new Slideshow,MIN_SLIDE_TIME;", "premid:B", {}, false),
    ).toStartWith('globalThis.__pmd?.bind("B",({Presence,Slideshow,MIN_SLIDE_TIME})=>{');
    expect(wrapScript("SlideshowSlide;", "premid:C", {}, false)).toStartWith(
      'globalThis.__pmd?.bind("C",({SlideshowSlide})=>{',
    );
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

describe("compiling a PreMiD Activity", () => {
  async function checkout(sources: Record<string, Record<string, string>>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "premid-compile-"));
    await mkdir(join(root, "premid", "src"), { recursive: true });
    await writeFile(join(root, "premid", "src", "index.ts"), "export const helper = 1;\n");
    await writeFile(join(root, "outside.txt"), "BUILD-MACHINE-SECRET");
    for (const [name, files] of Object.entries(sources)) {
      const dir = join(root, "websites", name[0] ?? "X", name);
      await mkdir(dir, { recursive: true });
      for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
    }
    return root;
  }

  const found = (root: string, name: string): PremidFound => ({
    site: name.toLowerCase(),
    manifest: {
      info: { id: `premid:${name}`, name, hosts: ["example.com"], source: "premid" },
      match: { regExp: "^https://example[.]com/" },
      script: { file: "", clientIds: ["503557087041683458"] },
    },
    dir: join(root, "websites", name[0] ?? "X", name),
    strings: {},
    descriptions: {},
  });

  test("an Activity's files and PreMiD's helpers are bundled, and nothing else on the machine", async () => {
    const root = await checkout({
      Honest: {
        "presence.ts":
          'import { helper } from "premid";\nimport { x } from "./util.js";\nconsole.log(helper, x);\n',
        "util.ts": "export const x = 2;\n",
      },
      Upward: {
        "presence.ts":
          'import s from "../../../outside.txt" with { type: "text" };\nconsole.log(s);\n',
      },
      Absolute: {
        "presence.ts": `import s from ${JSON.stringify("/etc/hostname")} with { type: "text" };\nconsole.log(s);\n`,
      },
      Linked: {
        "presence.ts": 'import s from "./data.txt" with { type: "text" };\nconsole.log(s);\n',
      },
    });
    try {
      await symlink(join(root, "outside.txt"), join(root, "websites", "L", "Linked", "data.txt"));
      const { activities, scripts, excluded } = await compilePremid(
        root,
        ["Honest", "Upward", "Absolute", "Linked"].map((name) => found(root, name)),
      );
      expect(activities.map((entry) => entry.manifest.info.name)).toEqual(["Honest"]);
      expect(excluded.map((exclusion) => exclusion.service).sort()).toEqual([
        "Absolute",
        "Linked",
        "Upward",
      ]);
      for (const exclusion of excluded) expect(exclusion.reason).toContain("outside its folder");
      for (const script of scripts.values()) expect(script).not.toContain("BUILD-MACHINE-SECRET");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    const shard = async (id: string) =>
      parseShard(await read(`activities/manifests/${manifestShard(id)}.json`), id);
    expect((await shard("premid:Example"))?.script?.file).toBe("example");
    const example = catalog.activities.find((info) => info.id === "premid:Example");
    expect(example?.settings).toBeUndefined();
    expect(example?.data).toBeUndefined();
    expect(example?.discordClientId).toBeUndefined();
    expect(example?.origins).toEqual(["*://example.com/*", "*://www.example.com/*"]);
    const full = (await shard("premid:Example"))?.info;
    expect(full?.settings?.length).toBeGreaterThan(0);
    expect(full?.discordClientId).toBe("503557087041683458");
    expect(full?.description).toBeUndefined();
    expect(full?.keywords).toBeUndefined();
    expect(example?.description).toBeDefined();
    expect((await shard("tunes"))?.info.data).toEqual(["media", "thumbnails"]);
    expect(catalog.activities.some((info) => info.version !== undefined)).toBe(false);
    expect(full?.version).toBe("2.0.5");
    expect((await shard("tunes"))?.info.version).toBe("1.2.3");
    expect((await shard("premid:Versioned"))?.info.version).toBe("1.0.0");
    expect(Object.keys((await read("activities/manifests/t.json")) as object).sort()).toEqual([
      "premid:Tunes",
      "tunes",
    ]);
    expect(await Bun.file(join(out, "activities/index.json")).exists()).toBe(false);
    expect(await Bun.file(join(out, "activities/premid/example.json")).exists()).toBe(false);
    const hosts = await Bun.file(join(out, "activities/hosts.txt")).text();
    expect(hostIds(hosts, "example.site")).toEqual(["example-site"]);
    expect(hostIds(hosts, "tunes.example")).toEqual(["tunes", "premid:Tunes"]);
    expect(hostIds(hosts, "www.example.com")).toEqual(["premid:Example"]);
    expect(hostIds(hosts, "sub.www.example.com")).toEqual(["premid:Example"]);
    expect(hostIds(hosts, "versioned.example")).toEqual(["premid:Versioned"]);
    expect(hostIds(hosts, "other.example")).toEqual([]);
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
    expect(
      parseShard(await read("activities/manifests/t.json"), "premid:Tunes")?.info.variants,
    ).toEqual(variants);
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
        "export const infos = native.map(({ manifest }) => manifest.info);",
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
    const infos =
      typeof module === "object" && module !== null && "infos" in module ? module.infos : null;
    expect(infos).toEqual([
      {
        id: "example-site",
        name: "Example Site",
        hosts: ["example.site"],
        source: "parousia",
        settings: [{ id: "prefix", title: "", type: "text", default: "Reading" }],
      },
      {
        id: "tunes",
        name: "Tunes",
        hosts: ["tunes.example"],
        source: "parousia",
        icon: "https://tunes.example/icon.png",
        data: ["media", "thumbnails"],
        origins: ["https://tunes.example/*"],
        variants: ["tunes", "premid:Tunes"],
      },
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
