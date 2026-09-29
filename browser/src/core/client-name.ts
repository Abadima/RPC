interface NavigatorLike {
  userAgent: string;
  userAgentData?: { brands?: Array<{ brand: string }> };
}

const OPERATING_SYSTEMS: Array<[RegExp, string]> = [
  [/Android/, "Android"],
  [/iPhone|iPad/, "iOS"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Macintosh|Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

function browserName(nav: NavigatorLike): string {
  const ua = nav.userAgent;
  const brands = nav.userAgentData?.brands?.map((b) => b.brand) ?? [];
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Vivaldi/.test(ua)) return "Vivaldi";
  if (brands.includes("Brave")) return "Brave";
  if (brands.includes("Google Chrome")) return "Chrome";
  if (/Chrome\//.test(ua)) return brands.length > 0 ? "Chromium" : "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Browser";
}

/**
 * How this client introduces itself to Desktop in `hello` ("Firefox on
 * Linux"), so a person can tell entries apart in Desktop's client list. It
 * proves nothing and Desktop treats it as untrusted text.
 */
export function describeClient(nav: NavigatorLike = navigator, prefix = ""): string {
  const os = OPERATING_SYSTEMS.find(([pattern]) => pattern.test(nav.userAgent))?.[1];
  const name = `${prefix}${browserName(nav)}`;
  return os ? `${name} on ${os}` : name;
}
