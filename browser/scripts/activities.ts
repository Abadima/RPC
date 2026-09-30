import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildActivities } from "./activities/build";
import type { NativeFound } from "./activities/native";
import { BROWSER_DIR, CACHE_DIR, fetchSources } from "./activities/sources";

/**
 * `bun run activities:fetch`: moves every Activity source's checkout to the
 * newest commit on its `main` branch (activity-sources.json). A source that
 * can't be reached keeps the checkout it has, and only one that was never
 * fetched makes this fail.
 *
 * `bun run activities:check`: finds, checks, and compiles every Activity the
 * way the build does, lists every PreMiD Activity left out and why, and
 * type-checks each native Activity against this extension's own copy of the
 * Activity API (src/core/api.ts), so parousia-project/activities can't drift
 * from it unnoticed.
 */

/** Type-checks native Activities with `"parousia"` pointing at src/core/api.ts. */
async function typecheck(native: readonly NativeFound[]): Promise<boolean> {
  const dir = join(CACHE_DIR, "check");
  await mkdir(dir, { recursive: true });
  const config = join(dir, "tsconfig.json");
  await Bun.write(
    config,
    JSON.stringify({
      compilerOptions: {
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        verbatimModuleSyntax: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noUncheckedIndexedAccess: true,
        types: [],
        paths: { parousia: [join(BROWSER_DIR, "src", "core", "api.ts")] },
      },
      files: native.map((entry) => entry.modulePath),
    }),
  );
  const child = Bun.spawn([join(BROWSER_DIR, "node_modules", ".bin", "tsc"), "-p", config], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await child.exited) === 0;
}

const [command] = process.argv.slice(2);

if (command === "fetch") {
  await fetchSources((line) => console.log(`[activities] ${line}`));
} else if (command === "check") {
  const build = await buildActivities();
  for (const line of build.summary) console.log(`[activities] ${line}`);
  for (const { service, reason } of build.excluded) {
    console.log(`[activities]   left out: ${service}: ${reason}`);
  }
  if (build.native.length > 0 && !(await typecheck(build.native))) {
    console.error("[activities] native Activities don't type-check against src/core/api.ts");
    process.exit(1);
  }
  console.log("[activities] ok");
} else {
  console.error("usage: bun run scripts/activities.ts fetch | check");
  process.exit(2);
}
