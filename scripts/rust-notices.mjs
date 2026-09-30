#!/usr/bin/env node
// Writes the notices Parousia Desktop's binaries owe the crates compiled into
// them: each crate's name, version, license, source, and license text. Run
// from the repository root after `cargo fetch --locked` in desktop/:
//
//   node scripts/rust-notices.mjs > THIRD-PARTY-NOTICES.txt
//
// It reads `cargo metadata` for every release target, so a crate that only one
// platform links (windows-sys) is listed too. Build-time crates (proc macros
// and what they use) never reach a binary and are left out.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = [
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
];
const LICENSE_FILE = /^(license|licence|copying|unlicense|notice)/i;

/** The crates a binary links: what the root needs at run time, through normal dependencies only. */
export function linkedCrates(metadata) {
  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const seen = new Set();
  const stack = [metadata.resolve.root];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) stack.push(dep.pkg);
    }
  }
  seen.delete(metadata.resolve.root);
  // A proc-macro crate and everything only it uses runs in the compiler, not in the binary.
  const macros = new Set(
    [...seen].filter((id) => byId.get(id)?.targets.some((t) => t.kind.includes("proc-macro"))),
  );
  const linked = new Set(seen);
  for (const id of macros) linked.delete(id);
  const needed = new Set();
  const again = [metadata.resolve.root];
  while (again.length > 0) {
    const id = again.pop();
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (!dep.dep_kinds.some((kind) => kind.kind === null)) continue;
      if (!linked.has(dep.pkg) || needed.has(dep.pkg)) continue;
      needed.add(dep.pkg);
      again.push(dep.pkg);
    }
  }
  return [...needed].map((id) => byId.get(id)).filter(Boolean);
}

/** The text of every license file a crate ships, in a stable order. */
function licenseTexts(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").trim() }));
}

/** The notices file for `crates` (`cargo metadata` packages, merged across targets). */
export function formatNotices(crates, read = (pkg) => licenseTexts(dirname(pkg.manifest_path))) {
  const unique = new Map(crates.map((pkg) => [`${pkg.name} ${pkg.version}`, pkg]));
  const lines = [
    "Parousia Desktop is licensed under the Apache License 2.0 (LICENSE).",
    "Its binaries also contain the following crates, each under its own license.",
    "Where a crate offers a choice of licenses, it is used under the one listed first",
    "that this project may use; every text it ships is included below.",
    "",
  ];
  // The Apache text is the same in nearly every crate: said once, then pointed to.
  const printed = new Map();
  for (const [label, pkg] of [...unique].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("=".repeat(72), `${label}`, `License: ${pkg.license ?? "see the texts below"}`);
    if (pkg.repository) lines.push(`Source: ${pkg.repository}`);
    lines.push(`Registry: https://crates.io/crates/${pkg.name}/${pkg.version}`, "");
    for (const { name, text } of read(pkg)) {
      const earlier = text.length > 2000 ? printed.get(text) : undefined;
      if (earlier) {
        lines.push(`--- ${name}: the same text as ${earlier} ---`, "");
        continue;
      }
      printed.set(text, `${label}'s ${name}`);
      lines.push(`--- ${name} ---`, text, "");
    }
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "desktop");
  const crates = TARGETS.flatMap((target) =>
    linkedCrates(
      JSON.parse(
        execFileSync(
          "cargo",
          ["metadata", "--format-version", "1", "--locked", "--filter-platform", target],
          { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 },
        ),
      ),
    ),
  );
  process.stdout.write(formatNotices(crates));
}
