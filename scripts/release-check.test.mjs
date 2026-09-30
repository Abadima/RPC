import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { checkRelease, parseVersion } from "./release-check.mjs";

let root;

function project({ cargo = "0.3.0", chromium = "0.3.0", firefox = "0.3.0" } = {}) {
  mkdirSync(join(root, "desktop"), { recursive: true });
  mkdirSync(join(root, "browser", "manifests"), { recursive: true });
  writeFileSync(
    join(root, "desktop", "Cargo.toml"),
    `[package]\nname = "Parousia-Desktop"\nversion = "${cargo}"\nedition = "2024"\n\n[dependencies]\nserde = { version = "1.0.0" }\n`,
  );
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
  test("passes when Desktop and both manifests carry the version", () => {
    project();
    assert.deepEqual(checkRelease("v0.3.0", root), []);
  });

  test("a pre-release tag matches Desktop in full and the manifests by number only", () => {
    project({ cargo: "0.3.0-rc.1" });
    assert.deepEqual(checkRelease("v0.3.0-rc.1", root), []);
  });

  test("names every file that disagrees with the tag", () => {
    project({ cargo: "1.0.0", chromium: "0.4.0", firefox: "0.2.0" });
    const problems = checkRelease("v0.3.0", root);
    assert.equal(problems.length, 3);
    assert.match(problems.join("\n"), /desktop\/Cargo\.toml.*1\.0\.0/);
    assert.match(problems.join("\n"), /chromium\.json.*0\.4\.0/);
    assert.match(problems.join("\n"), /firefox\.json.*0\.2\.0/);
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
