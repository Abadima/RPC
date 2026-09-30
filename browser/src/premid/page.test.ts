import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { BRIDGE_KEY } from "../activities/manifest";
import { trackImageOrigins } from "./image-origin";
import {
  STALE_AFTER_MOVE_MS,
  STALE_MS,
  answerImageService,
  fitPresenceData,
  installBridge,
  runUpdates,
  serializePresenceData,
  withholdStorage,
  type PremidBridge,
} from "./page";

describe("the world PreMiD Activities run in", () => {
  test("has no storage API, whether it's the API object's own or inherited", () => {
    const deletable = { storage: { local: {} }, runtime: {} };
    // Deleting an inherited one does nothing; it's shadowed instead.
    const fixed = Object.create({ storage: { local: {} } }, { runtime: { value: {} } });
    withholdStorage({ browser: deletable, chrome: fixed });
    expect(Reflect.get(deletable, "storage")).toBeUndefined();
    expect(Reflect.get(fixed, "storage")).toBeUndefined();
    // Everything else stays: the runtime still reaches the background.
    expect(deletable.runtime).toEqual({});
    expect(Reflect.get(fixed, "runtime")).toEqual({});
  });

  test("a scope without the extension APIs is left alone", () => {
    const scope = {};
    withholdStorage(scope);
    expect(scope).toEqual({});
  });
});

describe("what an Activity shows reaches the background", () => {
  // YouTube's default image setting draws the thumbnail on a canvas and hands
  // over `canvas.toDataURL()`: far more than the 16 KiB a message may be, so
  // the whole presence used to be dropped ("Nothing to share" while playing).
  const thumbnail = `data:image/png;base64,${"A".repeat(120_000)}`;

  test("an inline image is left out, and everything else is kept", () => {
    const wire = fitPresenceData({
      details: "Me at the zoo",
      state: "jawed",
      largeImageKey: thumbnail,
      smallImageKey: "play",
      startTimestamp: 1_700_000_000_000,
    });
    expect(wire).toEqual({
      details: "Me at the zoo",
      state: "jawed",
      smallImageKey: "play",
      startTimestamp: 1_700_000_000_000,
    });
  });

  test("an inline image made from a picture the page serves goes as that picture's address", () => {
    class Canvas {
      toDataURL(): string {
        return thumbnail;
      }
    }
    class Context {
      constructor(readonly canvas: Canvas) {}
      drawImage(_image: unknown): void {}
    }
    trackImageOrigins({ HTMLCanvasElement: Canvas, CanvasRenderingContext2D: Context });
    const canvas = new Canvas();
    new Context(canvas).drawImage({ src: "https://i3.ytimg.com/vi/abc/mqdefault.jpg" });
    const wire = fitPresenceData({ details: "Me at the zoo", largeImageKey: canvas.toDataURL() });
    expect(wire).toEqual({
      details: "Me at the zoo",
      largeImageKey: "https://i3.ytimg.com/vi/abc/mqdefault.jpg",
    });
    expect(JSON.stringify(wire).length).toBeLessThan(16 * 1024);
  });

  test("web addresses and asset keys stay; blob and data addresses never do", () => {
    expect(serializePresenceData({ largeImageKey: "https://i.ytimg.com/vi/x/hq.jpg" })).toEqual({
      largeImageKey: "https://i.ytimg.com/vi/x/hq.jpg",
    });
    expect(serializePresenceData({ largeImageKey: "logo" })).toEqual({ largeImageKey: "logo" });
    expect(serializePresenceData({ largeImageKey: "blob:https://x/1234" })).toEqual({});
    expect(serializePresenceData({ largeImageKey: " DATA:image/png;base64,AA" })).toEqual({});
    expect(serializePresenceData({ largeImageKey: `https://x/${"a".repeat(3000)}` })).toEqual({});
  });

  test("one too big even without its images is held back rather than sent", () => {
    expect(fitPresenceData({ details: "x", state: "y".repeat(20_000) })).toBeUndefined();
  });

  test("one that only fits without its images is sent without them", () => {
    const wire = fitPresenceData({
      details: "x",
      largeImageKey: `https://x/${"a".repeat(2000)}`,
      smallImageKey: `https://x/${"b".repeat(2000)}`,
      buttons: Array.from({ length: 2 }, () => ({ label: "go", url: "https://example.com/" })),
    });
    expect(wire).toBeDefined();
    expect(JSON.stringify(wire).length).toBeLessThanOrEqual(16 * 1024);
  });

  test("nothing shown is nothing sent", () => {
    expect(fitPresenceData(null)).toBeNull();
  });
});

describe("updates that never finish", () => {
  test("one that hangs doesn't stop the others, and is tried again after the limit", async () => {
    const running = new Set<() => Promise<void>>();
    let hung = 0;
    let fine = 0;
    const stuck = (): Promise<void> => {
      hung++;
      return new Promise(() => {});
    };
    const healthy = async (): Promise<void> => {
      fine++;
    };
    const runs = [stuck, healthy];

    const first = runUpdates(runs, running, 30);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runUpdates(runs, running, 30);
    // While it's under way, the stuck one isn't started again; the healthy one isn't held up.
    expect([hung, fine]).toEqual([1, 2]);
    await first;
    expect(running.size).toBe(0);

    await runUpdates(runs, running, 30);
    expect([hung, fine]).toEqual([2, 3]);
  });

  test("one that throws is ignored, and runs again on the next tick", async () => {
    const running = new Set<() => Promise<void>>();
    let calls = 0;
    const failing = async (): Promise<void> => {
      calls++;
      throw new Error("boom");
    };
    await runUpdates([failing], running, 30);
    await runUpdates([failing], running, 30);
    expect(calls).toBe(2);
    expect(running.size).toBe(0);
  });
});

