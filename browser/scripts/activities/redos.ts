/**
 * The backtracking shapes a manifest's regular expression may not have,
 * found from the pattern text alone. A flagged pattern can spend seconds to
 * hours failing on a crafted URL, even under the matcher's 2,048-character
 * cap (`manifest.ts`'s `MAX_URL`), so the build leaves its Activity out:
 *
 * - a repeated group whose body can split the same text more than one way
 *   (`(a+)+`, `(a|a)+`, `(a+){3}`), lookaround bodies and named groups included;
 * - two runs in a row that can trade the same text (`a+a+`, `.*x.*`).
 *
 * A repeat whose every turn starts on a character the one before can't take
 * (`([a-z0-9-]+[.])*`, most of PreMiD's) is linear, and allowed. What this
 * can't read (a property escape, a literal brace) is flagged: it's a
 * conservative reading, not a regex analyzer, and review stays the defense.
 */

interface Atom {
  text: string;
  start: number;
  end: number;
  kind: "lit" | "class" | "group" | "dot" | "pipe";
  inner?: string;
  /** A `(?=…)`, `(?!…)`, `(?<=…)` or `(?<!…)` group: it consumes nothing. */
  la?: boolean;
}

interface Node {
  atom: Atom;
  quant: { raw: string; min: number; max: number } | null;
}

/** The index of the `]` closing the class at `start`, as JS reads it (`[]` is empty, `[^]` any character). */
function classEnd(text: string, start: number): number | null {
  let j = start + 1;
  while (j < text.length && text[j] !== "]") j += text[j] === "\\" ? 2 : 1;
  return j < text.length ? j : null;
}

function scanAtoms(text: string): Atom[] | null {
  const atoms: Atom[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "\\") {
      atoms.push({ text: text.slice(i, i + 2), start: i, end: i + 2, kind: "lit" });
      i += 2;
    } else if (c === "[") {
      const j = classEnd(text, i);
      if (j === null) return null;
      atoms.push({ text: text.slice(i, j + 1), start: i, end: j + 1, kind: "class" });
      i = j + 1;
    } else if (c === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "[") {
          const k = classEnd(text, j);
          if (k === null) return null;
          j = k + 1;
          continue;
        }
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
        j++;
      }
      if (depth !== 0) return null;
      const mark = /^\(\?(?::|<?[=!]|<[A-Za-z_$][\w$]*>)/.exec(text.slice(i));
      const la = mark !== null && /^\(\?<?[=!]/.test(mark[0]);
      const skip = mark !== null ? mark[0].length : text.slice(i).startsWith("(?") ? null : 1;
      if (skip === null) return null;
      atoms.push({
        text: text.slice(i, j),
        start: i,
        end: j,
        kind: "group",
        inner: text.slice(i + skip, j - 1),
        la,
      });
      i = j;
    } else if (c === "+" || c === "*" || c === "?") {
      if (atoms.length === 0) return null;
      i++; // a quantifier belongs to the atom before it
    } else if (c === "{") {
      if (atoms.length === 0) return null;
      const brace = /^\{(\d+)(,(\d*))?\}/.exec(text.slice(i));
      if (brace === null) return null; // a literal brace, or unsupported syntax
      i += brace[0].length;
    } else if (c === "|") {
      atoms.push({ text: "|", start: i, end: i + 1, kind: "pipe" });
      i++;
    } else {
      atoms.push({ text: c, start: i, end: i + 1, kind: c === "." ? "dot" : "lit" });
      i++;
    }
  }
  return atoms;
}

function parseQuantifier(text: string, at: number): Node["quant"] {
  const rest = text.slice(at);
  const brace = /^\{(\d+)(,(\d*))?\}/.exec(rest);
  if (brace !== null) {
    const min = Number(brace[1]);
    const max =
      brace[2] === undefined
        ? min
        : brace[3] === undefined || brace[3] === ""
          ? Infinity
          : Number(brace[3]);
    return { raw: brace[0], min, max };
  }
  const simple = /^(\?|\+|\*)\??/.exec(rest);
  if (simple === null) return null;
  const op = simple[1];
  return { raw: simple[0], min: op === "+" ? 1 : 0, max: op === "?" ? 1 : Infinity };
}

function parseTopLevel(text: string): Node[] | null {
  const atoms = scanAtoms(text);
  if (atoms === null) return null;
  return atoms.map((atom) => ({ atom, quant: parseQuantifier(text, atom.end) }));
}

function topBranches(text: string): string[] | null {
  const atoms = scanAtoms(text);
  if (atoms === null) return null;
  const branches = [];
  let start = 0;
  for (const a of atoms) {
    if (a.kind === "pipe") {
      branches.push(text.slice(start, a.start));
      start = a.end;
    }
  }
  branches.push(text.slice(start));
  return branches;
}

