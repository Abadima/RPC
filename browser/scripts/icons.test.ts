import { describe, expect, test } from "bun:test";
import { faGear } from "@fortawesome/free-solid-svg-icons/faGear";
import { iconModule } from "./icons";

describe("iconModule", () => {
  test("keeps the size and path data an icon is drawn from, and nothing else", async () => {
    const source = iconModule("@fortawesome/free-solid-svg-icons/faGear");
    const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    const built: unknown = (await import(url)).faGear;
    expect(built).toEqual({ icon: [faGear.icon[0], faGear.icon[1], [], "", faGear.icon[4]] });
    expect(source).not.toContain("unicode");
    expect(source.length).toBeLessThan(faGear.icon[4].length + 80);
  });

  test("takes only single-icon modules", () => {
    expect(() => iconModule("@fortawesome/free-solid-svg-icons")).toThrow();
    expect(() => iconModule("@fortawesome/free-solid-svg-icons/index")).toThrow();
  });
});
