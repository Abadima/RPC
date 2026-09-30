import { describe, expect, test } from "bun:test";
import { ActivityRegistry } from "./registry";
import { PresenceRuntime } from "./runtime";

describe("PresenceRuntime", () => {
  test("resolves a registered activity for a matching url", () => {
    const registry = new ActivityRegistry();
    registry.register({
      info: { id: "example", name: "Example", hosts: ["example.com"], source: "parousia" },
      matcher: (url) => url.hostname === "example.com",
      detect: ({ url }) => ({ id: "example", name: "Example", url: url.href }),
    });

    const runtime = new PresenceRuntime(registry);
    const presence = runtime.resolve({ url: new URL("https://example.com"), title: "" });

    expect(presence.activity?.id).toBe("example");
  });

  test("hands detection the title, and stamps the catalog's Discord Application", () => {
    const registry = new ActivityRegistry();
    registry.register({
      info: {
        id: "titled",
        name: "Titled",
        hosts: ["example.com"],
        source: "parousia",
        discordClientId: "1553980756731363428",
      },
      matcher: (url) => url.hostname === "example.com",
      detect: ({ url, title }) => ({ id: "titled", name: title, url: url.href }),
    });
    const runtime = new PresenceRuntime(registry);
    const presence = runtime.resolve({ url: new URL("https://example.com"), title: "Chess" });

    expect(presence.activity).toEqual({
      id: "titled",
      name: "Chess",
      url: "https://example.com/",
      discordClientId: "1553980756731363428",
    });
    expect(runtime.matches(new URL("https://example.com/x"))).toBe(true);
    expect(runtime.matches(new URL("https://other.example"))).toBe(false);
  });

  test("returns a null activity when nothing matches", () => {
    const runtime = new PresenceRuntime(new ActivityRegistry());
    const presence = runtime.resolve({ url: new URL("https://unmatched.example"), title: "" });

    expect(presence.activity).toBeNull();
  });

  test("skips Activities that are off, and hands detection its settings", () => {
    const registry = new ActivityRegistry();
    registry.register({
      info: {
        id: "first",
        name: "First",
        hosts: ["example.com"],
        source: "parousia",
      },
      matcher: () => true,
      detect: ({ url }) => ({ id: "first", name: "First", url: url.href }),
    });
    registry.register({
      info: {
        id: "second",
        name: "Second",
        hosts: ["example.com"],
        source: "parousia",
        settings: [{ id: "label", title: "Label", type: "text", default: "Default" }],
      },
      matcher: () => true,
      detect: ({ url }, settings) => ({
        id: "second",
        name: String(settings.label),
        url: url.href,
      }),
    });
    const page = { url: new URL("https://example.com"), title: "" };

    expect(new PresenceRuntime(registry).resolve(page).activity?.id).toBe("first");
    const second = new PresenceRuntime(registry, { usable: (info) => info.id !== "first" });
    expect(second.resolve(page).activity?.name).toBe("Default");
    const set = new PresenceRuntime(registry, {
      usable: (info) => info.id !== "first",
      settings: () => ({ label: "Chosen" }),
    });
    expect(set.resolve(page).activity?.name).toBe("Chosen");
    expect(new PresenceRuntime(registry, { usable: () => false }).matches(page.url)).toBe(false);
    // Usable is decided per page: an Activity without access to one site still runs on another.
    const perSite = new PresenceRuntime(registry, {
      usable: (info, url) => info.id !== "first" || url.hostname === "granted.example",
    });
    expect(
      perSite.resolve({ url: new URL("https://granted.example"), title: "" }).activity?.id,
    ).toBe("first");
    expect(perSite.resolve(page).activity?.id).toBe("second");
  });

  test("only a PreMiD Activity's own report picks its Discord Application", () => {
    const registry = new ActivityRegistry();
    for (const source of ["parousia", "premid"] as const) {
      registry.register({
        info: {
          id: source,
          name: source,
          hosts: [`${source}.example`],
          source,
          discordClientId: "1111111111111111111",
        },
        matcher: (url) => url.hostname === `${source}.example`,
        detect: ({ url }) => ({
          id: source,
          name: source,
          url: url.href,
          discordClientId: "2222222222222222222",
        }),
      });
    }
    const runtime = new PresenceRuntime(registry);
    const clientId = (host: string): string | undefined =>
      runtime.resolve({ url: new URL(`https://${host}`), title: "" }).activity?.discordClientId;

    expect(clientId("parousia.example")).toBe("1111111111111111111");
    expect(clientId("premid.example")).toBe("2222222222222222222");
  });

  test("an Activity that throws shows nothing, and doesn't stop detection", () => {
    const registry = new ActivityRegistry();
    registry.register({
      info: { id: "broken", name: "Broken", hosts: ["example.com"], source: "parousia" },
      matcher: () => true,
      detect: () => {
        throw new Error("broken");
      },
    });
    const runtime = new PresenceRuntime(registry);
    expect(runtime.resolve({ url: new URL("https://example.com"), title: "" }).activity).toBeNull();
  });

  test("lists each registered Activity's catalog entry, in order", () => {
    const registry = new ActivityRegistry();
    for (const id of ["a", "b"]) {
      registry.register({
        info: { id, name: id.toUpperCase(), hosts: [`${id}.example`], source: "parousia" },
        matcher: () => false,
        detect: () => null,
      });
    }
    expect(registry.list().map((info) => info.id)).toEqual(["a", "b"]);
  });
});
