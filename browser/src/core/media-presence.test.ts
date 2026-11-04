import { describe, expect, test } from "bun:test";
import type { Activity } from "./activity";
import { MediaTabs, isMediaActivity } from "./media-presence";

const song: Activity = { id: "player", name: "Player", type: "listening" };
const film: Activity = { id: "movies", name: "Movies", type: "watching" };
const timed: Activity = { id: "radio", name: "Radio", timestamps: { start: 1, end: 2 } };
const browsing: Activity = { id: "shop", name: "Shop", details: "Browsing" };
const elapsed: Activity = { id: "game", name: "Game", timestamps: { start: 1 } };

/** Resolves a tab to what it shows, for the tabs in `shows`; a tab not in it is gone. */
const resolver =
  (shows: Map<number, Activity | null>) =>
  async (tabId: number): Promise<Activity | null> => {
    if (!shows.has(tabId)) throw new Error("no such tab");
    return shows.get(tabId) ?? null;
  };

describe("isMediaActivity", () => {
  test("music and video are what an Activity presents as listening or watching, or with a length", () => {
    expect(isMediaActivity(song)).toBe(true);
    expect(isMediaActivity(film)).toBe(true);
    expect(isMediaActivity(timed)).toBe(true);
  });

  test("ordinary browsing is not, nor is elapsed time alone", () => {
    expect(isMediaActivity(browsing)).toBe(false);
    expect(isMediaActivity(elapsed)).toBe(false);
    expect(isMediaActivity({ id: "chess", name: "Chess", type: "playing" })).toBe(false);
    expect(isMediaActivity({ id: "contest", name: "Contest", type: "competing" })).toBe(false);
  });
});

describe("MediaTabs: which tabs are remembered", () => {
  test("a tab shared with music playing is remembered", () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, true);
    expect(tabs.has(1)).toBe(true);
  });

  test("a media tab that is silent was never playing, so it is not remembered", () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, false);
    expect(tabs.has(1)).toBe(false);
  });

  test("sound without a media Activity is not remembered: browsing with a video ad is not a video", () => {
    const tabs = new MediaTabs();
    tabs.shared(1, browsing, true);
    tabs.shared(2, elapsed, true);
    tabs.shared(3, null, true);
    expect([1, 2, 3].some((id) => tabs.has(id))).toBe(false);
  });

  test("pausing keeps a remembered tab, so playing again in the background still counts", () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, true);
    tabs.shared(1, song, false);
    expect(tabs.has(1)).toBe(true);
  });

  test("a tab that is shared again without media (it went to another site) is forgotten", () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, true);
    tabs.shared(1, null, true);
    expect(tabs.has(1)).toBe(false);
    tabs.shared(1, song, true);
    tabs.shared(1, browsing, true);
    expect(tabs.has(1)).toBe(false);
  });

  test("a closed tab, and clearing, forget", () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, true);
    tabs.shared(2, film, true);
    tabs.forget(1);
    expect(tabs.has(1)).toBe(false);
    tabs.clear();
    expect(tabs.has(2)).toBe(false);
  });
});

describe("MediaTabs: choosing one", () => {
  test("nothing remembered, nothing chosen", async () => {
    expect(await new MediaTabs().pick(1, resolver(new Map()))).toBeNull();
  });

  test("never the tab being shared: its own Activity is what it shows", async () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, true);
    const shows = new Map<number, Activity | null>([[1, song]]);
    expect(await tabs.pick(1, resolver(shows))).toBeNull();
  });

  test("with several players, only the one shared most recently is chosen", async () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, true);
    tabs.shared(2, film, true);
    tabs.shared(3, timed, true);
    const shows = new Map<number, Activity | null>([
      [1, song],
      [2, film],
      [3, timed],
    ]);
    expect(await tabs.pick(9, resolver(shows))).toEqual({ tab: 3, media: timed });
  });

  test("a player that stops gives way to the one before it, and back again when it resumes", async () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, true);
    tabs.shared(2, film, true);
    const shows = new Map<number, Activity | null>([
      [1, song],
      [2, film],
    ]);
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(2);
    shows.set(2, null);
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(1);
    shows.set(1, null);
    expect(await tabs.pick(9, resolver(shows))).toBeNull();
    shows.set(2, film);
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(2);
  });

  test("a background tab changing track does not take over: recency is when a tab was last shared", async () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, true);
    tabs.shared(2, film, true);
    const next: Activity = { ...song, details: "Next track" };
    const shows = new Map<number, Activity | null>([
      [1, next],
      [2, film],
    ]);
    // Tab 1 plays on and changes in the background; tab 2 was shared later and stays the one.
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(2);
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(2);
  });

  test("visiting a player again makes it the most recent", async () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, true);
    tabs.shared(2, film, true);
    tabs.shared(1, song, true);
    const shows = new Map<number, Activity | null>([
      [1, song],
      [2, film],
    ]);
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(1);
  });

  test("a tab that is gone is forgotten and skipped", async () => {
    const tabs = new MediaTabs();
    tabs.shared(1, song, true);
    tabs.shared(2, film, true);
    const shows = new Map<number, Activity | null>([[1, song]]);
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(1);
    expect(tabs.has(2)).toBe(false);
  });
});

