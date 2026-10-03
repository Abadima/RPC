import { describe, expect, test } from "bun:test";
import { compareVersions, parseRelease } from "./version";

describe("parseRelease", () => {
  test("reads the numbers and ignores a suffix", () => {
    expect(parseRelease("1.2.3")).toEqual([1, 2, 3]);
    expect(parseRelease("1.0.0-beta.1")).toEqual([1, 0, 0]);
    expect(parseRelease("12.0.4+build.7")).toEqual([12, 0, 4]);
  });

  test("refuses anything else", () => {
    for (const text of ["", "1", "1.2", "v1.0.0", "1.0.0.0", "1.x.0", "-1.0.0", "1.0.0 beta"]) {
      expect(parseRelease(text)).toBeNull();
    }
    expect(parseRelease("1.0.0-" + "a".repeat(40))).toBeNull();
    expect(parseRelease("9999999999.0.0")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("only another major is a block", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBeNull();
    expect(compareVersions("2.1.0", "1.9.9")).toBeNull();
    expect(compareVersions("1.0.0", "nonsense")).toBeNull();
    expect(compareVersions("nonsense", "1.0.0")).toBeNull();
  });

  test("a beta or the same numbers are level", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe("none");
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe("none");
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBe("none");
  });

  test("the older side is the one to update", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBe("desktop");
    expect(compareVersions("1.0.1", "1.0.0")).toBe("desktop");
    expect(compareVersions("1.1.0", "1.2.0")).toBe("extension");
    expect(compareVersions("1.0.0", "1.0.3")).toBe("extension");
  });
});
