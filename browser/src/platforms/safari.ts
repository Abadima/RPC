import Logena from "logena";
import { ActivityRegistry } from "../core/registry";
import { PresenceRuntime } from "../core/runtime";

Logena.set({ appName: "PAROUSIA/safari" });

export const runtime = new PresenceRuntime(new ActivityRegistry());

Logena.info("safari platform initialized");
