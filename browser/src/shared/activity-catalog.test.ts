import { beforeEach, describe, expect, test } from "bun:test";
import type { ActivityManifest } from "../activities/manifest";
import type { ActivityInfo } from "../core/activity";
import type { ActivityStates } from "../core/activity-state";
import { NO_GRANTS, type Grants } from "../core/site-access";
import {
  activityStatus,
  bulkPlan,
  chooseVariant,
  disableAll,
  enableAll,
  findActivity,
  listed,
  turnOff,
  turnOn,
} from "./activity-catalog";

const VARIANTS = ["video", "premid:Video"];
const native: ActivityInfo = {
  id: "video",
  name: "Video",
  hosts: ["video.example"],
  source: "parousia",
  variants: VARIANTS,
};
const premid: ActivityInfo = {
  id: "premid:Video",
  name: "Video",
  hosts: ["www.video.example"],
  source: "premid",
  origins: ["*://www.video.example/*"],
  variants: VARIANTS,
};
const music: ActivityInfo = {
  id: "premid:Music",
  name: "Music",
  hosts: ["music.example"],
  source: "premid",
  origins: ["*://music.example/*", "*://www.video.example/*"],
};
const catalog = [native, premid, music];

const files: Record<string, unknown> = {
  "activities/hosts.json": {
    hosts: {
      "video.example": ["native/video"],
      "www.video.example": ["premid/video"],
      "music.example": ["premid/music"],
    },
  },
  "activities/index.json": {
    files: {
      video: "native/video",
      "premid:Video": "premid/video",
      "premid:Music": "premid/music",
    },
  },
  "activities/native/video.json": {
    info: native,
    match: { patterns: ["https://*.video.example/watch*"] },
  } satisfies ActivityManifest,
  "activities/premid/video.json": {
    info: premid,
    match: { regExp: "^https://www[.]video[.]example/watch" },
    script: { file: "video", clientIds: ["503557087041683458"] },
  } satisfies ActivityManifest,
  "activities/premid/music.json": {
    info: music,
    match: { regExp: "^https://music[.]example/" },
    script: { file: "music", clientIds: ["503557087041683458"] },
  } satisfies ActivityManifest,
};

interface Browser {
  stored: { activities?: ActivityStates };
  requests: Array<{ origins?: string[]; permissions?: string[] }>;
  removed: Array<{ origins?: string[]; permissions?: string[] }>;
  answer: boolean;
  /** Origins the browser really grants when it says yes; all of them by default. */
  grantOnly?: string[];
  /** Origins granted now, as `permissions.getAll` reports them. */
  granted: string[];
  /** How many times the Activities' state was written. */
  writes: number;
}

let browser: Browser;

beforeEach(() => {
  browser = { stored: {}, requests: [], removed: [], answer: true, granted: [], writes: 0 };
  globalThis.chrome = {
    runtime: { getURL: (path: string) => `chrome-extension://self/${path}` },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: Reflect.get(browser.stored, key) }),
        set: async (items: object) => {
          browser.writes += 1;
          Object.assign(browser.stored, items);
        },
      },
    },
    permissions: {
      request: async (request: Browser["requests"][number]) => {
        browser.requests.push(request);
        if (browser.answer) {
          const wanted = request.origins ?? [];
          browser.granted.push(...wanted.filter((o) => browser.grantOnly?.includes(o) ?? true));
        }
        return browser.answer;
      },
      getAll: async () => ({ permissions: [], origins: browser.granted }),
      remove: async (request: Browser["removed"][number]) => {
        browser.removed.push(request);
        return true;
      },
    },
  } as unknown as typeof chrome;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input).replace("chrome-extension://self/", "");
    const body = files[path];
    return new Response(body === undefined ? "missing" : JSON.stringify(body), {
      status: body === undefined ? 404 : 200,
    });
  }) as typeof fetch;
});

const states = (): ActivityStates => browser.stored.activities ?? {};
const granted = (origins: string[]): Grants => ({ all: false, origins });

