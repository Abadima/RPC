import { afterEach, describe, expect, test } from "bun:test";
import { formatElapsed, renderPresence, stopPresence } from "./presence-view";

// The clock lifecycle is code against the DOM, and this suite runs without a
// browser: the stubs below are only enough shape for the view's calls, and
// the timer spies count what stays scheduled. Nothing reaches production.

const globals = globalThis as typeof globalThis & { document?: unknown };
const live = new Map<unknown, unknown>();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realDocument = globals.document;

function count(): number {
  return live.size;
}

class FakeNode {
  className = "";
  textContent = "";
  children: Array<FakeNode | string> = [];
  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) this.children.push(node);
  }
  get firstElementChild(): FakeNode | undefined {
    const first = this.children[0];
    return first instanceof FakeNode ? first : undefined;
  }
  replaceChildren(...nodes: Array<FakeNode | string>): void {
    this.children.length = 0;
    this.append(...nodes);
  }
  setAttribute(): void {}
}

const fake = (): HTMLElement => new FakeNode() as unknown as HTMLElement;
const node = (root: HTMLElement): FakeNode => root as unknown as FakeNode;

afterEach(() => {
  for (const id of live.keys()) realClearInterval(id as never);
  live.clear();
  globals.document = realDocument;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

function withBrowser(): void {
  (globals as { document?: unknown }).document = { createElement: (): HTMLElement => fake() };
  globalThis.setInterval = ((fn: never, ms: number) => {
    const id = realSetInterval(fn, ms);
    live.set(id, id);
    return id;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id: unknown) => {
    live.delete(id);
    return realClearInterval(id as never);
  }) as typeof globalThis.clearInterval;
}

describe("formatElapsed", () => {
  test("minutes and seconds under an hour, hours once past one", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(59_999)).toBe("0:59");
    expect(formatElapsed(61_000)).toBe("1:01");
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(9_257_000)).toBe("2:34:17");
  });

  test("a start time in the future (clock skew) reads as zero", () => {
    expect(formatElapsed(-5000)).toBe("0:00");
  });
});

describe("the elapsed clock's lifetime", () => {
  test("a re-render stops the root's own clock; another root's goes on", () => {
    withBrowser();
    const first = fake();
    const second = fake();
    renderPresence(first, { activity: { name: "One", startedAt: Date.now() - 1500 } });
    renderPresence(second, { activity: { name: "Two", startedAt: Date.now() - 1500 } });
    expect(count()).toBe(2);
    renderPresence(first, { activity: { name: "One", startedAt: Date.now() - 1500 } });
    expect(count()).toBe(2);
    renderPresence(first, { activity: null });
    expect(count()).toBe(1);
    stopPresence(second);
    expect(count()).toBe(0);
  });

  test("stopPresence is idempotent, and a root without a clock is fine to stop", () => {
    withBrowser();
    const root = fake();
    stopPresence(root);
    expect(count()).toBe(0);
    renderPresence(root, { activity: { name: "X", startedAt: Date.now() } });
    expect(count()).toBe(1);
    stopPresence(root);
    stopPresence(root);
    expect(count()).toBe(0);
  });

  test("the clock runs for an elapsed presence and not for an empty one", () => {
    withBrowser();
    const root = fake();
    renderPresence(root, { activity: { name: "X", startedAt: Date.now() - 1500 } });
    expect(count()).toBe(1);
    const drewDigits = (branch: FakeNode): boolean =>
      /\d/.test(branch.textContent) ||
      branch.children.some((child) => child instanceof FakeNode && drewDigits(child));
    expect(drewDigits(node(root))).toBe(true);
    renderPresence(root, { activity: null });
    expect(count()).toBe(0);
  });
});
