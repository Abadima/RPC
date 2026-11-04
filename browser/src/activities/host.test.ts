import { describe, expect, test } from "bun:test";
import type { ActivityState, ActivityStates } from "../core/activity-state";
import { ActivityRegistry } from "../core/registry";
import { PresenceRuntime } from "../core/runtime";
import { NO_GRANTS, type Grants } from "../core/site-access";
import { PageHost, type PageBrowser, type Port } from "./host";
import { registered, type ActivityManifest } from "./manifest";
import { PAGE_DATA_PORT, PREMID_FRAME_PORT, PREMID_PORT, type PageSpec } from "./messages";

const PREMID = "premid:Example";
const DEFAULT_CLIENT = "503557087041683458";
const OTHER_CLIENT = "503557087041683459";

const premid: ActivityManifest = {
  info: {
    id: PREMID,
    name: "Example",
    hosts: ["example.com"],
    source: "premid",
    icon: "https://cdn.example/logo.png",
    discordClientId: DEFAULT_CLIENT,
    settings: [{ id: "buttons", title: "Buttons", type: "boolean", default: true }],
    data: ["media", "thumbnails", "creatorIcons"],
    origins: ["*://example.com/*"],
  },
  match: { regExp: "^https://example[.]com/watch" },
  script: {
    file: "example",
    iframe: { regExp: "^https://player[.]example/" },
    clientIds: [DEFAULT_CLIENT, OTHER_CLIENT],
    fixed: { lang: "en" },
  },
};

/** A native Activity that takes page data (the collector reads it). */
const tunes: ActivityManifest = {
  info: {
    id: "tunes",
    name: "Tunes",
    hosts: ["tunes.example"],
    source: "parousia",
    data: ["media", "thumbnails"],
    origins: ["https://tunes.example/*"],
  },
  match: { patterns: ["https://tunes.example/*"] },
};

interface FakePort extends Port {
  posted: unknown[];
  disconnected: boolean;
  send(message: unknown): void;
  close(): void;
}

function fakePort(name: string, sender: Port["sender"]): FakePort {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: FakePort = {
    name,
    sender,
    posted: [],
    disconnected: false,
    postMessage: (message) => port.posted.push(message),
    disconnect: () => {
      port.disconnected = true;
    },
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
    send: (message) => messageListeners.forEach((listener) => listener(message)),
    close: () => disconnectListeners.forEach((listener) => listener()),
  };
  return port;
}

function setup(
  initial: Grants = { all: false, origins: ["*://example.com/*", "https://tunes.example/*"] },
  manifest: ActivityManifest = premid,
) {
  let connect: (port: Port) => void = () => {};
  let accessChanged: () => void = () => {};
  let grants = initial;
  const injected: Array<{ tabId: number; files: string[]; allFrames: boolean }> = [];
  const started: Array<[number, string]> = [];
  const reads: Array<{ tabId: number; frameId: number; spec: PageSpec }> = [];
  const saved: Array<[string, ActivityState]> = [];
  const changed: number[] = [];
  const browser: PageBrowser = {
    extensionId: "self",
    onConnect: (listener) => {
      connect = listener;
    },
    onAccessChange: (listener) => {
      accessChanged = listener;
    },
    grants: async () => grants,
    inject: async (tabId, files, allFrames) => {
      injected.push({ tabId, files, allFrames });
    },
    startCollector: async (tabId, activity) => {
      started.push([tabId, activity]);
    },
    readPage: async (tabId, frameId, spec) => {
      reads.push({ tabId, frameId, spec });
      return JSON.stringify({ "player.title": "Song" });
    },
    loadManifest: async (id) => (id === PREMID ? manifest : null),
    saveState: async (id, patch) => {
      saved.push([id, patch]);
    },
  };
  const registry = new ActivityRegistry();
  registry.register(registered(tunes, { detect: () => null }));
  const host = new PageHost(registry, browser, [tunes], (tabId) => changed.push(tabId));
  const open = (name: string, sender: Port["sender"]): FakePort => {
    const port = fakePort(name, sender);
    connect(port);
    return port;
  };
  const page = (url = "https://example.com/watch?v=1", overrides: Port["sender"] = {}) =>
    open(PREMID_PORT, { id: "self", url, frameId: 0, tab: { id: 7 }, ...overrides });
  const setGrants = async (next: Grants): Promise<void> => {
    grants = next;
    accessChanged();
    await settle();
  };
  return { host, registry, injected, started, reads, saved, changed, open, page, setGrants };
}