describe("turning Activities on and off", () => {
  test("one that reads pages asks for its sites in the same click, before anything is awaited", async () => {
    const done = turnOn(music, NO_GRANTS);
    // The browser only shows its prompt for a request made during the click.
    expect(browser.requests).toEqual([
      { permissions: ["scripting"], origins: ["*://music.example/*", "*://www.video.example/*"] },
    ]);
    expect(await done).toBe(true);
    expect(states()[music.id]).toEqual({ on: true });
  });

  test("it asks only for the sites it doesn't have", async () => {
    await turnOn(music, granted(["*://www.video.example/*"]));
    expect(browser.requests[0]?.origins).toEqual(["*://music.example/*"]);
    browser.requests = [];
    await turnOn(music, { all: true, origins: [] });
    expect(browser.requests).toEqual([]);
  });

  test("a refusal leaves it off", async () => {
    browser.answer = false;
    expect(await turnOn(music, NO_GRANTS)).toBe(false);
    expect(states()[music.id]).toEqual({ on: false });
  });

  test("one that needs no access asks for nothing", async () => {
    expect(await turnOn(native, NO_GRANTS)).toBe(true);
    expect(browser.requests).toEqual([]);
  });

  test("turning one off gives back the sites only it needed, and scripting once nothing needs it", async () => {
    browser.stored.activities = {
      [music.id]: { on: true },
      [premid.id]: { on: true },
      video: { use: premid.id },
    };
    await turnOff(music, catalog, granted(music.origins ?? []));
    // www.video.example still serves PreMiD's Video, which is on.
    expect(browser.removed).toEqual([{ origins: ["*://music.example/*"], permissions: [] }]);

    browser.removed = [];
    await turnOff(premid, catalog, granted(premid.origins ?? []));
    expect(browser.removed).toEqual([
      { origins: ["*://www.video.example/*"], permissions: ["scripting"] },
    ]);
  });
});

describe("a website in both sources", () => {
  test("is listed once, as the implementation chosen", () => {
    expect(listed(catalog, {}).map((info) => info.id)).toEqual(["video", "premid:Music"]);
    expect(listed(catalog, { video: { use: premid.id } }).map((info) => info.id)).toEqual([
      "premid:Video",
      "premid:Music",
    ]);
  });

  test("choosing the other implementation while it's on turns that one on, in one prompt", async () => {
    const done = chooseVariant(premid, catalog, {}, NO_GRANTS);
    expect(browser.requests).toEqual([
      { permissions: ["scripting"], origins: ["*://www.video.example/*"] },
    ]);
    expect(await done).toBe(true);
    expect(states()).toEqual({ [premid.id]: { on: true }, video: { use: premid.id } });
  });

  test("declining the prompt changes nothing", async () => {
    browser.answer = false;
    expect(await chooseVariant(premid, catalog, {}, NO_GRANTS)).toBe(false);
    expect(states()).toEqual({});
  });

  test("choosing while it's off only records the choice", async () => {
    browser.stored.activities = { video: { on: false } };
    expect(await chooseVariant(premid, catalog, states(), NO_GRANTS)).toBe(true);
    expect(browser.requests).toEqual([]);
    expect(states()).toEqual({ video: { on: false, use: premid.id } });
  });
});

describe("the Activity for a tab", () => {
  test("found through the host index and its own matcher, as the implementation chosen", async () => {
    const watch = new URL("https://www.video.example/watch?v=1");
    expect((await findActivity(watch, {}))?.id).toBe("video");
    expect((await findActivity(watch, { video: { use: premid.id } }))?.id).toBe(premid.id);
    expect((await findActivity(new URL("https://music.example/album/1"), {}))?.id).toBe(music.id);
    // A host it covers, on a page its matcher doesn't: nothing.
    expect(await findActivity(new URL("https://www.video.example/about"), {})).toBeNull();
    expect(await findActivity(new URL("https://elsewhere.example/"), {})).toBeNull();
    expect(await findActivity(new URL("chrome://settings/"), {})).toBeNull();
  });

  test("is off, on, or on but missing access to the page's site", () => {
    const album = new URL("https://music.example/album/1");
    expect(activityStatus(music, {}, NO_GRANTS, album)).toBe("off");
    const on = { [music.id]: { on: true } };
    expect(activityStatus(music, on, NO_GRANTS, album)).toBe("needs-access");
    expect(activityStatus(music, on, granted(["*://music.example/*"]), album)).toBe("on");
    // Without a page: every one of its sites.
    expect(activityStatus(music, on, granted(["*://music.example/*"]))).toBe("needs-access");
    expect(activityStatus(native, {}, NO_GRANTS)).toBe("on");
  });
});

