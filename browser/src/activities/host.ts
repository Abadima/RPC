import { PAGE_DATA_KINDS, type ActivityInfo, type PageDataKind } from "../core/activity";
import {
  allowedData,
  isActivityOn,
  saveActivityState,
  settingValues,
  type ActivityState,
  type ActivityStates,
} from "../core/activity-state";
import { DEFAULT_PREFERENCES, type PageDataPreferences } from "../core/preferences";
import type { ActivityRegistry, Page, PageData } from "../core/registry";
import { NO_GRANTS, canRun, grantsFrom, pageGranted, type Grants } from "../core/site-access";
import { limitPageData, toActivity, type PresenceDataWire } from "../premid/presence-data";
import {
  COLLECTOR_PATH,
  INDEX_PATH,
  PREMID_ID_PREFIX,
  compileMatch,
  manifestPath,
  parseIndex,
  parseManifest,
  registered,
  scriptPaths,
  type ActivityManifest,
} from "./manifest";
import {
  MAX_PAGE_RESULT,
  PAGE_DATA_PORT,
  PREMID_FRAME_PORT,
  PREMID_PORT,
  parseCollectorMessage,
  parseFrameMessage,
  parsePageMessage,
  type PageSpec,
  type ToCollector,
  type ToPage,
} from "./messages";
import { readPage } from "./page-world";
import { COLLECTOR_KEY } from "./collector";