const on: ActivityStates = { [PREMID]: { on: true } };
const WATCH = new URL("https://example.com/watch?v=1");
const TUNES = new URL("https://tunes.example/song/1");
const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("PageHost: PreMiD Activities", () => {
  test("nothing is loaded until one is on; then it's registered and injected where its site is granted", async () => {
    const { host, registry, injected } = setup();
    await host.setStates({});
    expect(registry.list().map((info) => info.id)).toEqual(["tunes"]);

    await host.setStates(on);
    expect(host.active).toBe(true);
    expect(registry.list().map((info) => info.id)).toEqual(["tunes", PREMID]);

    expect(await host.page(7, new URL("https://example.com/home"))).toEqual({});
    expect(await host.page(7, WATCH)).toEqual({
      granted: ["media", "thumbnails", "creatorIcons"],
    });
    await host.page(7, WATCH);
    expect(injected).toEqual([
      {
        tabId: 7,
        files: ["activities/premid/runtime.js", "activities/premid/example.js"],
        allFrames: false,
      },
      {
        tabId: 7,
        files: ["activities/premid/runtime.js", "activities/premid/example.iframe.js"],
        allFrames: true,
      },
    ]);
    host.loaded(7);
    await host.page(7, WATCH);
    expect(injected).toHaveLength(4);
  });

  test("where its site isn't granted it's unavailable: nothing is injected, and nothing is shown", async () => {
    const { host, registry, injected, page: open } = setup(NO_GRANTS);
    await host.setStates(on);
    const page = await host.page(7, WATCH);
    expect(page).toEqual({});
    expect(injected).toEqual([]);
    expect(host.usable(premid.info, WATCH)).toBe(false);
    const runtime = new PresenceRuntime(registry, {
      usable: (info, url) => host.usable(info, url),
    });
    expect(runtime.resolve({ url: WATCH, title: "A Video", ...page }).activity).toBeNull();
    // A script that reaches the background anyway (injected before access was taken back) is refused.
    const port = open();
    port.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    await settle();
    expect(port.posted).toEqual([{ type: "stop" }]);
  });

  test("access for all websites covers it without its own grant", async () => {
    const { host, injected } = setup({ all: true, origins: [] });
    await host.setStates(on);
    expect((await host.page(7, WATCH)).granted).toHaveLength(3);
    expect(injected).toHaveLength(2);
  });

  test("of a website's implementations, only the chosen one is loaded and runs", async () => {
    const shared: ActivityManifest = {
      ...premid,
      info: { ...premid.info, variants: ["example", PREMID] },
    };
    const { host, registry } = setup(undefined, shared);
    // The native one is chosen until someone picks PreMiD's.
    await host.setStates({ [PREMID]: { on: true } });
    expect(registry.list().map((info) => info.id)).toEqual(["tunes"]);
    await host.setStates({ [PREMID]: { on: true }, example: { use: PREMID } });
    expect(registry.list().map((info) => info.id)).toEqual(["tunes", PREMID]);
    await host.setStates({ [PREMID]: { on: true }, example: { use: "example" } });
    expect(registry.list().map((info) => info.id)).toEqual(["tunes"]);
  });

  test("a page script is served only from this extension's content script, on a page its Activity matches", async () => {
    const { host, page } = setup();
    await host.setStates(on);
    for (const port of [
      page("https://example.com/watch", { id: "another-extension" }),
      page("https://example.com/watch", { frameId: 3 }),
      page("chrome-extension://self/popup.html"),
      page("https://example.com/watch", { tab: {} }),
    ]) {
      expect(port.disconnected).toBe(true);
    }
    const elsewhere = page("https://example.com/home");
    elsewhere.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    const unknown = page();
    unknown.send({ type: "hello", activity: "premid:Other", clientId: DEFAULT_CLIENT });
    await settle();
    for (const port of [elsewhere, unknown]) {
      expect(port.posted).toEqual([{ type: "stop" }]);
      expect(port.disconnected).toBe(true);
    }
  });

  test("its report becomes the tab's Activity, with an Application its source names", async () => {
    const { host, page, changed } = setup();
    await host.setStates(on);
    const port = page();
    port.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    await settle();
    expect(port.posted).toEqual([
      { type: "settings", values: { lang: "en", buttons: true } },
      { type: "background", on: false },
    ]);

    port.send({
      type: "activity",
      clientId: OTHER_CLIENT,
      data: { details: "Watching", state: "A video" },
    });
    await settle(250);
    expect(changed).toEqual([7]);
    expect((await host.page(7, WATCH)).reported).toEqual({
      id: PREMID,
      name: "Example",
      url: "https://example.com/watch",
      discordClientId: OTHER_CLIENT,
      details: "Watching",
      state: "A video",
      assets: { largeImage: "https://cdn.example/logo.png" },
    });

    port.send({ type: "activity", clientId: "123456789012345678", data: { details: "Watching" } });
    await settle(250);
    expect((await host.page(7, WATCH)).reported?.discordClientId).toBe(DEFAULT_CLIENT);

    port.close();
    expect((await host.page(7, WATCH)).reported).toBeUndefined();
    expect(changed.at(-1)).toBe(7);
  });

  test("a first report refreshes at once; a burst after it, once more when it settles", async () => {
    const { host, page, changed } = setup();
    await host.setStates(on);
    const port = page();
    port.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    const report = (details: string): void =>
      port.send({ type: "activity", clientId: DEFAULT_CLIENT, data: { details } });
    report("1");
    await settle();
    expect(changed).toEqual([7]);
    for (const n of ["2", "3", "4"]) report(n);
    await settle();
    expect(changed).toEqual([7]);
    await settle(250);
    expect(changed).toEqual([7, 7]);
    expect((await host.page(7, WATCH)).reported?.details).toBe("4");
    await settle(250);
    expect(changed).toEqual([7, 7]);
  });

  test("page data switched off in Settings > Privacy isn't shown", async () => {
    const { host, page } = setup();
    host.setPageData({ media: false, thumbnails: false, creatorIcons: false });
    await host.setStates(on);
    const port = page();
    port.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    port.send({
      type: "activity",
      clientId: DEFAULT_CLIENT,
      data: {
        details: "Never Gonna Give You Up",
        largeImageKey: "https://i.ytimg.com/vi/x/hq.jpg",
        smallImageKey: "https://yt3.ggpht.com/avatar.jpg",
        startTimestamp: 1_700_000_000,
      },
    });
    await settle(250);
    const page_ = await host.page(7, WATCH);
    expect(page_.granted).toEqual([]);
    expect(page_.reported).toEqual({
      id: PREMID,
      name: "Example",
      url: "https://example.com/watch",
      discordClientId: DEFAULT_CLIENT,
      assets: { largeImage: "https://cdn.example/logo.png" },
    });
  });

  test("an iframe's data reaches its own Activity's page script in the same tab", async () => {
    const { host, page, open } = setup({ all: true, origins: [] });
    await host.setStates(on);
    const top = page();
    top.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    const frameSender = { id: "self", frameId: 4, tab: { id: 7 } };
    const player = open(PREMID_FRAME_PORT, {
      ...frameSender,
      url: "https://player.example/embed/1",
    });
    player.send({ type: "hello", activity: PREMID });
    player.send({ type: "data", data: { title: "Song", paused: false } });
    const stranger = open(PREMID_FRAME_PORT, { ...frameSender, url: "https://ads.example/frame" });
    stranger.send({ type: "hello", activity: PREMID });
    await settle();
    expect(top.posted).toContainEqual({
      type: "frame-data",
      data: { title: "Song", paused: false },
    });
    expect(stranger.posted).toEqual([{ type: "stop" }]);
  });

  test("page reads run in the page's own frame and come back by nonce; hidden settings are saved", async () => {
    const { host, page, reads, saved } = setup();
    await host.setStates(on);
    const port = page();
    port.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    port.send({ type: "page", nonce: 3, spec: { kind: "variables", paths: ["player.title"] } });
    port.send({ type: "hide", ids: ["buttons"], hidden: true });
    await settle();
    expect(reads).toEqual([
      { tabId: 7, frameId: 0, spec: { kind: "variables", paths: ["player.title"] } },
    ]);
    expect(port.posted).toContainEqual({
      type: "page-result",
      nonce: 3,
      value: { "player.title": "Song" },
    });
    expect(saved).toEqual([[PREMID, { hidden: ["buttons"] }]]);
  });

  test("a setting hidden again, or shown when it isn't hidden, is no change to save", async () => {
    const { host, page, saved } = setup();
    await host.setStates({ [PREMID]: { on: true, hidden: ["buttons"] } });
    const port = page();
    port.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    port.send({ type: "hide", ids: ["buttons"], hidden: true });
    port.send({ type: "hide", ids: ["cover"], hidden: false });
    await settle();
    expect(saved).toEqual([]);
    port.send({ type: "hide", ids: ["buttons", "cover"], hidden: true });
    await settle();
    expect(saved).toEqual([[PREMID, { hidden: ["buttons", "cover"] }]]);
  });

  test("turning it off, or taking its site back, stops its script and drops what it reported", async () => {
    const { host, registry, page, changed, setGrants } = setup();
    await host.setStates(on);
    let port = page();
    port.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    port.send({ type: "activity", clientId: DEFAULT_CLIENT, data: { details: "Watching" } });
    await settle(250);
    await setGrants({ all: false, origins: [] });
    expect(port.posted.at(-1)).toEqual({ type: "stop" });
    expect(port.disconnected).toBe(true);
    expect((await host.page(7, WATCH)).reported).toBeUndefined();

    await setGrants({ all: true, origins: [] });
    port = page();
    port.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    await settle();
    await host.setStates({ [PREMID]: { on: false } });
    expect(registry.list().map((info) => info.id)).toEqual(["tunes"]);
    expect(port.posted.at(-1)).toEqual({ type: "stop" });
    expect(changed.length).toBeGreaterThan(0);
  });
});