type Ranges = [number, number][];

const MAX_CHAR = 0x10ffff;
const DIGIT: Ranges = [[48, 57]];
const WORD: Ranges = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
];
const SPACE: Ranges = [
  [9, 13],
  [32, 32],
  [160, 160],
  [5760, 5760],
  [8192, 8202],
  [8232, 8233],
  [8239, 8239],
  [8287, 8287],
  [12288, 12288],
  [65279, 65279],
];

function complement(ranges: Ranges): Ranges {
  const out: Ranges = [];
  let next = 0;
  for (const [low, high] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (low > next) out.push([next, low - 1]);
    next = Math.max(next, high + 1);
  }
  if (next <= MAX_CHAR) out.push([next, MAX_CHAR]);
  return out;
}

/** What `\c` matches; null for what isn't a plain set (`\b`, `\p{…}`, a code, a backreference). */
function escapeRanges(c: string): Ranges | null {
  if (c === "d") return DIGIT;
  if (c === "D") return complement(DIGIT);
  if (c === "w") return WORD;
  if (c === "W") return complement(WORD);
  if (c === "s") return SPACE;
  if (c === "S") return complement(SPACE);
  return c === "" || /[A-Za-z0-9]/.test(c) ? null : [[c.charCodeAt(0), c.charCodeAt(0)]];
}

const single = (set: Ranges | null): number | null =>
  set !== null && set.length === 1 && set[0]?.[0] === set[0]?.[1] ? (set[0]?.[0] ?? null) : null;

/** The characters a class matches, read as JS reads it; null for what it can't read. */
function classRanges(text: string): Ranges | null {
  const negated = text.startsWith("[^");
  const body = text.slice(negated ? 2 : 1, -1);
  const out: Ranges = [];
  for (let i = 0; i < body.length; i++) {
    let set: Ranges | null;
    if (body[i] === "\\") {
      // Inside a class, `\b` is a backspace.
      set = body[i + 1] === "b" ? [[8, 8]] : escapeRanges(body[i + 1] ?? "");
      i++;
    } else set = [[body.charCodeAt(i), body.charCodeAt(i)]];
    if (set === null) return null;
    const low = single(set);
    if (low !== null && body[i + 1] === "-" && i + 2 < body.length) {
      const escaped = body[i + 2] === "\\";
      const high = escaped ? single(escapeRanges(body[i + 3] ?? "")) : body.charCodeAt(i + 2);
      if (high === null) return null;
      out.push([low, high]);
      i += escaped ? 3 : 2;
    } else out.push(...set);
  }
  return negated ? complement(out) : out;
}

/** Character ranges a simple token matches; null when that can't be read from the text. */
function rangesOf(text: string): Ranges | null {
  if (text === ".") return [[0, MAX_CHAR]];
  if (text.startsWith("[")) return classRanges(text);
  if (text.length === 2 && text[0] === "\\") return escapeRanges(text[1] ?? "");
  if (text.length === 1) return [[text.charCodeAt(0), text.charCodeAt(0)]];
  return null;
}

function overlaps(a: Ranges | null, b: Ranges | null): boolean {
  if (a === null || b === null) return true; // unknown: assume the worst
  return a.some((r1) => b.some((r2) => r1[0] <= r2[1] && r2[0] <= r1[1]));
}

function alternationRanges(text: string): Ranges | null {
  const branches = topBranches(text);
  if (branches === null) return null;
  const union: Ranges = [];
  for (const branch of branches) {
    if (branch.length === 0) return null;
    const nodes = parseTopLevel(branch);
    if (nodes === null) return null;
    for (const { atom, quant } of nodes) {
      if (quant !== null) return null;
      const range = rangeOf(atom);
      if (range === null) return null;
      union.push(...range);
    }
  }
  return union;
}

function rangeOf(atom: Atom): Ranges | null {
  if (atom.kind === "dot") return [[0, MAX_CHAR]];
  if (atom.kind === "group") return atom.inner === undefined ? null : alternationRanges(atom.inner);
  return rangesOf(atom.text);
}

function prefixAmbiguous(text: string): boolean {
  const branches = topBranches(text);
  if (branches === null || branches.length < 2) return false;
  for (let i = 0; i < branches.length; i++) {
    const a = branches[i];
    if (a === undefined || a.length === 0) continue;
    for (let j = 0; j < branches.length; j++) {
      const b = branches[j];
      if (i !== j && b !== undefined && b.startsWith(a)) return true;
    }
  }
  const seen = new Set<string>();
  for (const branch of branches) {
    if (seen.has(branch)) return true;
    seen.add(branch);
  }
  return false;
}