/** Just enough of `runtime.Port` for this (and for tests' fakes). */
export interface Port {
  name: string;
  sender?: { id?: string; url?: string; frameId?: number; tab?: { id?: number } };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

/** The browser APIs the host uses; `chromePageBrowser` is the real one. */
export interface PageBrowser {
  extensionId: string;
  onConnect(listener: (port: Port) => void): void;
  /** Site access was granted or taken back (from the dashboard, or the browser's own settings). */
  onAccessChange(listener: () => void): void;
  grants(): Promise<Grants>;
  /** Injects packaged scripts into a tab's top frame, or every frame it may; rejects without access. */
  inject(tabId: number, files: string[], allFrames: boolean): Promise<void>;
  /** Starts the collector (already injected) in a tab for one Activity. */
  startCollector(tabId: number, activity: string): Promise<void>;
  /** Runs `readPage` in one frame's own world. */
  readPage(tabId: number, frameId: number, spec: PageSpec): Promise<string | null>;
  /** Which packaged file each PreMiD Activity's manifest is in, by id. */
  loadIndex(): Promise<Record<string, string>>;
  loadManifest(file: string): Promise<ActivityManifest | null>;
  saveState(id: string, patch: ActivityState): Promise<void>;
}

/** Starts the collector for `activity`; serialized by the browser, so it uses nothing from outside. */
function startInPage(key: string, activity: string): void {
  const collector: unknown = Reflect.get(globalThis, key);
  const start: unknown =
    typeof collector === "object" && collector !== null ? Reflect.get(collector, "start") : null;
  if (typeof start === "function") Reflect.apply(start, collector, [activity]);
}

/** The extension's own APIs. `scripting` is optional, so it's looked up when needed. */
export function chromePageBrowser(): PageBrowser {
  const scripting = (): typeof chrome.scripting => {
    // Undefined until the optional `scripting` permission is granted.
    const api = "scripting" in chrome ? chrome.scripting : undefined;
    if (!api) throw new Error("the scripting permission isn't granted");
    return api;
  };
  const fetchJson = async (path: string): Promise<unknown> => {
    const response = await fetch(chrome.runtime.getURL(path));
    return response.ok ? response.json() : null;
  };
  return {
    extensionId: chrome.runtime.id,
    onConnect: (listener) => chrome.runtime.onConnect.addListener(listener),
    onAccessChange: (listener) => {
      chrome.permissions.onAdded.addListener(listener);
      chrome.permissions.onRemoved.addListener(listener);
    },
    grants: async () => grantsFrom(await chrome.permissions.getAll()),
    inject: async (tabId, files, allFrames) => {
      await scripting().executeScript({ target: { tabId, allFrames }, files });
    },
    startCollector: async (tabId, activity) => {
      await scripting().executeScript({
        target: { tabId, frameIds: [0] },
        func: startInPage,
        args: [COLLECTOR_KEY, activity],
      });
    },
    readPage: async (tabId, frameId, spec) => {
      const [result] = await scripting().executeScript({
        target: { tabId, frameIds: [frameId] },
        world: "MAIN",
        func: readPage,
        args: [spec, MAX_PAGE_RESULT],
      });
      return typeof result?.result === "string" ? result.result : null;
    },
    loadIndex: async () => parseIndex(await fetchJson(INDEX_PATH)).files,
    loadManifest: async (file) => parseManifest(await fetchJson(manifestPath(file))),
    saveState: async (id, patch) => {
      await saveActivityState(id, patch);
    },
  };
}

/** Reports turning into refreshes, at most this often per tab: the first at once, the rest coalesced. */
const REPORT_INTERVAL_MS = 200;
/** Iframe scripts are injected again at most this often per page. */
const FRAMES_INTERVAL_MS = 2000;

function webUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Something running in a page for an Activity: its port, and the page it came from. */
interface Live {
  port: Port;
  manifest: ActivityManifest;
  url: URL;
  kind: "premid" | "frame" | "collector";
}

type Report =
  | {
      kind: "premid";
      port: Port;
      manifest: ActivityManifest;
      clientId: string;
      data: PresenceDataWire | null;
    }
  | { kind: "collector"; port: Port; manifest: ActivityManifest; data: PageData };

const isPremid = (id: string): boolean => id.startsWith(PREMID_ID_PREFIX);

/**
 * Runs what Activities need in pages, for the background script, the same
 * way for both kinds: a native Activity that takes page data gets
 * Parousia's collector (collector.ts); a PreMiD Activity gets its own script
 * on PreMiD's API (src/premid/page.ts). Either way, only in the active tab,
 * only on a page the Activity matches, and only where its site was granted:
 * an Activity that reads pages is unavailable where it isn't. Page data kinds
 * switched off in Settings > Privacy are never collected (native) or never
 * shown (PreMiD).
 *
 * Everything a page sends is untrusted: a port is served only from this
 * extension's content script in a tab, for an Activity that's on and matches
 * the page it came from, and every message is parsed and bounded
 * (messages.ts). Taking back a site's access stops what runs there at once.
 * PreMiD manifests are read only once one is turned on.
 */
export class PageHost {
  private index: Promise<Record<string, string>> | null = null;
  private states: ActivityStates = {};
  private pageData: PageDataPreferences = DEFAULT_PREFERENCES.pageData;
  private grantsNow: Promise<Grants> | null = null;
  /** What `grantsNow` last settled to, for synchronous checks. */
  private granted: Grants = NO_GRANTS;
  /** Activities that read pages and are on: PreMiD's once loaded, native ones that take page data. */
  private readonly running = new Map<string, ActivityManifest>();
  private readonly natives: Map<string, ActivityManifest>;
  private readonly live = new Map<number, Set<Live>>();
  private readonly reports = new Map<number, Report>();
  private readonly pending = new Map<number, ReturnType<typeof setTimeout>>();
  /** Tabs that reported again while `pending`, to refresh once it ends. */
  private readonly again = new Set<number>();
  /** The URL each tab's scripts were last injected for. */
  private readonly visited = new Map<number, string>();
  /** Settles once the first states are in, so a page connecting right after a restart isn't turned away. */
  private readonly ready = Promise.withResolvers<void>();

  constructor(
    private readonly registry: ActivityRegistry,
    private readonly browser: PageBrowser,
    natives: readonly ActivityManifest[],
    /** A tab's page data or report changed. */
    private readonly changed: (tabId: number) => void,
  ) {
    this.natives = new Map(
      natives
        .filter((manifest) => (manifest.info.data?.length ?? 0) > 0)
        .map((manifest) => [manifest.info.id, manifest]),
    );
    browser.onConnect((port) => {
      if (port.name === PREMID_PORT) this.serve(port, "premid");
      else if (port.name === PREMID_FRAME_PORT) this.serve(port, "frame");
      else if (port.name === PAGE_DATA_PORT) this.serve(port, "collector");
    });
    browser.onAccessChange(() => void this.accessChanged());
  }

