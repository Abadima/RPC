#!/usr/bin/env node
// Prints the CHANGELOG.md section for a release, as the body of its GitHub
// Release. A section starts at `## [V1.2.3](...)` (the style of simply-xp's
// changelog) and runs to the next `## `. A pre-release with no section of
// its own uses `## Unreleased`, when that has anything in it.
//
//   node scripts/changelog.mjs v1.2.3
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "./release-check.mjs";

/** The body of the `## ` section `matches` accepts the heading of, trimmed, or `null` if there's none. */
function section(changelog, matches) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("## ") && matches(line.slice(3)));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

/** The release notes for `input` (`v1.2.3` or `1.2.3-rc.1`), or a message saying what's missing. */
export function releaseNotes(input, changelog) {
  const parsed = parseVersion(input);
  if (!parsed) return { error: `"${input}" is not MAJOR.MINOR.PATCH, optionally followed by -pre.release` };
  const wanted = `v${parsed.version}`.toLowerCase();
  const own = section(changelog, (heading) => /^\[?(v[^\]\s]+)/i.exec(heading)?.[1]?.toLowerCase() === wanted);
  if (own !== null) return own ? { notes: own } : { error: `CHANGELOG.md's section for ${wanted} is empty` };
  if (parsed.prerelease) {
    const unreleased = section(changelog, (heading) => /^\[?unreleased\b/i.test(heading));
    if (unreleased) return { notes: unreleased };
  }
  return {
    error: parsed.prerelease
      ? `CHANGELOG.md has no "## [V${parsed.version}]" section and nothing under "## Unreleased"`
      : `CHANGELOG.md has no "## [V${parsed.version}]" section`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { notes, error } = releaseNotes(process.argv[2] ?? "", readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  if (error || !notes) {
    console.error(`changelog: ${error ?? "that section is empty"}`);
    process.exit(1);
  }
  console.log(notes);
}
