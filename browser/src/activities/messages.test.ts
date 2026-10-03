import { describe, expect, test } from "bun:test";
import {
  MAX_MESSAGE,
  parseCollectorMessage,
  parsePageData,
  parseToCollector,
  parseFrameMessage,
  parsePageMessage,
  parsePageSpec,
  parseToPage,
} from "./messages";

describe("page reads", () => {
  test("never reach a prototype, so pick and omit can't write through one", () => {
    for (const path of ["__proto__.polluted", "player.constructor", "Object.prototype.x"]) {
      expect(parsePageSpec({ kind: "variables", paths: [path] })).toBeNull();
      expect(parsePageSpec({ kind: "exec", get: path })).toBeNull();
      expect(parsePageSpec({ kind: "exec", call: "player.track", pick: [path] })).toBeNull();
      expect(parsePageSpec({ kind: "exec", call: "player.track", omit: [path] })).toBeNull();
    }
    expect(parsePageSpec({ kind: "exec", get: "player.prototypeName" })).toEqual({
      kind: "exec",
      get: "player.prototypeName",
    });
  });
});

describe("PreMiD page messages", () => {
  test("only the expected shapes get through", () => {
    expect(
      parsePageMessage({
        type: "hello",
        activity: "premid:YouTube",
        clientId: "463097721130188830",
      }),
    ).toEqual({
      type: "hello",
      activity: "premid:YouTube",
      clientId: "463097721130188830",
    });
    expect(parsePageMessage({ type: "activity", clientId: "1", data: null })).toEqual({
      type: "activity",
      clientId: "1",
      data: null,
    });
    expect(parsePageMessage({ type: "hide", ids: ["a", "b"], hidden: true })).toEqual({
      type: "hide",
      ids: ["a", "b"],
      hidden: true,
    });
    expect(parsePageMessage({ type: "frames" })).toEqual({ type: "frames" });
    for (const bad of [
      null,
      "hello",
      { type: "hello", activity: "", clientId: "1" },
      { type: "activity", clientId: "1", data: "text" },
      { type: "hide", ids: [1], hidden: true },
      { type: "set", setting: "allowUserscripts", value: true },
      { type: "activity", clientId: "1", data: { details: "x".repeat(MAX_MESSAGE) } },
    ]) {
      expect(parsePageMessage(bad)).toBeNull();
    }
    expect(parseFrameMessage({ type: "data", data: { title: "x" } })).toEqual({
      type: "data",
      data: { title: "x" },
    });
    expect(parseFrameMessage({ type: "data" })).toBeNull();
  });

  test("page reads name variables by dot path, and nothing that could run code", () => {
    expect(parsePageSpec({ kind: "variables", paths: ["player.track.name", "$app"] })).toEqual({
      kind: "variables",
      paths: ["player.track.name", "$app"],
    });
    expect(
      parsePageSpec({ kind: "exec", call: "player.getState", args: [1], pick: ["track.name"] }),
    ).toEqual({
      kind: "exec",
      call: "player.getState",
      args: [1],
      pick: ["track.name"],
    });
    for (const bad of [
      { kind: "variables", paths: [] },
      { kind: "variables", paths: ["a[0]"] },
      { kind: "variables", paths: ["alert(1)"] },
      { kind: "exec", get: "a", call: "b" },
      { kind: "exec" },
      { kind: "exec", get: "a", pick: ["x y"] },
      { kind: "eval", code: "1" },
    ]) {
      expect(parsePageSpec(bad)).toBeNull();
    }
  });

  test("a page script reads only what the background sends it", () => {
    expect(parseToPage({ type: "settings", values: { a: true, b: { x: 1 } } })).toEqual({
      type: "settings",
      values: { a: true },
    });
    expect(parseToPage({ type: "stop" })).toEqual({ type: "stop" });
    expect(parseToPage({ type: "page-result", nonce: -1, value: 1 })).toBeNull();
  });

  test("page images are bounded: https only, a short list, short text", () => {
    const parsed = parsePageData({
      images: [
        { src: "https://img.example/a.jpg", alt: "  A cover  " },
        { src: "http://img.example/b.jpg" },
        { src: `https://img.example/${"x".repeat(400)}.jpg` },
        { src: "https://img.example/c.jpg", alt: "y".repeat(500) },
        "https://img.example/d.jpg",
        null,
      ],
    });
    expect(parsed).toEqual({
      images: [
        { src: "https://img.example/a.jpg", alt: "A cover" },
        { src: "https://img.example/c.jpg", alt: "y".repeat(64) },
      ],
    });
    const many = Array.from({ length: 80 }, (_, index) => ({
      src: `https://img.example/${index}`,
    }));
    expect(parsePageData({ images: many })?.images).toHaveLength(24);
    expect(parsePageData({ images: "https://img.example/a.jpg" })).toEqual({});
  });

  test("the collector's messages are bounded the same way", () => {
    expect(parseCollectorMessage({ type: "hello", activity: "tunes" })).toEqual({
      type: "hello",
      activity: "tunes",
    });
    expect(
      parsePageData({
        media: { title: "x".repeat(1000), playing: "yes", start: -5, end: 1.5, duration: 200 },
        thumbnail: "http://img.example/a.jpg",
        creatorIcon: "https://img.example/b.jpg",
      }),
    ).toEqual({ media: { title: "x".repeat(256), duration: 200 } });
    expect(
      parsePageData({ media: { playing: true, start: 1_700_000_000_000, end: 1_700_000_200_000 } }),
    ).toEqual({
      media: { playing: true, start: 1_700_000_000_000, end: 1_700_000_200_000 },
    });
    expect(parsePageData({ media: { kind: "video", title: "x" } })).toEqual({
      media: { kind: "video", title: "x" },
    });
    expect(parsePageData({ media: { kind: "iframe", title: "x" } })).toEqual({
      media: { title: "x" },
    });
    expect(parseToCollector({ type: "collect", kinds: ["media", "cookies"] })).toEqual({
      type: "collect",
      kinds: ["media"],
    });
  });
});