describe("PageHost: native Activities that take page data", () => {
  const collector = (open: ReturnType<typeof setup>["open"], url = TUNES.href) =>
    open(PAGE_DATA_PORT, { id: "self", url, frameId: 0, tab: { id: 9 } });

  test("the collector runs only where the site is granted, and reads only what's allowed", async () => {
    const { host, injected, started, open, changed } = setup();
    host.setPageData({ media: true, thumbnails: false, creatorIcons: true });
    await host.setStates({ tunes: { on: true } });
    expect(await host.page(9, TUNES)).toEqual({ granted: ["media"] });
    await settle();
    expect(injected).toEqual([{ tabId: 9, files: ["activities/collector.js"], allFrames: false }]);
    expect(started).toEqual([[9, "tunes"]]);

    const port = collector(open);
    port.send({ type: "hello", activity: "tunes" });
    await settle();
    expect(port.posted).toEqual([
      { type: "collect", kinds: ["media"] },
      { type: "background", on: false },
    ]);
    port.send({
      type: "data",
      data: { media: { title: "Song", playing: true, start: 1_700_000_000_000 } },
    });
    await settle(250);
    expect(changed).toEqual([9]);
    expect((await host.page(9, TUNES)).data).toEqual({
      media: { title: "Song", playing: true, start: 1_700_000_000_000 },
    });

    host.setPageData({ media: false, thumbnails: false, creatorIcons: true });
    expect(port.posted.at(-1)).toEqual({ type: "stop" });
  });

  test("other preferences changing doesn't inject anything again", async () => {
    const { host, injected } = setup();
    await host.setStates({ tunes: { on: true } });
    await host.page(9, TUNES);
    await settle();
    host.setPageData({ media: true, thumbnails: true, creatorIcons: true });
    await host.page(9, TUNES);
    await settle();
    expect(injected).toHaveLength(1);
  });

  test("it's off until turned on, since it reads pages", async () => {
    const { host, injected } = setup();
    await host.setStates({});
    expect(await host.page(9, TUNES)).toEqual({});
    expect(injected).toEqual([]);
  });

  test("without its site it's unavailable: nothing is collected", async () => {
    const { host, injected, open } = setup(NO_GRANTS);
    await host.setStates({ tunes: { on: true } });
    expect(await host.page(9, TUNES)).toEqual({});
    expect(injected).toEqual([]);
    const port = collector(open);
    port.send({ type: "hello", activity: "tunes" });
    await settle();
    expect(port.posted).toEqual([{ type: "stop" }]);
  });
});

