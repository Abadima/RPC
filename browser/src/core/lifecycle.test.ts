import { describe, expect, test } from "bun:test";
import { PresenceController } from "./lifecycle";
import type { Presence } from "./presence";
import { ActivityRegistry } from "./registry";
import { PresenceRuntime } from "./runtime";
import type { PresenceTransport } from "./transport";

function recordingTransport(): { transport: PresenceTransport; sent: Presence[] } {
  const sent: Presence[] = [];
  return { transport: { send: (presence) => sent.push(presence) }, sent };
}

function exampleRegistry(): ActivityRegistry {
  const registry = new ActivityRegistry();
  registry.register({
    info: { id: "example", name: "Example", hosts: ["example.com"] },
    matcher: (url) => url.hostname === "example.com",
    detect: (url) => ({ id: "example", name: "Example", url: url.href }),
  });
  return registry;
}

describe("PresenceController", () => {
  test("publishes a resolved activity", () => {
    const { transport, sent } = recordingTransport();
    const controller = new PresenceController(new PresenceRuntime(exampleRegistry()), transport);

    controller.update(new URL("https://example.com/a"));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.activity?.id).toBe("example");
  });

  test("skips a repeated update that resolves to the same activity", () => {
    const { transport, sent } = recordingTransport();
    const controller = new PresenceController(new PresenceRuntime(exampleRegistry()), transport);

    controller.update(new URL("https://example.com/a"));
    controller.update(new URL("https://example.com/a"));

    expect(sent).toHaveLength(1);
  });

  test("publishes again when the resolved activity changes", () => {
    const { transport, sent } = recordingTransport();
    const controller = new PresenceController(new PresenceRuntime(exampleRegistry()), transport);

    controller.update(new URL("https://example.com/a"));
    controller.update(new URL("https://unmatched.example"));

    expect(sent).toHaveLength(2);
    expect(sent[1]?.activity).toBeNull();
  });

  test("publishes only what the share filter lets through, and again when it changes", () => {
    const { transport, sent } = recordingTransport();
    const controller = new PresenceController(new PresenceRuntime(exampleRegistry()), transport);
    const url = new URL("https://example.com/a");

    controller.update(url, (activity) => activity && { ...activity, name: "Hidden" });
    controller.update(url, (activity) => activity && { ...activity, name: "Hidden" });
    controller.update(url, () => null);

    expect(sent.map((presence) => presence.activity?.name ?? null)).toEqual(["Hidden", null]);
  });

  test("clear() publishes a null activity", () => {
    const { transport, sent } = recordingTransport();
    const controller = new PresenceController(new PresenceRuntime(exampleRegistry()), transport);

    controller.update(new URL("https://example.com/a"));
    controller.clear();

    expect(sent).toHaveLength(2);
    expect(sent[1]?.activity).toBeNull();
  });

  test("clear() is a no-op once already cleared", () => {
    const { transport, sent } = recordingTransport();
    const controller = new PresenceController(new PresenceRuntime(exampleRegistry()), transport);

    controller.update(new URL("https://unmatched.example"));
    controller.clear();

    expect(sent).toHaveLength(1);
  });
});