describe("MediaTabs: telling which tabs are remembered", () => {
  function watched() {
    const heard: number[][] = [];
    return { tabs: new MediaTabs((tabs) => heard.push([...tabs])), heard };
  }

  test("is told when a tab is remembered, and when it is forgotten", () => {
    const { tabs, heard } = watched();
    tabs.shared(1, song, true);
    tabs.shared(2, film, true);
    tabs.forget(1);
    tabs.clear();
    expect(heard).toEqual([[1], [1, 2], [2], []]);
  });

  test("is told when visiting an older player changes which is the most recent, not when the newest is shared again", () => {
    const { tabs, heard } = watched();
    tabs.shared(1, song, true);
    tabs.shared(2, film, true);
    tabs.shared(2, film, true);
    tabs.shared(1, song, true);
    expect(heard).toEqual([[1], [1, 2], [2, 1]]);
  });

  test("is not told when a remembered tab is shared again, or paused: the same tabs are remembered", () => {
    const { tabs, heard } = watched();
    tabs.shared(1, song, true);
    tabs.shared(1, song, true);
    tabs.shared(1, song, false);
    expect(heard).toEqual([[1]]);
  });

  test("is told when a tab drops out for not showing media any more, or for being gone", async () => {
    const { tabs, heard } = watched();
    tabs.shared(1, song, true);
    tabs.shared(2, film, true);
    tabs.shared(1, null, true);
    await tabs.pick(9, resolver(new Map([[3, null]])));
    expect(heard).toEqual([[1], [1, 2], [2], []]);
  });

  test("is not told about tabs that were never remembered", () => {
    const { tabs, heard } = watched();
    tabs.shared(1, song, false);
    tabs.shared(2, browsing, true);
    tabs.forget(3);
    tabs.clear();
    expect(heard).toEqual([]);
  });
});

describe("MediaTabs: remembering across a restart", () => {
  test("restores tabs in the order they were remembered, oldest first, the most recent winning", async () => {
    const tabs = new MediaTabs();
    tabs.restore([4, 7, 2]);
    const shows = new Map<number, Activity | null>([
      [4, song],
      [7, film],
      [2, timed],
    ]);
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(2);
    shows.set(2, null);
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(7);
    shows.set(7, null);
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(4);
  });

  test("a tab shared since the restart is more recent than any restored one", async () => {
    const tabs = new MediaTabs();
    tabs.shared(5, film, true);
    tabs.restore([1, 2]);
    const shows = new Map<number, Activity | null>([
      [1, song],
      [2, timed],
      [5, film],
    ]);
    expect((await tabs.pick(9, resolver(shows)))?.tab).toBe(5);
  });

  test("is told what it now remembers, and keeps tabs it already had", () => {
    const heard: number[][] = [];
    const tabs = new MediaTabs((list) => heard.push([...list]));
    tabs.shared(5, film, true);
    tabs.restore([1, 5, 2]);
    expect(heard.at(-1)).toEqual([1, 2, 5]);
    expect(tabs.order()).toEqual([1, 2, 5]);
  });

  test("restoring nothing tells nobody", () => {
    const heard: number[][] = [];
    new MediaTabs((list) => heard.push([...list])).restore([]);
    expect(heard).toEqual([]);
  });

  test("a restored tab that is gone is forgotten when it is looked at", async () => {
    const tabs = new MediaTabs();
    tabs.restore([1, 2]);
    expect((await tabs.pick(9, resolver(new Map([[1, song]]))))?.tab).toBe(1);
    expect(tabs.has(2)).toBe(false);
  });
});