describe("PageHost: what runs for an Activity that's off", () => {
  test("it doesn't answer before the first stored states are in, so defaults never decide for an Activity someone turned off", async () => {
    const { host, injected, started } = setup();
    let answered = false;
    const pending = host.page(9, TUNES).then((result) => {
      answered = true;
      return result;
    });
    await settle(20);
    expect(answered).toBe(false);

    await host.setStates({ tunes: { on: false } });
    expect(await pending).toEqual({});
    expect(injected).toEqual([]);
    expect(started).toEqual([]);
  });

  test("once the states are in, an Activity that's on is looked at as before", async () => {
    const { host, started } = setup();
    const pending = host.page(9, TUNES);
    await host.setStates({ tunes: { on: true } });
    expect(await pending).toEqual({ granted: ["media", "thumbnails"] });
    await settle();
    expect(started).toEqual([[9, "tunes"]]);
  });

  test("peek reads what a tab last reported and injects nothing", async () => {
    const { host, injected, started, open } = setup();
    await host.setStates({ tunes: { on: true } });
    expect(await host.page(9, TUNES)).toEqual({ granted: ["media", "thumbnails"] });
    await settle();
    const port = open(PAGE_DATA_PORT, { id: "self", url: TUNES.href, frameId: 0, tab: { id: 9 } });
    port.send({ type: "hello", activity: "tunes" });
    port.send({ type: "data", data: { media: { title: "Song", playing: true } } });
    await settle(250);

    injected.length = 0;
    started.length = 0;
    expect(await host.peek(9, TUNES)).toEqual({
      granted: ["media", "thumbnails"],
      data: { media: { title: "Song", playing: true } },
    });
    // A tab nobody has looked at: what it may read, and no script put into it.
    expect(await host.peek(12, TUNES)).toEqual({ granted: ["media", "thumbnails"] });
    expect(injected).toEqual([]);
    expect(started).toEqual([]);
  });

  test("peek finds nothing for an Activity that's off or whose site was taken back", async () => {
    const off = setup();
    await off.host.setStates({ tunes: { on: false } });
    expect(await off.host.peek(9, TUNES)).toEqual({});

    const denied = setup(NO_GRANTS);
    await denied.host.setStates({ tunes: { on: true } });
    expect(await denied.host.peek(9, TUNES)).toEqual({});
    expect(denied.injected).toEqual([]);
  });

  test("turning an Activity off stops its collector in every tab, and what it read is gone", async () => {
    const { host, open, changed } = setup();
    await host.setStates({ tunes: { on: true } });
    const ports = [9, 10].map((tab) => {
      const port = open(PAGE_DATA_PORT, {
        id: "self",
        url: TUNES.href,
        frameId: 0,
        tab: { id: tab },
      });
      port.send({ type: "hello", activity: "tunes" });
      port.send({ type: "data", data: { media: { title: `Song ${tab}`, playing: true } } });
      return port;
    });
    await settle(250);
    changed.length = 0;

    await host.setStates({ tunes: { on: false } });
    for (const port of ports) {
      expect(port.posted.at(-1)).toEqual({ type: "stop" });
      expect(port.disconnected).toBe(true);
    }
    expect(changed.toSorted((a, b) => a - b)).toEqual([9, 10]);
    expect(await host.peek(9, TUNES)).toEqual({});
    expect(await host.peek(10, TUNES)).toEqual({});
  });
});

