import type { NativeFound } from "./native";

/**
 * Bun.build plugin behind `import { native } from "parousia:activities"`
 * (declared in src/activities.d.ts): each native Activity's manifest with its
 * module. `"parousia"`, the Activity API Activities import types from, is
 * empty at runtime.
 */
export function activitiesPlugin(native: readonly NativeFound[]): Bun.BunPlugin {
  const source = [
    ...native.map((entry, index) => `import m${index} from ${JSON.stringify(entry.modulePath)};`),
    `export const native = [${native
      .map((entry, index) => `{ manifest: ${JSON.stringify(entry.manifest)}, module: m${index} }`)
      .join(", ")}];`,
  ].join("\n");
  return {
    name: "parousia-activities",
    setup(build) {
      build.onResolve({ filter: /^parousia(:activities)?$/ }, ({ path }) => ({
        path,
        namespace: "parousia",
      }));
      build.onLoad({ filter: /.*/, namespace: "parousia" }, ({ path }) => ({
        contents: path === "parousia:activities" ? source : "export {};",
        loader: "ts",
      }));
    },
  };
}