  /** Whether anything that reads pages is on, so page loads are worth watching. */
  get active(): boolean {
    return this.running.size > 0;
  }

  private grants(): Promise<Grants> {
    if (!this.grantsNow) {
      const pending = this.browser.grants().catch(() => NO_GRANTS);
      this.grantsNow = pending;
      void pending.then((grants) => {
        if (this.grantsNow === pending) this.granted = grants;
      });
    }
    return this.grantsNow;
  }

  /** Whether `info` may run at `url`: it's on, and its site is granted if it reads pages. */
  usable(info: ActivityInfo, url: URL): boolean {
    return isActivityOn(info, this.states) && canRun(info, url, this.granted);
  }

  private async load(id: string): Promise<ActivityManifest | null> {
    this.index ??= this.browser.loadIndex().catch(() => ({}));
    const file = (await this.index)[id];
    if (!file) return null;
    const manifest = await this.browser.loadManifest(file).catch(() => null);
    return manifest?.info.id === id && manifest.script ? manifest : null;
  }

  /** Settings > Privacy changed what Activities may read: running scripts are told. */
  setPageData(pageData: PageDataPreferences): void {
    if (PAGE_DATA_KINDS.every((kind) => pageData[kind] === this.pageData[kind])) return;
    this.pageData = pageData;
    this.visited.clear();
    for (const lives of this.live.values()) {
      for (const live of lives) this.tell(live);
    }
  }

  /** What's turned on changed: registers PreMiD Activities as they're turned on, stops what's turned off. */
  async setStates(states: ActivityStates): Promise<void> {
    this.states = states;
    const wanted = Object.keys(states).filter(
      (id) => isPremid(id) && states[id]?.on === true && !this.running.has(id),
    );
    const loaded = await Promise.all(wanted.map((id) => this.load(id)));
    // A newer call may have run while these loaded; only the latest states count.
    if (this.states !== states) return;

    for (const [id, manifest] of this.running) {
      if (isActivityOn(manifest.info, states)) continue;
      this.running.delete(id);
      if (manifest.script) this.registry.unregister(id);
      this.stop((live) => live.manifest.info.id === id);
    }
    for (const manifest of loaded) {
      // Turned on, but another implementation of its website is the one chosen.
      if (!manifest || this.running.has(manifest.info.id) || !isActivityOn(manifest.info, states)) {
        continue;
      }
      try {
        this.registry.register(registered(manifest));
      } catch {
        continue;
      }
      this.running.set(manifest.info.id, manifest);
    }
    for (const [id, manifest] of this.natives) {
      if (isActivityOn(manifest.info, states)) this.running.set(id, manifest);
    }
    // What's allowed may have changed: pages get it again, and are looked at again.
    this.visited.clear();
    for (const lives of this.live.values()) {
      for (const live of lives) this.tell(live);
    }
    this.ready.resolve();
  }

  /** What a running script in a page is told: PreMiD's its settings, the collector what it may read. */
  private tell(live: Live): void {
    if (live.kind === "frame") return;
    const allowed = allowedData(live.manifest.info, this.pageData);
    if (live.kind === "collector") {
      const message: ToCollector =
        allowed.length > 0 ? { type: "collect", kinds: allowed } : { type: "stop" };
      this.post(live.port, message);
      return;
    }
    this.post(live.port, {
      type: "settings",
      values: { ...live.manifest.script?.fixed, ...settingValues(live.manifest.info, this.states) },
    });
  }

  /**
   * What an Activity gets from the page in `tabId` now at `url`, for the
   * runtime: the page data kinds it has, and what was read or reported.
   * Injects what the Activity needs there, if it isn't already. An Activity
   * that reads pages is found here only where its site is granted.
   */
  async page(tabId: number, url: URL): Promise<Pick<Page, "granted" | "data" | "reported">> {
    await this.grants();
    const resolved = this.registry.resolve(url, (info) => this.usable(info, url));
    const manifest = resolved && this.running.get(resolved.info.id);
    if (!manifest) return {};
    const granted = allowedData(manifest.info, this.pageData);
    this.visit(tabId, url, manifest, granted);
    const report = this.reports.get(tabId);
    if (report?.manifest !== manifest) return { granted };
    if (report.kind === "collector") return { granted, data: report.data };
    const reported =
      report.data &&
      limitPageData(
        toActivity(manifest, report.data, url, report.clientId),
        granted,
        manifest.info,
      );
    return { granted, reported };
  }