describe("PageHost: tabs whose music or video is kept", () => {
  const background = (port: { posted: unknown[] }) =>
    port.posted.filter((message) => (message as { type?: string }).type === "background");

  test("their scripts are told to keep reading while the tab is in the background, and only theirs", async () => {
    const { host, open, page } = setup();
    await host.setStates({ ...on, tunes: { on: true } });
    const premidPort = page();
    premidPort.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    const kept = open(PAGE_DATA_PORT, { id: "self", url: TUNES.href, frameId: 0, tab: { id: 9 } });
    kept.send({ type: "hello", activity: "tunes" });
    const other = open(PAGE_DATA_PORT, {
      id: "self",
      url: TUNES.href,
      frameId: 0,
      tab: { id: 10 },
    });
    other.send({ type: "hello", activity: "tunes" });
    await settle();

    host.keepReading([9, 7]);
    // Told where each stands when it connected, and the tabs kept told again.
    const told = [
      { type: "background", on: false },
      { type: "background", on: true },
    ];
    expect(background(kept)).toEqual(told);
    expect(background(premidPort)).toEqual(told);
    expect(background(other)).toEqual([{ type: "background", on: false }]);

    // Told once: the same tabs again change nothing.
    host.keepReading([7, 9]);
    expect(background(kept)).toHaveLength(2);
    expect(background(premidPort)).toHaveLength(2);
  });

  test("a tab no longer kept is told to read only while shown again", async () => {
    const { host, open } = setup();
    await host.setStates({ tunes: { on: true } });
    const kept = open(PAGE_DATA_PORT, { id: "self", url: TUNES.href, frameId: 0, tab: { id: 9 } });
    kept.send({ type: "hello", activity: "tunes" });
    await settle();
    host.keepReading([9]);
    host.keepReading([]);
    expect(background(kept)).toEqual([
      { type: "background", on: false },
      { type: "background", on: true },
      { type: "background", on: false },
    ]);
  });

  test("a script that connects later in a kept tab is told at once, and an iframe's too", async () => {
    const { host, open } = setup({ all: true, origins: [] });
    await host.setStates(on);
    host.keepReading([7]);
    const late = open(PREMID_PORT, {
      id: "self",
      url: WATCH.href,
      frameId: 0,
      tab: { id: 7 },
    });
    late.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    const frame = open(PREMID_FRAME_PORT, {
      id: "self",
      url: "https://player.example/embed",
      frameId: 3,
      tab: { id: 7 },
    });
    frame.send({ type: "hello", activity: PREMID });
    await settle();
    expect(background(late)).toEqual([{ type: "background", on: true }]);
    expect(background(frame)).toEqual([{ type: "background", on: true }]);
  });

  test("a script that connects is always told where it stands, so none stays stuck reading in the background", async () => {
    const { host, open } = setup();
    await host.setStates({ tunes: { on: true } });
    const plain = open(PAGE_DATA_PORT, { id: "self", url: TUNES.href, frameId: 0, tab: { id: 9 } });
    plain.send({ type: "hello", activity: "tunes" });
    await settle();
    // Not kept: told so, in case it was told otherwise before the background restarted.
    expect(background(plain)).toEqual([{ type: "background", on: false }]);
  });

  test("a closed tab is forgotten, so a page opened under its number reads only while shown", async () => {
    const { host, open } = setup();
    await host.setStates({ tunes: { on: true } });
    host.keepReading([9]);
    host.forget(9);
    const reused = open(PAGE_DATA_PORT, {
      id: "self",
      url: TUNES.href,
      frameId: 0,
      tab: { id: 9 },
    });
    reused.send({ type: "hello", activity: "tunes" });
    await settle();
    expect(background(reused)).toEqual([{ type: "background", on: false }]);
  });
});

describe("PageHost: stopping a tab's scripts", () => {
  test("stops the scripts running in that tab, drops what they reported, and leaves other tabs alone", async () => {
    const { host, page } = setup();
    await host.setStates(on);
    const stopped = page();
    stopped.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    const kept = page(WATCH.href, { tab: { id: 8 } });
    kept.send({ type: "hello", activity: PREMID, clientId: DEFAULT_CLIENT });
    stopped.send({ type: "activity", clientId: DEFAULT_CLIENT, data: { details: "Watching" } });
    await settle(250);
    expect((await host.peek(7, WATCH)).reported).toBeDefined();

    host.stopTabs([7]);
    expect(stopped.posted.at(-1)).toEqual({ type: "stop" });
    expect(stopped.disconnected).toBe(true);
    expect(kept.posted.some((message) => (message as { type?: string }).type === "stop")).toBe(
      false,
    );
    expect(kept.disconnected).toBe(false);
    expect((await host.peek(7, WATCH)).reported).toBeUndefined();
  });
});
