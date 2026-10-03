import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { checkRelease, parseVersion } from "./release-check.mjs";

let root;

function project({ cargo = "0.3.0", chromium = "0.3.0", firefox = chromium, pkg = chromium } = {}) {
  mkdirSync(join(root, "desktop"), { recursive: true });
  mkdirSync(join(root, "browser", "manifests"), { recursive: true });
  writeFileSync(
    join(root, "desktop", "Cargo.toml"),
    `[package]\nname = "Parousia-Desktop"\nversion = "${cargo}"\nedition = "2024"\n\n[dependencies]\nserde = { version = "1.0.0" }\n`,
  );
  writeFileSync(join(root, "browser", "package.json"), JSON.stringify({ name: "x", version: pkg }));
  writeFileSync(
    join(root, "browser", "manifests", "chromium.json"),
    JSON.stringify({ manifest_version: 3, version: chromium }),
  );
  writeFileSync(
    join(root, "browser", "manifests", "firefox.json"),
    JSON.stringify({ manifest_version: 3, version: firefox }),
  );
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "release-check-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("parseVersion", () => {
  test("accepts a tag or a bare version, with or without a pre-release", () => {
    assert.deepEqual(parseVersion("v1.2.3"), { version: "1.2.3", core: "1.2.3", prerelease: false });
    assert.deepEqual(parseVersion("1.2.3-rc.1"), {
      version: "1.2.3-rc.1",
      core: "1.2.3",
      prerelease: true,
    });
  });

  test("rejects anything that is not MAJOR.MINOR.PATCH", () => {
    for (const bad of ["", "v1.2", "1.2.3.4", "v01.2.3", "latest", "1.2.3-", "1.2.3+build"]) {
      assert.equal(parseVersion(bad), null, bad);
    }
  });
});

describe("checkRelease", () => {
  test("passes when Desktop carries the tag's version and the extension agrees with itself", () => {
    project();
    assert.deepEqual(checkRelease("v0.3.0", root), []);
  });

  test("the extension has a version of its own: Desktop is the tag", () => {
    project({ cargo: "1.0.1", chromium: "1.1.0" });
    assert.deepEqual(checkRelease("v1.0.1", root), []);
  });

  test("a pre-release tag matches Desktop in full", () => {
    project({ cargo: "0.3.0-rc.1", chromium: "0.4.0" });
    assert.deepEqual(checkRelease("v0.3.0-rc.1", root), []);
  });

  test("Desktop must carry the tag's version", () => {
    project({ cargo: "1.0.0" });
    const problems = checkRelease("v1.0.1", root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /desktop\/Cargo\.toml.*1\.0\.0.*1\.0\.1/);
  });

  test("both manifests and package.json carry one extension version", () => {
    project({ chromium: "1.1.0", firefox: "1.0.0", pkg: "1.0.5" });
    const problems = checkRelease("v0.3.0", root).join("\n");
    assert.match(problems, /firefox\.json.*1\.0\.0.*1\.1\.0/);
    assert.match(problems, /package\.json.*1\.0\.5.*1\.1\.0/);
  });

  test("an extension version is numbers only, since the stores take nothing else", () => {
    project({ chromium: "1.1.0-beta.1" });
    assert.match(checkRelease("v0.3.0", root).join("\n"), /1\.1\.0-beta\.1/);
  });

  test("a version that is not semver is reported once", () => {
    project();
    assert.equal(checkRelease("nightly", root).length, 1);
  });

  test("a dependency's version line is not mistaken for the package's", () => {
    project({ cargo: "0.3.0" });
    assert.deepEqual(checkRelease("v0.3.0", root), []);
  });
});
