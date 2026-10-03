import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** What `src/shared/icons.ts` reads of a Font Awesome icon: its size and path data. */
export interface IconShape {
  icon: [width: number, height: number, ligatures: [], unicode: "", path: string | string[]];
}

function isIconShape(
  value: unknown,
): value is { icon: [number, number, unknown, unknown, string | string[]] } {
  if (typeof value !== "object" || value === null || !("icon" in value)) return false;
  const { icon } = value;
  return (
    Array.isArray(icon) &&
    typeof icon[0] === "number" &&
    typeof icon[1] === "number" &&
    (typeof icon[4] === "string" ||
      (Array.isArray(icon[4]) && icon[4].every((path) => typeof path === "string")))
  );
}

/**
 * One icon module (`@fortawesome/free-solid-svg-icons/faGear`) as a tiny ES
 * module holding only what's drawn. Each of Font Awesome's is CommonJS with a
 * dozen exports (name, aliases, unicode, prefix...), which the bundler keeps
 * whole: a few hundred bytes per icon, in every page that shows one.
 */
export function iconModule(specifier: string): string {
  const name = specifier.slice(specifier.lastIndexOf("/") + 1);
  if (!/^fa[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`${specifier} isn't one icon`);
  const exported: unknown = require(specifier)[name];
  if (!isIconShape(exported)) throw new Error(`${specifier} has no icon data`);
  const [width, height, , , path] = exported.icon;
  const shape: IconShape = { icon: [width, height, [], "", path] };
  return `export const ${name} = ${JSON.stringify(shape)};`;
}

/** Resolves every single-icon import to `iconModule`'s version of it. */
export const iconsPlugin: Bun.BunPlugin = {
  name: "font-awesome-icons",
  setup(build) {
    build.onResolve(
      { filter: /^@fortawesome\/free-solid-svg-icons\/fa[A-Za-z0-9]+$/ },
      ({ path }) => ({
        path,
        namespace: "fa-icon",
      }),
    );
    build.onLoad({ filter: /.*/, namespace: "fa-icon" }, ({ path }) => ({
      contents: iconModule(path),
      loader: "js",
    }));
  },
};
