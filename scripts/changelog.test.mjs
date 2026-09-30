import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { releaseNotes } from "./changelog.mjs";

const CHANGELOG = `# VERSION 1

## Unreleased

### ✅ Additions

- Something new.

## [V1.1.0](https://example.com/releases/tag/v1.1.0) - V1 MINOR

### ⭐ Improvements

- Faster.

## [V1.0.0](https://example.com/releases/tag/v1.0.0) - V1 FIRST RELEASE

### ✅ Additions

- The first one.

## [V1.0.1](https://example.com/releases/tag/v1.0.1) - EMPTY

## [BETA 1](https://example.com/releases/tag/v1.0.0-beta.1)
`;

describe("releaseNotes", () => {
  test("takes the section for the version, up to the next one", () => {
    assert.deepEqual(releaseNotes("v1.1.0", CHANGELOG), { notes: "### ⭐ Improvements\n\n- Faster." });
    assert.deepEqual(releaseNotes("1.0.0", CHANGELOG), { notes: "### ✅ Additions\n\n- The first one." });
  });

  test("a stable version needs its own section, with something in it", () => {
    assert.match(releaseNotes("v2.0.0", CHANGELOG).error, /no "## \[V2\.0\.0\]" section/);
    assert.match(releaseNotes("v1.0.1", CHANGELOG).error, /is empty/);
  });

  test("a pre-release falls back to Unreleased, a stable release never does", () => {
    assert.deepEqual(releaseNotes("v1.2.0-rc.1", CHANGELOG), {
      notes: "### ✅ Additions\n\n- Something new.",
    });
    assert.match(releaseNotes("v1.2.0", CHANGELOG).error, /no "## \[V1\.2\.0\]" section/);
    assert.match(releaseNotes("v1.2.0-rc.1", "# VERSION 1\n").error, /Unreleased/);
  });

  test("a version that isn't one is refused", () => {
    assert.match(releaseNotes("latest", CHANGELOG).error, /not MAJOR\.MINOR\.PATCH/);
  });

  test("the real changelog has a section for the version Desktop is at", () => {
    const cargo = readFileSync(new URL("../desktop/Cargo.toml", import.meta.url), "utf8");
    const version = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] ?? "";
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    assert.ok(releaseNotes(version, changelog).notes, `no notes for ${version}`);
  });
});
