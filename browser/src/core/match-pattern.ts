/**
 * WebExtension match patterns ("https://*.example.com/*"): how a native
 * Activity lists the pages it's for. Only web pages: the scheme is `http`,
 * `https`, or `*` (both), and the host is a name, optionally with every
 * subdomain (`*.`), never every site.
 */
const PATTERN = /^(\*|https?):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(\/.*)$/;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longer paths aren't tested, as `compileMatch` caps whole URLs. */
const MAX_PATH = 2048;

export function compileMatchPattern(pattern: string): ((url: URL) => boolean) | null {
  const parts = PATTERN.exec(pattern);
  if (!parts) return null;
  const [, scheme, subdomains, host, path = "/"] = parts;
  const pathPattern = new RegExp(`^${path.split("*").map(escape).join(".*")}$`);
  return (url) =>
    (scheme === "*"
      ? url.protocol === "https:" || url.protocol === "http:"
      : url.protocol === `${scheme}:`) &&
    (url.hostname === host || (subdomains !== undefined && url.hostname.endsWith(`.${host}`))) &&
    url.pathname.length + url.search.length <= MAX_PATH &&
    pathPattern.test(url.pathname + url.search);
}

export function matchPatterns(patterns: readonly string[]): (url: URL) => boolean {
  const tests = patterns.map((pattern) => {
    const test = compileMatchPattern(pattern);
    if (!test) throw new Error(`not a match pattern for particular sites: ${pattern}`);
    return test;
  });
  return (url) => tests.some((test) => test(url));
}

/** The site a pattern names, for display: `https://*.example.com/*` is `example.com`. */
export function patternHost(pattern: string): string {
  return PATTERN.exec(pattern)?.[3] ?? pattern;
}
