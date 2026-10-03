// The real MAL-Sync and Discord-RPC-Extension, for the checks that run
// Parousia beside them (`malsync:real`): their store builds, fetched once
// into a cache (`bun run real-extensions:fetch`, which needs the network;
// the checks themselves run in a private network namespace with none), and
// Discord-RPC-Extension's own app (`server.js` and its two dependencies)
// from its repository at a pinned commit.
//
// Chrome builds come from the Chrome Web Store as CRX files and are unpacked
// with the key their header was signed with added to the manifest, so each
// keeps its real extension id: MAL-Sync addresses Discord-RPC-Extension by
// it. Firefox builds are the signed add-ons from addons.mozilla.org, which
// carry their own ids.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { browserDir } from "./lib.mjs";

const run = promisify(execFile);

export const cacheDir =
  process.env.PAROUSIA_E2E_CACHE ?? join(browserDir, ".cache", "real-extensions");

export const CHROME_IDS = {
  malsync: "kekjfbackdeiabghhcdklcdoekaanoel",
  dre: "agnaejlkbiiggajjmnpmeheigkflbnoo",
};
export const FIREFOX_IDS = {
  malsync: "{c84d89d9-a826-4015-957b-affebd9eb603}",
  dre: "{57081fef-67b4-482f-bcb0-69296e63ec4f}",
};
const AMO_SLUGS = { malsync: "mal-sync", dre: "discord-rich-presence" };
const DRE_COMMIT = "3578a793209cdeba6c39d8a7e852ea02aa07bff2";

const paths = {
  chrome: (name) => join(cacheDir, `${name}-chrome`),
  firefox: (name) => join(cacheDir, `${name}.xpi`),
  app: join(cacheDir, "dre-app"),
  versions: join(cacheDir, "versions.json"),
};

/** Reads a protobuf message's fields: `[field number, bytes or number]`. */
function* fields(bytes) {
  let at = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
  };
  while (at < bytes.length) {
    const key = varint();
    if ((key & 7) === 0) yield [key >> 3, varint()];
    else if ((key & 7) === 2) {
      const length = varint();
      yield [key >> 3, bytes.subarray(at, at + length)];
      at += length;
    } else throw new Error(`unexpected protobuf wire type ${key & 7}`);
  }
}

/** A CRX3 file's zip body, the public key it was signed with, and the id that key gives. */
function readCrx(file) {
  if (file.subarray(0, 4).toString() !== "Cr24") throw new Error("not a CRX file");
  const headerLength = file.readUInt32LE(8);
  const header = file.subarray(12, 12 + headerLength);
  const keys = [];
  let crxId;
  for (const [field, value] of fields(header)) {
    if (field === 2 || field === 3) {
      for (const [inner, key] of fields(value)) if (inner === 1) keys.push(key);
    }
    if (field === 10000) {
      for (const [inner, id] of fields(value)) if (inner === 1) crxId = id;
    }
  }
  const key = keys.find((candidate) =>
    createHash("sha256").update(candidate).digest().subarray(0, 16).equals(crxId),
  );
  if (!key) throw new Error("no key in the CRX header matches its id");
  const id = [...crxId.toString("hex")]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
  return { body: file.subarray(12 + headerLength), key, id };
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Fetches everything into the cache (the network is needed), and records the versions. */
export async function fetchRealExtensions(log = console.log) {
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  const versions = {};
  for (const name of Object.keys(CHROME_IDS)) {
    const id = CHROME_IDS[name];
    const crx = await download(
      `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0&acceptformat=crx3&x=id%3D${id}%26installsource%3Dondemand%26uc`,
    );
    const { body, key, id: signed } = readCrx(crx);
    if (signed !== id) throw new Error(`${name}: the CRX is for ${signed}, not ${id}`);
    const zip = join(cacheDir, `${name}.zip`);
    await writeFile(zip, body);
    const directory = paths.chrome(name);
    await mkdir(directory);
    await run("unzip", ["-q", "-o", zip, "-d", directory]);
    await rm(zip);
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.key = key.toString("base64");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
    versions[`${name}-chrome`] = manifest.version;
    log(`${name} for Chrome ${manifest.version} (${id})`);

    const listing = await (
      await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${AMO_SLUGS[name]}/`)
    ).json();
    if (listing.guid !== FIREFOX_IDS[name]) {
      throw new Error(`${name}: the add-on's id is ${listing.guid}, not ${FIREFOX_IDS[name]}`);
    }
    await writeFile(paths.firefox(name), await download(listing.current_version.file.url));
    versions[`${name}-firefox`] = listing.current_version.version;
    log(`${name} for Firefox ${listing.current_version.version} (${listing.guid})`);
  }

  const tarball = join(cacheDir, "dre-app.tar.gz");
  await writeFile(
    tarball,
    await download(
      `https://github.com/lolamtisch/Discord-RPC-Extension/archive/${DRE_COMMIT}.tar.gz`,
    ),
  );
  await mkdir(paths.app);
  await run("tar", ["-xzf", tarball, "-C", paths.app, "--strip-components=1"]);
  await rm(tarball);
  // Only what `server.js` needs, as its own package.json names them (the tray servers' are not).
  await run(
    "npm",
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "ws@7",
      "@xhayper/discord-rpc@1.2.0",
    ],
    { cwd: paths.app },
  );
  versions["dre-app"] = DRE_COMMIT;
  log(`Discord-RPC-Extension's app at ${DRE_COMMIT.slice(0, 7)}`);
  await writeFile(paths.versions, JSON.stringify(versions, null, 2));
  return versions;
}

/** Where the cached builds are, and their versions; throws, saying how to fetch them, if they aren't there. */
export async function realExtensions() {
  try {
    const versions = JSON.parse(await readFile(paths.versions, "utf8"));
    return {
      versions,
      chrome: { malsync: paths.chrome("malsync"), dre: paths.chrome("dre") },
      firefox: { malsync: paths.firefox("malsync"), dre: paths.firefox("dre") },
      app: paths.app,
    };
  } catch {
    throw new Error(
      "the real extensions aren't cached: run `bun run real-extensions:fetch` (needs the network)",
    );
  }
}
