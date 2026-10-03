#!/usr/bin/env node
// Checks that a release agrees with the files that carry a version, so a tag
// never publishes artifacts that report another one. The tag is the release,
// and the release is the extension's version: both manifests and
// browser/package.json carry its numbers (`1.2.3`; a pre-release suffix such
// as `1.2.3-rc.1` lives in the tag alone, because the stores take nothing
// else). Firefox's manifest may add a fourth number (1.2.3.1), since Mozilla
// takes each version once and a fix has to go out as a new one. Parousia Desktop versions on its own
// (desktop/Cargo.toml), so it only has to be a release number; the workflows
// read it from there.
//
//   node scripts/release-check.mjs v1.2.3
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;
const MANIFESTS = ["chromium", "firefox"];

/** `null` unless `input` is `MAJOR.MINOR.PATCH` with an optional `-pre.release`, with or without a leading `v`. */
export function parseVersion(input) {
  const match = SEMVER.exec(input);
  if (!match) return null;
  const core = `${match[1]}.${match[2]}.${match[3]}`;
  return { version: match[4] ? `${core}-${match[4]}` : core, core, prerelease: Boolean(match[4]) };
}

function packageVersion(cargoToml) {
  const section = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargoToml)?.[1] ?? "";
  return /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? null;
}

/** Whether `version` is `core` or a store revision of it (`core` and one more number, as 1.1.0.1 is of 1.1.0). */
function isRevisionOf(core, version) {
  return version === core || new RegExp(`^${core.replaceAll(".", "\\.")}\\.\\d{1,9}$`).test(version);
}

/** Everything that disagrees with `input`, as messages; empty means the release can go ahead. */
export function checkRelease(input, root) {
  const parsed = parseVersion(input);
  if (!parsed) return [`"${input}" is not MAJOR.MINOR.PATCH, optionally followed by -pre.release`];

  const problems = [];
  const cargo = packageVersion(readFileSync(join(root, "desktop", "Cargo.toml"), "utf8"));
  if (!cargo || !parseVersion(cargo)) {
    problems.push(`desktop/Cargo.toml has version ${cargo}, which isn't a release number`);
  }
  const files = [
    ...MANIFESTS.map((target) => join("browser", "manifests", `${target}.json`)),
    join("browser", "package.json"),
  ];
  for (const path of files) {
    const { version } = JSON.parse(readFileSync(join(root, path), "utf8"));
    const allowed = path.endsWith("firefox.json") ? isRevisionOf(parsed.core, version) : version === parsed.core;
    if (!allowed) {
      const needs = path.endsWith("firefox.json") ? `${parsed.core} or a revision of it (${parsed.core}.1)` : parsed.core;
      problems.push(`${path} has version ${version}, the release needs ${needs}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = process.argv[2] ?? "";
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkRelease(input, root);
  for (const problem of problems) console.error(`release-check: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`release-check: ${input} matches the extension's manifests and package.json`);
}
