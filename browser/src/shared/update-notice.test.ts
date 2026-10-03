import { describe, expect, test } from "bun:test";
import { updateNotice } from "./update-notice";

describe("updateNotice", () => {
  test("says nothing unless connected with a side behind", () => {
    expect(updateNotice({ status: "connected", desktopVersion: "1.0.0" }, "1.0.0")).toBeNull();
    expect(updateNotice({ status: "disconnected" }, "1.0.0")).toBeNull();
    expect(updateNotice({ status: "incompatible" }, "1.0.0")).toBeNull();
  });

  test("an older Desktop is offered its download", () => {
    const notice = updateNotice(
      { status: "connected", desktopVersion: "1.0.0", update: "desktop" },
      "1.1.0",
    );
    expect(notice?.key).toBe("desktop:1.1.0:1.0.0");
    expect(notice?.href).toMatch(/^https:\/\/github\.com\//);
    expect(notice?.detail).toContain("1.0.0");
  });

  test("an older extension is told where it updates, with no download link", () => {
    const notice = updateNotice(
      { status: "connected", desktopVersion: "1.2.0", update: "extension" },
      "1.1.0",
    );
    expect(notice?.key).toBe("extension:1.1.0:1.2.0");
    expect(notice?.href).toBeUndefined();
  });

  test("a new release of either side is a new notice", () => {
    const at = (extension: string, desktopVersion: string) =>
      updateNotice({ status: "connected", desktopVersion, update: "desktop" }, extension)?.key;
    expect(new Set([at("1.1.0", "1.0.0"), at("1.2.0", "1.0.0"), at("1.2.0", "1.1.0")]).size).toBe(
      3,
    );
  });
});