  private visit(
    tabId: number,
    url: URL,
    manifest: ActivityManifest,
    granted: readonly PageDataKind[],
  ): void {
    if (this.visited.get(tabId) === url.href) return;
    this.visited.set(tabId, url.href);
    const ignore = (): void => {
      // No access after all, or a page the browser protects.
    };
    if (manifest.script) {
      const { page, frame } = scriptPaths(manifest.script);
      this.browser.inject(tabId, page, false).catch(ignore);
      if (frame.length > 0) this.browser.inject(tabId, frame, true).catch(ignore);
    } else if (granted.length > 0) {
      const id = manifest.info.id;
      this.browser
        .inject(tabId, [COLLECTOR_PATH], false)
        .then(() => this.browser.startCollector(tabId, id))
        .catch(ignore);
    }
  }

  /** A new document loaded in the tab: its scripts need injecting again. */
  loaded(tabId: number): void {
    this.visited.delete(tabId);
  }

  /** The tab closed. */
  forget(tabId: number): void {
    this.visited.delete(tabId);
    this.reports.delete(tabId);
    this.live.delete(tabId);
    clearTimeout(this.pending.get(tabId));
    this.pending.delete(tabId);
    this.again.delete(tabId);
  }

  /** Access was granted or taken back: what runs on sites no longer granted stops now. */
  private async accessChanged(): Promise<void> {
    this.grantsNow = null;
    this.visited.clear();
    const grants = await this.grants();
    this.granted = grants;
    this.stop((live) => !pageGranted(live.url, grants));
    for (const tabId of this.live.keys()) this.changed(tabId);
  }

  private post(port: Port, message: ToPage | ToCollector): void {
    try {
      port.postMessage(message);
    } catch {
      // The page went away.
    }
  }

  private refuse(port: Port): void {
    this.post(port, { type: "stop" });
    port.disconnect();
  }

  /** Stops every script `which` picks, and drops what they reported. */
  private stop(which: (live: Live) => boolean): void {
    for (const [tabId, lives] of this.live) {
      for (const live of lives) {
        if (!which(live)) continue;
        lives.delete(live);
        this.refuse(live.port);
        if (this.reports.get(tabId)?.port === live.port) {
          this.reports.delete(tabId);
          this.changed(tabId);
        }
      }
    }
  }

  private report(tabId: number, report: Report): void {
    this.reports.set(tabId, report);
    if (this.pending.has(tabId)) {
      this.again.add(tabId);
      return;
    }
    this.changed(tabId);
    const settle = (): void => {
      if (!this.again.delete(tabId)) {
        this.pending.delete(tabId);
        return;
      }
      this.changed(tabId);
      this.pending.set(tabId, setTimeout(settle, REPORT_INTERVAL_MS));
    };
    this.pending.set(tabId, setTimeout(settle, REPORT_INTERVAL_MS));
  }

  private async answerPage(
    port: Port,
    tabId: number,
    frameId: number,
    nonce: number,
    spec: PageSpec,
  ): Promise<void> {
    let value: unknown;
    try {
      const text = await this.browser.readPage(tabId, frameId, spec);
      value = text !== null && text.length <= MAX_PAGE_RESULT ? JSON.parse(text) : undefined;
    } catch {
      value = undefined;
    }
    this.post(port, { type: "page-result", nonce, value });
  }

