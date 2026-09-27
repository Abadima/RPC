import { describe, expect, test } from "bun:test";
import { ActivityRegistry } from "./registry";
import { PresenceRuntime } from "./runtime";

describe("PresenceRuntime", () => {
  test("resolves a registered activity for a matching url", () => {
    const registry = new ActivityRegistry();
    registry.register({
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
});
