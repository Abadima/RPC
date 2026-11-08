import { describe, expect, test } from "bun:test";
import { isCatastrophic } from "./redos";

/**
 * The shapes the shipped corpus legitimately uses (a quantified group whose
 * iterations each start on a token the previous can't repeat), and the shapes
 * that can pin the matcher's thread on a crafted URL. Every pattern in
 * dist/activities was checked with this detector at the time it was written:
 * these cases hold it still, and `isCatastrophic` reads every pattern
 * conservatively (it may refuse a pattern minutes could fail to hurt).
 */
describe("isCatastrophic", () => {
  test("the exponential families, flagged", () => {
    for (const pattern of [
      "(a+)+b",
      "(a+)+",
      "(a*)*b",
      "(a*)+$",
      "(x+x+)+y",
      "(?:a+)+b",
      "^(.+)+z$",
      "(a|aa)+b",
      "(a*|b)+",
      "(a|a?)+",
      "(A|A)+",
      "((a|a))+",
      "((a+)+)+z",
      "((x+x+)+y)+z",
      "(([a-z])+)+",
      "(\\d+)+z",
      "([0-9]+)*$",
      "(x*)*y",
      "((a+.)+)+z",
      "(a{1,}){2,}b",
      "^(.*a)+$",
      "(a+)(a+)+b",
    ]) {
      expect(isCatastrophic(pattern)).toBe(true);
    }
  });

  test("corpus-shaped subdomain patterns, allowed", () => {
    for (const pattern of [
      "^https?[:][/][/](www[.])?deepseek[.]com[/]",
      "^https?[:][/][/]([a-z0-9-]+[.])*example[.]com[/]",
      "^https?[:][/][/]([a-z0-9-]+[.])*navidrome([.][a-z]+)+[/]",
      "^https?[:][/][/]wink([.][a-z]+)+[/]",
      "^https?[:][/][/]((info|forums)+[.])*(sonicretro[.]org)[/]",
      "^https?[:][/][/](top[.])?([a-z]+)([.]v)?[.]daum([.][a-z]+)+[/]",
      "^https?[:][/][/]((docs[.])?deno[.]com|denostatus[.]com)[/]",
      "^https?[:][/][/](g[.])?(tobyjas[.]dev|jsemtobias[.]cz)[/]darkout[/]",
      "^https?[:][/][/]([a-z0-9-]+[.])*dankmemer[.]lol[/]",
    ]) {
      expect(isCatastrophic(pattern)).toBe(false);
    }
  });

  test("adjacent quantifiers and bounded groups, allowed", () => {
    for (const pattern of [
      "^(.+)$",
      "(a)+(b)*",
      "(?:ab)+a+",
      "(a?)*b{2,4}",
      "^(a[.])?b$",
      "https?://([a-z]+[.])+com/",
    ]) {
      expect(isCatastrophic(pattern)).toBe(false);
    }
  });

  test("shapes measured to hang V8 under the 2,048-character cap, flagged", () => {
    for (const pattern of [
      // A named group is a group: 240 ms at 26 characters, four times more per character.
      "(?<x>(a+)+)$",
      "^https://x[.]com/(?<id>([a-z]+)+)$",
      // A lookaround's body runs like the rest of the pattern: 166 ms at 26 characters.
      "^(?=(a+)+$)",
      "^(?!(a+)+$)",
      // A finite repeat splits as ambiguously: `{3}` took 41 s on 2,000 characters.
      "(a+){3}$",
      "(a+){2}$",
      "(a+){1,30}$",
      "(a{1,100})+$",
      // Runs that trade the same text: two take about a second at the cap, three take minutes.
      "a+a+$",
      "a+a+a+$",
      "[a-z]+[a-z0-9]+[a-z]+$",
      "^https?://x[.]com/.*a.*a.*a$",
      "\\d+[0-9]*\\d+$",
      "(a+)(a+)$",
      "(a)+(a)*$",
      "(a|b)+[ab]+$",
      // Classes read the way JS reads them: `[^]` is any character, `\w` a set, not a "w".
      "[^](a+)+$",
      "([\\w-]+a)+$",
      "([^/]+b)+$",
      "(\\D+x)+$",
    ]) {
      expect([pattern, isCatastrophic(pattern)]).toEqual([pattern, true]);
    }
  });

  test("what can't be read is flagged, not let through", () => {
    // Valid JS (a literal brace, a property escape), but not something this reads.
    expect(isCatastrophic("a{")).toBe(true);
    expect(isCatastrophic("(\\p{L}+)+$")).toBe(true);
  });

  test("lookarounds don't recurse into the enclosing group's body", () => {
    // A lookaround consumes nothing; the group's iterations are separated by it.
    expect(isCatastrophic("^(?!chzzk)([a-z]+)[.]naver$")).toBe(false);
    expect(
      isCatastrophic(
        "^https?[:][/][/]([a-z0-9-]+[.])*amazon([.][a-z]+)+[/](?!(-[/]([a-z0-9]+)[/])?(gp[/]video))",
      ),
    ).toBe(false);
  });

  test("separated runs and exact sets, allowed", () => {
    for (const pattern of [
      "^https?[:][/][/](([a-z0-9-]+[.])*seanime[.]app|localhost|(?:\\d{1,3}[.]){3}\\d{1,3}|[\\w-]+[.][\\w-]+[.]ts[.]net)(:\\d{1,5})?([/]|$)",
      "^https?[:][/][/](?<host>[a-z0-9-]+[.])*example[.]com[/]",
      "^(?!youtube.com|youtu.be).*",
      "[a-z]+[.][a-z]+$",
      "\\d+[.]\\d+$",
      "[^/]+[/][^/]+$",
    ]) {
      expect([pattern, isCatastrophic(pattern)]).toEqual([pattern, false]);
    }
  });

  test("the whole 0.1 s budget", () => {
    const start = performance.now();
    for (const pattern of ["(a+)+b", "^https?[:][/][/]([a-z0-9-]+[.])*example[.]com[/]"]) {
      void isCatastrophic(pattern);
    }
    expect(performance.now() - start).toBeLessThan(100);
  });
});