/** Whether one branch of a quantified group's body can split a match ambiguously across iterations. */
function branchHot(branchText: string): boolean {
  const nodes = parseTopLevel(branchText);
  if (nodes === null) return true;
  const first = nodes[0];
  if (first === undefined) return true; // an empty body can't be vouched for
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    if (node === undefined) continue;
    const { atom, quant } = node;
    if (quant === null || quant.max < 2) continue;
    let s = k + 1;
    let sep = nodes[s];
    while (sep !== undefined && s < nodes.length && (sep.atom.la ?? false)) {
      s++;
      sep = nodes[s];
    }
    if (sep === undefined || (sep.quant !== null && sep.quant.min === 0)) {
      if (k === 0) return true; // the atom is the iteration's first run: `(a+)+`
      const hotRange = rangeOf(atom);
      const anchored =
        hotRange !== null &&
        (first.quant === null || first.quant.min >= 1) &&
        !overlaps(rangeOf(first.atom), hotRange);
      if (!anchored) return true;
      continue;
    }
    if (sep.atom.la === true) return true;
    const selfRange = rangeOf(atom);
    if (selfRange === null) return true; // unknown content
    if (overlaps(selfRange, rangeOf(sep.atom))) return true;
  }
  for (const { atom } of nodes) {
    if (atom.kind !== "group" || (atom.la ?? false)) continue;
    if (prefixAmbiguous(atom.inner ?? "")) return true;
  }
  return false;
}

function bodyHot(body: string): boolean {
  const branches = topBranches(body);
  if (branches === null) return true;
  if (prefixAmbiguous(body)) return true;
  for (const branch of branches) {
    if (branchHot(branch)) return true;
  }
  return false;
}

/**
 * The range a node repeats over, when it's a run: an atom repeated at least
 * twice, or a group that amounts to one (`(a)+` is `a+`, `([ab])` holding
 * `[ab]+`). A group of several parts repeats them in turn; `bodyHot` judges it.
 */
function runOf(node: Node): { range: Ranges | null } | null {
  const { atom, quant } = node;
  if (atom.kind === "pipe" || atom.la === true) return null;
  const repeats = quant !== null && quant.max >= 2;
  if (atom.kind !== "group") return repeats ? { range: rangeOf(atom) } : null;
  const inner = parseTopLevel(atom.inner ?? "");
  const [only] = inner ?? [];
  if (inner?.length === 1 && only !== undefined) {
    if (repeats) return { range: rangeOf(only.atom) };
    return quant === null ? runOf(only) : null;
  }
  return repeats ? choiceOf(atom.inner ?? "") : null;
}

/** A body that's a choice of single characters (`a|b|[cd]`), as a run's range; null otherwise. */
function choiceOf(body: string): { range: Ranges | null } | null {
  const branches = topBranches(body);
  if (branches === null) return null;
  const range: Ranges = [];
  for (const branch of branches) {
    const nodes = parseTopLevel(branch);
    const [only] = nodes ?? [];
    if (nodes?.length !== 1 || only === undefined || only.quant !== null) return null;
    const own = rangeOf(only.atom);
    if (own === null) return { range: null };
    range.push(...own);
  }
  return { range };
}

const consumesNothing = (atom: Atom): boolean =>
  atom.la === true || ["^", "$", "\\b", "\\B"].includes(atom.text);

/**
 * Whether two runs in one sequence can trade the same text (`a+a+`,
 * `.*x.*`): nothing that must sit between them is out of the first one's
 * reach. A failing match then tries every split point: about a second for
 * two runs at the matcher's 2,048-character cap, minutes for three.
 */
function runsTrade(nodes: readonly Node[]): boolean {
  for (let i = 0; i < nodes.length; i++) {
    const first = nodes[i];
    const run = first && runOf(first);
    if (!run) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const next = nodes[j];
      if (next === undefined || next.atom.kind === "pipe") break;
      if (consumesNothing(next.atom)) continue;
      const later = runOf(next);
      if (later && overlaps(run.range, later.range)) return true;
      const optional = next.quant !== null && next.quant.min === 0;
      if (!optional && !overlaps(run.range, rangeOf(next.atom))) break;
    }
  }
  return false;
}

/**
 * True when a pattern can split the same text ambiguously across repeats:
 * the shapes a crafted URL could pin the matcher on. It is a conservative
 * reading, not a proof: what it can't read, it flags.
 */
export function isCatastrophic(pattern: string): boolean {
  return walk(pattern);
}

function walk(text: string): boolean {
  const nodes = parseTopLevel(text);
  if (nodes === null || runsTrade(nodes)) return true;
  for (const { atom, quant } of nodes) {
    if (atom.kind !== "group" || atom.inner === undefined) continue;
    // A lookaround's body is matched like any other part of the pattern.
    if (walk(atom.inner)) return true;
    if (atom.la !== true && quant !== null && quant.max >= 2 && bodyHot(atom.inner)) return true;
  }
  return false;
}
