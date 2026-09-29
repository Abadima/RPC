import { describe, expect, test } from "bun:test";
import { describeClient } from "./client-name";

const LINUX_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

describe("describeClient", () => {
  test("names the browser and operating system", () => {
    expect(
      describeClient({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0",
      }),
    ).toBe("Firefox on Linux");
    expect(
      describeClient({
        userAgent: `${LINUX_CHROME.replace("X11; Linux x86_64", "Windows NT 10.0; Win64; x64")} Edg/152.0.0.0`,
      }),
    ).toBe("Edge on Windows");
  });

  test("tells Chromium-family browsers apart by their brands", () => {
    expect(
      describeClient({
        userAgent: LINUX_CHROME,
        userAgentData: { brands: [{ brand: "Chromium" }] },
      }),
    ).toBe("Chromium on Linux");
    expect(
      describeClient({
        userAgent: LINUX_CHROME,
        userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }] },
      }),
    ).toBe("Chrome on Linux");
    expect(
      describeClient({
        userAgent: LINUX_CHROME,
        userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Brave" }] },
      }),
    ).toBe("Brave on Linux");
  });

  test("takes a prefix and copes with unknown agents", () => {
    expect(describeClient({ userAgent: LINUX_CHROME }, "Userscript in ")).toBe(
      "Userscript in Chrome on Linux",
    );
    expect(describeClient({ userAgent: "curl/8" })).toBe("Browser");
  });
});
