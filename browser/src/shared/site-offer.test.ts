import { describe, expect, test } from "bun:test";
import { siteOffer } from "./site-offer";

describe("siteOffer", () => {
  test("nothing for a site with no Activity, whatever is shared", () => {
    for (const sharing of ["nothing", "default", "activity"] as const) {
      expect(siteOffer(sharing, null)).toBe("none");
    }
  });

  test("nothing while the site's own Activity is what's shared", () => {
    for (const status of ["off", "on", "needs-access"] as const) {
      expect(siteOffer("activity", status)).toBe("none");
    }
  });

  test("a note when nothing is shared and the site's Activity is on", () => {
    expect(siteOffer("nothing", "on")).toBe("note");
  });

  test("an offer when nothing is shared and the site's Activity is off or can't run", () => {
    expect(siteOffer("nothing", "off")).toBe("offer");
    expect(siteOffer("nothing", "needs-access")).toBe("offer");
  });

  test("an offer while the Default Activity is shared, so the site's Activity is still one click away", () => {
    expect(siteOffer("default", "off")).toBe("offer");
    expect(siteOffer("default", "needs-access")).toBe("offer");
  });

  test("an offer while the Default Activity is shared and the site's Activity is on but has nothing to share", () => {
    expect(siteOffer("default", "on")).toBe("offer");
  });
});