describe("PreMiD's image service", () => {
  function scope() {
    const seen: string[] = [];
    const fake = {
      fetch: (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        seen.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(new Response("the network"));
      },
    };
    answerImageService(fake);
    return { fake, seen };
  }

  test("a shortening comes back as the address it was asked about, without a request", async () => {
    const { fake, seen } = scope();
    const long = `https://cdn.example.com/cover.jpg?sig=${"a".repeat(300)}&x=1`;
    const answer = await fake.fetch(`https://pd.premid.app/create/${long}`);
    expect(await answer.text()).toBe(long);
    expect(seen).toEqual([]);
  });

  test("an upload is answered with nothing, and nothing is uploaded", async () => {
    const { fake, seen } = scope();
    const answer = await fake.fetch("https://pd.premid.app/create/image", {
      method: "POST",
      body: "picture",
    });
    expect(await answer.text()).toBe("");
    expect(seen).toEqual([]);
  });

  test("every other request goes where it was going, as a string, URL, or Request", async () => {
    const { fake, seen } = scope();
    await fake.fetch("https://www.youtube.com/youtubei/v1/player");
    await fake.fetch(new URL("https://example.com/a"));
    await fake.fetch(new Request("https://example.com/b"));
    await fake.fetch("https://pd.premid.app.evil.example/create/x");
    await fake.fetch("https://pd.premid.app/other");
    expect(seen).toEqual([
      "https://www.youtube.com/youtubei/v1/player",
      "https://example.com/a",
      "https://example.com/b",
      "https://pd.premid.app.evil.example/create/x",
      "https://pd.premid.app/other",
    ]);
  });
});

describe("an Activity in a page", () => {
  const scope = globalThis as Record<string, unknown>;
  const globals = ["window", "document", "chrome", "location"] as const;
  const before = new Map(globals.map((key) => [key, scope[key]]));
  afterEach(() => {
    setSystemTime();
    for (const [key, value] of before) scope[key] = value;
  });

  /** A page with the runtime installed, and the messages it sends and receives through its ports. */
  function page() {
    const posted: Array<{ type: string; data?: unknown }> = [];
    const receivers: Array<(message: unknown) => void> = [];
    const window = { top: undefined as unknown, addEventListener: () => {} };
    window.top = window;
    const location = { href: "https://music.example/" };
    scope.window = window;
    scope.location = location;
    scope.document = {
      hidden: false,
      readyState: "complete",
      addEventListener: () => {},
      getElementsByTagName: () => [],
    };
    scope.chrome = {
      runtime: {
        connect: () => ({
          postMessage: (message: { type: string; data?: unknown }) => posted.push(message),
          onMessage: {
            addListener: (listener: (message: unknown) => void) => receivers.push(listener),
          },
          onDisconnect: { addListener: () => {} },
          disconnect: () => {},
        }),
      },
    };
    const holder: Record<string, unknown> = {};
    installBridge(holder);
    const bridge = holder[BRIDGE_KEY] as PremidBridge;
    return {
      bridge,
      location,
      reports: () => posted.filter((message) => message.type === "activity"),
      stop: () => receivers.forEach((receive) => receive({ type: "stop" })),
    };
  }

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1100));

  test("that stops reporting while its page is shown has its last report dropped, and is shown again when it resumes", async () => {
    const { bridge, location, reports, stop } = page();
    const api = bridge.bind("premid:Music", {});
    if (!api) throw new Error("the Activity wasn't bound");
    const presence = new api.Presence({ clientId: "1" }) as {
      on: (event: string, listener: () => void) => void;
      setActivity: (data: object) => void;
    };
    let reporting = true;
    presence.on("UpdateData", () => {
      if (reporting) presence.setActivity({ details: "Browsing home" });
    });
    await tick();
    expect(reports().at(-1)?.data).toEqual({ details: "Browsing home" });

    // Silent, as YouTube Music is in a layout its script doesn't know: not stale yet.
    reporting = false;
    setSystemTime(Date.now() + STALE_MS - 2000);
    await tick();
    expect(reports().at(-1)?.data).toEqual({ details: "Browsing home" });
    setSystemTime(Date.now() + 3000);
    await tick();
    expect(reports().at(-1)?.data).toBeNull();

    reporting = true;
    await tick();
    expect(reports().at(-1)?.data).toEqual({ details: "Browsing home" });

    // Sooner once the page has moved on without the Activity noticing.
    reporting = false;
    location.href = "https://music.example/watch?v=1";
    setSystemTime(Date.now() + STALE_AFTER_MOVE_MS + 1000);
    await tick();
    expect(reports().at(-1)?.data).toBeNull();
    stop();
  }, 15_000);

  test("is bound once per document, and again once the background has stopped it", () => {
    const { bridge, stop } = page();
    const first = bridge.bind("premid:Music", {});
    expect(first).not.toBeNull();
    // Nothing opened yet, so nothing to tell it apart from one still starting.
    expect(bridge.bind("premid:Music", {})).toBeNull();
    if (!first) return;
    new first.Presence({ clientId: "1" });
    expect(bridge.bind("premid:Music", {})).toBeNull();
    stop();
    const again = bridge.bind("premid:Music", {});
    expect(again).not.toBeNull();
    expect(bridge.bind("premid:Music", {})).toBeNull();
    if (again) new again.Presence({ clientId: "1" });
    stop();
  });
});