describe("enabling and disabling many at once", () => {
  const news: ActivityInfo = {
    id: "premid:News",
    name: "News",
    hosts: ["news.example"],
    source: "premid",
    origins: ["*://news.example/*"],
  };
  const chat: ActivityInfo = {
    id: "chat",
    name: "Chat",
    hosts: ["chat.example"],
    source: "parousia",
  };
  const everything = [chat, music, news, native];

  test("a plan covers what is off or missing sites, what is on, and the sites to ask for once", () => {
    const plan = bulkPlan(everything, { chat: { on: false }, [music.id]: { on: true } }, NO_GRANTS);
    // Chat is off; Music is on without its sites; News is off; Video (native) is on.
    expect(plan.enable.map((info) => info.id)).toEqual(["chat", music.id, news.id]);
    expect(plan.disable.map((info) => info.id)).toEqual([music.id, "video"]);
    // Music's second site is News's too, and is asked for once.
    expect(plan.sites).toEqual([
      "*://music.example/*",
      "*://www.video.example/*",
      "*://news.example/*",
    ]);
    expect(bulkPlan(everything, {}, { all: true, origins: [] }).sites).toEqual([]);
  });

  test("enable all asks for every site in one request, made before anything is awaited", async () => {
    const plan = bulkPlan(everything, { chat: { on: false } }, NO_GRANTS);
    const done = enableAll(plan, NO_GRANTS);
    expect(browser.requests).toEqual([
      {
        permissions: ["scripting"],
        origins: ["*://music.example/*", "*://www.video.example/*", "*://news.example/*"],
      },
    ]);
    expect(await done).toEqual({ changed: 3, declined: [] });
    expect(states()).toEqual({
      chat: { on: true },
      [music.id]: { on: true },
      [news.id]: { on: true },
    });
    expect(browser.writes).toBe(1);
  });

  test("it only asks for what is not granted, and not at all when nothing is missing", async () => {
    const all = granted(["*://music.example/*", "*://www.video.example/*", "*://news.example/*"]);
    expect(await enableAll(bulkPlan(everything, {}, all), all)).toEqual({
      changed: 2,
      declined: [],
    });
    expect(browser.requests).toEqual([]);
  });

  test("a refusal turns on only what needs nothing new, and says which stayed off", async () => {
    browser.answer = false;
    const plan = bulkPlan(everything, { chat: { on: false } }, NO_GRANTS);
    expect(await enableAll(plan, NO_GRANTS)).toEqual({
      changed: 1,
      declined: [music.id, news.id],
    });
    expect(states()).toEqual({ chat: { on: true } });
  });

  test("a site the browser did not really grant does not count as granted", async () => {
    browser.grantOnly = ["*://news.example/*"];
    const plan = bulkPlan([music, news], {}, NO_GRANTS);
    expect(await enableAll(plan, NO_GRANTS)).toEqual({ changed: 1, declined: [music.id] });
    expect(states()).toEqual({ [news.id]: { on: true } });
  });

  test("an Activity whose sites another one already got is turned on without asking", async () => {
    const one = granted(["*://news.example/*"]);
    const plan = bulkPlan([news], {}, one);
    expect(plan.sites).toEqual([]);
    expect(await enableAll(plan, one)).toEqual({ changed: 1, declined: [] });
    expect(browser.requests).toEqual([]);
  });

  test("disable all turns off what is on in one write, and gives back only the sites nothing else needs", async () => {
    browser.stored.activities = {
      [music.id]: { on: true },
      [news.id]: { on: true },
      [premid.id]: { on: true },
      video: { use: premid.id },
    };
    const both = granted(["*://music.example/*", "*://news.example/*", "*://www.video.example/*"]);
    // Chat (on by default, needs nothing), Music, and News go; PreMiD's Video, which is not
    // among them, keeps www.video.example.
    expect(await disableAll([music, news, chat], catalog, both)).toBe(3);
    expect(states().chat).toEqual({ on: false });
    expect(states()[music.id]).toEqual({ on: false });
    expect(states()[news.id]).toEqual({ on: false });
    expect(states()[premid.id]).toEqual({ on: true });
    expect(browser.writes).toBe(1);
    expect(browser.removed).toEqual([
      { origins: ["*://music.example/*", "*://news.example/*"], permissions: [] },
    ]);
  });

  test("disabling the last reader gives back scripting too, and nothing on means nothing to do", async () => {
    browser.stored.activities = { [music.id]: { on: true } };
    const g = granted(music.origins ?? []);
    expect(await disableAll([music], catalog, g)).toBe(1);
    expect(browser.removed).toEqual([{ origins: music.origins, permissions: ["scripting"] }]);
    browser.removed = [];
    expect(await disableAll([music], catalog, g)).toBe(0);
    expect(browser.removed).toEqual([]);
  });
});
