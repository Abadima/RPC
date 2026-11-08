import { describe, expect, test } from "bun:test";
import { compileMatchPattern, matchPatterns, patternHost } from "./match-pattern";

const matches = (pattern: string, href: string): boolean =>
  compileMatchPattern(pattern)?.(new URL(href)) ?? false;

describe("match patterns", () => {
  test("a host, its scheme, and its path", () => {
    expect(matches("https://example.com/*", "https://example.com/")).toBe(true);
    expect(matches("https://example.com/*", "https://example.com/a/b?c=d")).toBe(true);
    expect(matches("https://example.com/*", "http://example.com/")).toBe(false);
    expect(matches("*://example.com/*", "http://example.com/")).toBe(true);
    expect(matches("https://example.com/watch*", "https://example.com/watch?v=1")).toBe(true);
    expect(matches("https://example.com/watch*", "https://example.com/home")).toBe(false);
  });

  test("subdomains only with *., and never a lookalike host", () => {
    expect(matches("https://*.example.com/*", "https://example.com/")).toBe(true);
    expect(matches("https://*.example.com/*", "https://www.example.com/")).toBe(true);
    expect(matches("https://example.com/*", "https://www.example.com/")).toBe(false);
    for (const href of [
      "https://example.com.evil.test/",
      "https://notexample.com/",
      "https://evil.test/example.com",
    ]) {
      expect(matches("https://*.example.com/*", href)).toBe(false);
    }
  });

  test("patterns for every site, or anything but web pages, aren't accepted", () => {
    for (const pattern of [
      "<all_urls>",
      "*://*/*",
      "https://*/*",
      "file:///*",
      "https://example.com",
      "chrome-extension://abc/*",
      "https://Example.com/*",
    ]) {
      expect(compileMatchPattern(pattern)).toBeNull();
    }
    expect(() => matchPatterns(["https://*/*"])).toThrow();
  });

  test("any of several, and the site each names", () => {
    const test = matchPatterns(["https://a.example/*", "https://*.b.example/*"]);
    expect(test(new URL("https://a.example/x"))).toBe(true);
    expect(test(new URL("https://c.b.example/"))).toBe(true);
    expect(test(new URL("https://c.example/"))).toBe(false);
    expect(patternHost("https://*.b.example/*")).toBe("b.example");
  });

  test("a pathname longer than 2048 characters isn't tested at all", () => {
    const path = "/".concat("a".repeat(3000));
    expect(matches("https://example.com/*", `https://example.com${path}`)).toBe(false);
    // A pattern that reads a run of the path can't be made to run long.
    expect(matches("https://example.com/a*a*b/*", `https://example.com/a${"a".repeat(3000)}`)).toBe(
      false,
    );
    expect(matches("https://example.com/a*a*b/*", `https://example.com/a${"a".repeat(30)}b/`)).toBe(
      true,
    );
  });
});
