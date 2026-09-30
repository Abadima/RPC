import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatNotices, linkedCrates } from "./rust-notices.mjs";

const pkg = (name, extra = {}) => ({
  id: name,
  name,
  version: "1.0.0",
  license: "ISC",
  repository: `https://example.com/${name}`,
  manifest_path: `/x/${name}/Cargo.toml`,
  targets: [{ kind: ["lib"] }],
  ...extra,
});
const dep = (pkgId, kind = null) => ({ pkg: pkgId, dep_kinds: [{ kind }] });

describe("linkedCrates", () => {
  const metadata = {
    packages: [
      pkg("root"),
      pkg("serde"),
      pkg("serde_derive", { targets: [{ kind: ["proc-macro"] }] }),
      pkg("unicode-ident"),
      pkg("cc"),
      pkg("testing"),
    ],
    resolve: {
      root: "root",
      nodes: [
        { id: "root", deps: [dep("serde"), dep("cc", "build"), dep("testing", "dev")] },
        { id: "serde", deps: [dep("serde_derive")] },
        { id: "serde_derive", deps: [dep("unicode-ident")] },
        { id: "unicode-ident", deps: [] },
        { id: "cc", deps: [] },
        { id: "testing", deps: [] },
      ],
    },
  };

  test("a binary links what it needs at run time, not proc macros, build scripts, or tests", () => {
    assert.deepEqual(
      linkedCrates(metadata).map((crate) => crate.name),
      ["serde"],
    );
  });

  test("a crate a proc macro shares with the binary stays", () => {
    const shared = structuredClone(metadata);
    shared.resolve.nodes[0].deps.push(dep("unicode-ident"));
    assert.deepEqual(linkedCrates(shared).map((crate) => crate.name).sort(), [
      "serde",
      "unicode-ident",
    ]);
  });
});

describe("formatNotices", () => {
  const apache = `Apache License\n${"terms ".repeat(400)}`;
  const texts = {
    a: [{ name: "LICENSE-ONE", text: "Copyright (c) A" }, { name: "LICENSE-APACHE", text: apache }],
    b: [{ name: "LICENSE-ONE", text: "Copyright (c) B" }, { name: "LICENSE-APACHE", text: apache }],
  };
  const out = formatNotices([pkg("b"), pkg("a"), pkg("a")], (crate) => texts[crate.name]);

  test("lists each crate once, in order, with its license and where it came from", () => {
    assert.ok(out.indexOf("a 1.0.0") < out.indexOf("b 1.0.0"));
    assert.equal(out.split("a 1.0.0\n").length, 2);
    assert.match(out, /License: ISC\nSource: https:\/\/example.com\/a\n/);
    assert.match(out, /Registry: https:\/\/crates.io\/crates\/a\/1.0.0/);
  });

  test("keeps every copyright line, and says a repeated long text once", () => {
    assert.match(out, /Copyright \(c\) A/);
    assert.match(out, /Copyright \(c\) B/);
    assert.equal(out.split("Apache License\n").length, 2);
    assert.match(out, /LICENSE-APACHE: the same text as a 1.0.0's LICENSE-APACHE/);
  });
});
