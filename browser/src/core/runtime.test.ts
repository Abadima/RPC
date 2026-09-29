import { describe, expect, test } from "bun:test";
import { ActivityRegistry } from "./registry";
import { PresenceRuntime } from "./runtime";

describe("PresenceRuntime", () => {
  test("resolves a registered activity for a matching url", () => {
    const registry = new ActivityRegistry();
    registry.register({
      info: { id: "example", name: "Example", hosts: ["example.com"] },
      matcher: (url) => url.hostname === "example.com",
      detect: (url) => ({ id: "example", name: "Example", url: url.href }),
    });

    const runtime = new PresenceRuntime(registry);
    const presence = runtime.resolve(new URL("https://example.com"));

    expect(presence.activity?.id).toBe("example");
  });

  test("returns a null activity when nothing matches", () => {
    const runtime = new PresenceRuntime(new ActivityRegistry());
    const presence = runtime.resolve(new URL("https://unmatched.example"));

    expect(presence.activity).toBeNull();
  });

  test("lists each registered Activity's catalog entry, in order", () => {
    const registry = new ActivityRegistry();
    for (const id of ["a", "b"]) {
      registry.register({
        info: { id, name: id.toUpperCase(), hosts: [`${id}.example`] },
        matcher: () => false,
        detect: () => null,
      });
    }
    expect(registry.list().map((info) => info.id)).toEqual(["a", "b"]);
  });
});
