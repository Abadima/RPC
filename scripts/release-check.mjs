#!/usr/bin/env node
// Checks that a release version agrees with the files that carry one, so a tag
// never publishes artifacts that report another version. Extension manifests
// take numbers only (`1.2.3`); a pre-release suffix (`1.2.3-rc.1`) lives in
// Desktop's Cargo.toml and the tag.
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

/** Everything that disagrees with `input`, as messages; empty means the release can go ahead. */
export function checkRelease(input, root) {
  const parsed = parseVersion(input);
  if (!parsed) return [`"${input}" is not MAJOR.MINOR.PATCH, optionally followed by -pre.release`];

  const problems = [];
  const cargo = packageVersion(readFileSync(join(root, "desktop", "Cargo.toml"), "utf8"));
  if (cargo !== parsed.version) {
    problems.push(`desktop/Cargo.toml has version ${cargo}, the release is ${parsed.version}`);
  }
  for (const target of MANIFESTS) {
    const path = join("browser", "manifests", `${target}.json`);
    const { version } = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (version !== parsed.core) {
      problems.push(`${path} has version ${version}, the release needs ${parsed.core}`);
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
  console.log(`release-check: ${input} matches Desktop and the extension manifests`);
}
