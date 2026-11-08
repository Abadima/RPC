import type { ActivityManifest } from "../../src/activities/manifest";
import type { NativeFound } from "./native";

/**
 * A manifest as the background and userscript run it: without the words only
 * the views show (they read those from the packaged catalog and manifests),
 * since the background parses this module every time it starts. A setting's
 * choices stay: a stored choice is checked against how many there are.
 */
function runtimeManifest({ info, ...rest }: ActivityManifest): ActivityManifest {
  const { description: _description, version: _version, keywords: _keywords, ...kept } = info;
  const settings = kept.settings?.map(
    ({ description: _text, placeholder: _placeholder, ...setting }) => ({ ...setting, title: "" }),
  );
  return { ...rest, info: settings ? { ...kept, settings } : kept };
}

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
      .map(
        (entry, index) =>
          `{ manifest: ${JSON.stringify(runtimeManifest(entry.manifest))}, module: m${index} }`,
      )
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
