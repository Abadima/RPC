import type { PageSpec } from "./messages";

/**
 * Reads the page's own variables, or calls one of its functions, for
 * `getPageVariable` and `execInPage`'s declarative form. The background runs
 * it with `scripting.executeScript({ world: "MAIN" })`: the browser
 * serializes it, so it must not use anything from outside its own body. No
 * code from the Activity runs in the page, only this function and the page's
 * own. Answers with JSON text of at most `max` characters, or `null`; the
 * page can tamper with anything this uses, so the answer is untrusted too.
 */
export async function readPage(spec: PageSpec, max: number): Promise<string | null> {
  // Functions that would run text as code: calling one would run the
  // Activity's code in the page after all. Taken before anything is called.
  const evaluators: unknown[] = [
    ...["eval", "Function", "setTimeout", "setInterval", "setImmediate", "execScript"].map((name) =>
      Reflect.get(globalThis, name),
    ),
    Reflect.get(Reflect.get(globalThis, "document") ?? {}, "write"),
    Reflect.get(Reflect.get(globalThis, "document") ?? {}, "writeln"),
  ].filter((fn) => typeof fn === "function");
  const at = (root: unknown, path: string): unknown => {
    let value = root;
    for (const key of path.split(".")) {
      if (value === null || value === undefined) return undefined;
      value = Reflect.get(Object(value), key);
    }
    return value;
  };
  const place = (target: object, path: string, value: unknown): void => {
    const keys = path.split(".");
    const last = keys.pop();
    if (last === undefined) return;
    let node = target;
    for (const key of keys) {
      const next: unknown = Reflect.get(node, key);
      if (typeof next === "object" && next !== null) {
        node = next;
      } else {
        const created = {};
        Reflect.set(node, key, created);
        node = created;
      }
    }
    Reflect.set(node, last, value);
  };

  try {
    let result: unknown;
    if (spec.kind === "variables") {
      const found: Record<string, unknown> = {};
      for (const path of spec.paths) found[path] = at(globalThis, path);
      result = found;
    } else if (spec.get !== undefined) {
      result = at(globalThis, spec.get);
    } else if (spec.call !== undefined) {
      const dot = spec.call.lastIndexOf(".");
      const owner = dot < 0 ? globalThis : at(globalThis, spec.call.slice(0, dot));
      const fn = at(owner, spec.call.slice(dot + 1));
      result =
        typeof fn === "function" && !evaluators.includes(fn)
          ? await Reflect.apply(fn, owner, spec.args ?? [])
          : undefined;
    }

    // Round-trip first, so pick and omit work on plain data.
    const text = JSON.stringify(result);
    if (typeof text !== "string" || text.length > max) return null;
    let value: unknown = JSON.parse(text);
    if (spec.kind === "exec" && spec.pick) {
      const picked: Record<string, unknown> = {};
      for (const path of spec.pick) place(picked, path, at(value, path));
      value = picked;
    }
    if (spec.kind === "exec" && spec.omit && typeof value === "object" && value !== null) {
      for (const path of spec.omit) {
        const dot = path.lastIndexOf(".");
        const parent = dot < 0 ? value : at(value, path.slice(0, dot));
        if (typeof parent === "object" && parent !== null) {
          Reflect.deleteProperty(parent, path.slice(dot + 1));
        }
      }
    }
    const answer = JSON.stringify(value);
    return typeof answer === "string" && answer.length <= max ? answer : null;
  } catch {
    return null;
  }
}