  /** Whether `manifest` may run as `kind` on the page at `url` (with `granted` sites). */
  private allowed(
    manifest: ActivityManifest,
    kind: Live["kind"],
    url: URL,
    grants: Grants,
  ): boolean {
    if (!pageGranted(url, grants)) return false;
    if (kind === "collector") {
      return (
        !manifest.script &&
        compileMatch(manifest.match)(url) &&
        allowedData(manifest.info, this.pageData).length > 0
      );
    }
    if (!manifest.script) return false;
    if (kind === "premid") return compileMatch(manifest.match)(url);
    const iframe = manifest.script.iframe;
    if (!iframe) return false;
    if (iframe.regExp === null) return true;
    try {
      return compileMatch({ regExp: iframe.regExp })(url);
    } catch {
      return false;
    }
  }

  private serve(port: Port, kind: Live["kind"]): void {
    const sender = port.sender;
    const tabId = sender?.tab?.id;
    const url = webUrl(sender?.url);
    const frameId = sender?.frameId ?? 0;
    const topOnly = kind !== "frame";
    // Only this extension's content scripts, in a tab, in a web page (and the right kind of frame).
    if (
      sender?.id !== this.browser.extensionId ||
      tabId === undefined ||
      url === null ||
      (frameId === 0) !== topOnly
    ) {
      port.disconnect();
      return;
    }
    let live: Live | null = null;
    let framesAt = 0;

    const hello = async (activity: string): Promise<void> => {
      const manifest = this.running.get(activity);
      if (!manifest || !this.allowed(manifest, kind, url, await this.grants())) {
        this.refuse(port);
        return;
      }
      live = { port, manifest, url, kind };
      const lives = this.live.get(tabId) ?? new Set();
      lives.add(live);
      this.live.set(tabId, lives);
      this.tell(live);
    };

    const handle = async (raw: unknown): Promise<void> => {
      if (kind === "collector") {
        const message = parseCollectorMessage(raw);
        if (message?.type === "hello" && !live) await hello(message.activity);
        else if (message?.type === "data" && live) {
          this.report(tabId, {
            kind: "collector",
            port,
            manifest: live.manifest,
            data: message.data,
          });
        }
        return;
      }
      if (kind === "frame") {
        const message = parseFrameMessage(raw);
        if (message?.type === "hello" && !live) await hello(message.activity);
        else if (message?.type === "data" && live) {
          // To the same Activity's page script in the same tab, and nowhere else.
          for (const other of this.live.get(tabId) ?? []) {
            if (other.kind === "premid" && other.manifest === live.manifest) {
              this.post(other.port, { type: "frame-data", data: message.data });
            }
          }
        } else if (message?.type === "page" && live) {
          await this.answerPage(port, tabId, frameId, message.nonce, message.spec);
        }
        return;
      }
      const message = parsePageMessage(raw);
      if (!message) return;
      if (!live) {
        if (message.type === "hello") await hello(message.activity);
        return;
      }
      const { manifest } = live;
      const script = manifest.script;
      if (!script) return;
      switch (message.type) {
        case "activity": {
          // An Activity may switch between the Applications its source names, and no others.
          const [first = ""] = script.clientIds;
          const clientId = script.clientIds.includes(message.clientId) ? message.clientId : first;
          this.report(tabId, { kind: "premid", port, manifest, clientId, data: message.data });
          return;
        }
        case "page":
          await this.answerPage(port, tabId, 0, message.nonce, message.spec);
          return;
        case "hide": {
          const hidden = new Set(this.states[manifest.info.id]?.hidden ?? []);
          for (const id of message.ids) {
            if (message.hidden) hidden.add(id);
            else hidden.delete(id);
          }
          await this.browser.saveState(manifest.info.id, { hidden: [...hidden] });
          return;
        }
        case "frames":
          if (script.iframe && Date.now() - framesAt >= FRAMES_INTERVAL_MS) {
            framesAt = Date.now();
            this.browser.inject(tabId, scriptPaths(script).frame, true).catch(() => {});
          }
          return;
        case "hello":
          return;
      }
    };

    // In order, once the Activities that are on are known (the background may have just started).
    let queue = this.ready.promise;
    port.onMessage.addListener((raw) => {
      queue = queue.then(() => handle(raw)).catch(() => {});
    });
    port.onDisconnect.addListener(() => {
      if (live) this.live.get(tabId)?.delete(live);
      if (this.reports.get(tabId)?.port === port) {
        this.reports.delete(tabId);
        this.changed(tabId);
      }
    });
  }
}
