import Logena from "logena";
import { ActivityRegistry } from "../core/registry";
import { PresenceRuntime } from "../core/runtime";

Logena.set({ appName: "PAROUSIA/chromium" });

export const runtime = new PresenceRuntime(new ActivityRegistry());

Logena.info("chromium platform initialized");
