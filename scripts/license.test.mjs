import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// The project is Apache-2.0 everywhere. What it bundles keeps its own license,
// listed in browser/THIRD-PARTY-NOTICES.txt.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

/** Files that legitimately mention another license by name. */
const OTHER_LICENSES = [
  /^CHANGELOG\.md$/, // records the change from MIT
  /^scripts\/license\.test\.mjs$/,
  /(^|\/)(bun\.lock|Cargo\.lock)$/,
  /^browser\/scripts\/activities\/fixtures\/premid\/LICENSE$/,
  /^browser\/src\/popup\/fonts\/OFL\.txt$/,
  /\.(webp|png|rgba|woff2|zip)$/,
];

describe("Apache License 2.0, project-wide", () => {
  test("LICENSE is Apache 2.0 with the copyright filled in", () => {
    const license = read("LICENSE");
    assert.match(license, /^\s*Apache License\s+Version 2\.0, January 2004/);
    assert.match(license, /^Copyright 20\d\d \S.*$/m);
    assert.doesNotMatch(license, /\[yyyy\]|\[name of copyright owner\]|Copyright \[/);
  });

  test("every package says so", () => {
    assert.match(read("desktop/Cargo.toml"), /^license = "Apache-2\.0"$/m);
    assert.equal(JSON.parse(read("browser/package.json")).license, "Apache-2.0");
    assert.match(read("browser/scripts/userscript-header.ts"), /@license\s+Apache-2\.0/);
  });

  test("the extension's About page names it", () => {
    const about = read("browser/src/shared/settings-view.ts");
    assert.match(about, /fact\(t\("License"\), "Apache License 2\.0"\)/);
  });

  test("the README and CONTRIBUTING name it", () => {
    assert.match(read("README.md"), /Apache License 2\.0/);
    assert.match(read(".github/CONTRIBUTING.md"), /Apache License 2\.0/);
  });

  test("no file still calls the project MIT", () => {
    const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter((file) => file && !OTHER_LICENSES.some((pattern) => pattern.test(file)));
    const stale = files.filter((file) => {
      try {
        return /\bMIT\b/.test(read(file));
      } catch {
        return false;
      }
    });
    assert.deepEqual(stale, []);
  });
});
