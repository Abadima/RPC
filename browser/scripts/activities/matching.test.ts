import { describe, expect, test } from "bun:test";
import { compileMatch, registered } from "../../src/activities/manifest";
import { ActivityRegistry } from "../../src/core/registry";
import {
  canRun,
  grantsFrom,
  missingSites,
  siteGranted,
  type Grants,
} from "../../src/core/site-access";
import { manifestFrom } from "./metadata";
import { originsFor } from "./premid";

/** PreMiD's own Arch Linux Activity: `url: "archlinux.org"`, and a regExp that takes every subdomain. */
const ARCH = "^https?[:][/][/]([a-z0-9-]+[.])*archlinux[.]org[/]";

function arch(hosts = ["archlinux.org"], regExp = ARCH) {
  return manifestFrom({
    source: "premid",
    id: "premid:ArchLinux",
    name: "ArchLinux",
    hosts,
    match: { regExp },
    data: ["media"],
    origins: originsFor(hosts, regExp),
  });
}

describe("which sites an Activity asks access for", () => {
  test("a regExp that takes subdomains asks for them, and the host itself", () => {
    expect(originsFor(["archlinux.org"], ARCH)).toEqual(["*://*.archlinux.org/*"]);
    // At least one subdomain label, as Wikipedia's family does.
    expect(
      originsFor(["wikibooks.org"], "^https?[:][/][/]([a-z0-9-]+[.])+wikibooks[.]org[/]"),
    ).toEqual(["*://*.wikibooks.org/*"]);
  });

  test("a regExp for one host asks for that host and nothing wider", () => {
    expect(originsFor(["www.youtube.com"], "^https?[:][/][/]www[.]youtube[.]com[/]")).toEqual([
      "*://www.youtube.com/*",
    ]);
    expect(originsFor(["example.com"], "^https?[:][/][/]example[.]com[/]")).toEqual([
      "*://example.com/*",
    ]);
  });

  test("a site named by its bare domain, whose regExp takes www, asks for www", () => {
    const regExp = "^https?[:][/][/](www|preview)[.]duolingo[.](com|cn)[/]";
    expect(originsFor(["duolingo.com"], regExp)).toEqual(["*://www.duolingo.com/*"]);
    expect(originsFor(["example.com"], "^https?[:][/][/](www[.])?example[.]com[/]")).toEqual([
      "*://example.com/*",
      "*://www.example.com/*",
    ]);
  });

  test("every host is asked about, and none twice", () => {
    expect(
      originsFor(
        ["a.example", "b.example", "a.example"],
        "^https?[:][/][/]([a-z0-9-]+[.])*a[.]example[/]|^https?[:][/][/]b[.]example[/]",
      ),
    ).toEqual(["*://*.a.example/*", "*://b.example/*"]);
  });

  test("a regExp for particular paths keeps the host as named", () => {
    expect(
      originsFor(["example.com"], "^https?[:][/][/]([a-z0-9-]+[.])*example[.]com[/]watch[/]"),
    ).toEqual(["*://example.com/*"]);
  });

  test("an address or localhost is never given subdomains", () => {
    expect(originsFor(["localhost"], "^https?[:][/][/].*[/]")).toEqual(["*://localhost/*"]);
    expect(originsFor(["192.168.1.1"], "^https?[:][/][/].*[/]")).toEqual(["*://192.168.1.1/*"]);
  });
});

describe("Arch Linux, from its metadata to running on a subdomain", () => {
  const { info, match } = arch();
  const test_ = compileMatch(match);
  const at = (href: string): boolean => test_(new URL(href));

  test("the regExp takes the site, its subdomains, and any path", () => {
    for (const href of [
      "https://archlinux.org/",
      "https://archlinux.org",
      "http://archlinux.org/packages/",
      "https://wiki.archlinux.org/title/Installation_guide",
      "https://bbs.archlinux.org/viewtopic.php?id=1",
      "https://aur.archlinux.org/packages?O=0",
      "https://a.b.archlinux.org/x",
    ]) {
      expect(at(href)).toBe(true);
    }
  });

  test("and nothing that only looks like it", () => {
    for (const href of [
      "https://archlinux.org.evil.test/",
      "https://notarchlinux.org/",
      "https://evil.test/archlinux.org/",
      "https://wiki.archlinux.org.evil.test/",
      "ftp://archlinux.org/",
    ]) {
      expect(at(href)).toBe(false);
    }
  });

  test("it asks for the host and its subdomains, which is what the regExp takes", () => {
    expect(info.origins).toEqual(["*://*.archlinux.org/*"]);
    expect(info.hosts).toEqual(["archlinux.org"]);
  });

  test("with that access, it runs on every subdomain it matches", () => {
    const grants: Grants = grantsFrom({ origins: info.origins ?? [] });
    for (const href of [
      "https://archlinux.org/",
      "https://wiki.archlinux.org/title/Main_page",
      "https://bbs.archlinux.org/",
    ]) {
      expect(canRun(info, new URL(href), grants)).toBe(true);
    }
    expect(canRun(info, new URL("https://archlinux.org.evil.test/"), grants)).toBe(false);
    expect(missingSites(info, grants)).toEqual([]);
  });

  test("a grant for the bare host alone doesn't cover its subdomains (the bug it was)", () => {
    const apexOnly = grantsFrom({ origins: ["*://archlinux.org/*"] });

    expect(canRun(info, new URL("https://archlinux.org/"), apexOnly)).toBe(true);
    expect(canRun(info, new URL("https://wiki.archlinux.org/"), apexOnly)).toBe(false);
    expect(siteGranted("*://*.archlinux.org/*", apexOnly)).toBe(false);
    expect(missingSites(info, apexOnly)).toEqual(["*://*.archlinux.org/*"]);
  });

  test("the registry picks it on a subdomain, and the runtime's access check lets it run", () => {
    const registry = new ActivityRegistry();
    registry.register(registered({ info, match, script: { file: "archlinux", clientIds: ["1"] } }));
    const url = new URL("https://wiki.archlinux.org/title/Main_page");
    const grants = grantsFrom({ origins: info.origins ?? [] });
    expect(registry.resolve(url, (candidate) => canRun(candidate, url, grants))?.info.id).toBe(
      "premid:ArchLinux",
    );
    expect(registry.resolve(url, (candidate) => canRun(candidate, url, grantsFrom({})))).toBeNull();
  });
});
