/**
 * Where an inline image came from. PreMiD's Activity API lets an Activity
 * hand over an image as an address, a base64 string, a Blob, or an element,
 * and PreMiD hosts the ones that aren't addresses on its own image service
 * (`POST pd.premid.app/create/base64`), so what travels afterwards is a short
 * address. Parousia has no image host and sends nothing to anyone's, so it
 * goes the other way: an inline image that is really a picture the page
 * already serves (YouTube draws its thumbnail onto a canvas only to pad it
 * square, from `https://i3.ytimg.com/vi/<id>/mqdefault.jpg`) is sent as that
 * address, which Discord fetches itself. One that isn't, a screenshot of a
 * video or a picture made from scratch, has no address and is left out.
 *
 * This watches the three ways such an image is made in the world PreMiD's
 * code runs in: an `https` image drawn onto a canvas that's then exported
 * (`toDataURL`, `toBlob`), and a fetched image's Blob. A canvas that drew
 * anything but one `https` image has no origin.
 */
const MAX_TRACKED = 16;
const MAX_ADDRESS_CHARS = 2048;

/** Exported data URLs and the address of the one image behind each, newest last. */
const exported = new Map<string, string>();
const blobs = new WeakMap<object, string>();

interface Drawn {
  sources: Set<string>;
  other: boolean;
}
const canvases = new WeakMap<object, Drawn>();

/** A method as `patch` hands it over: call it on `self`. */
type Original = (self: unknown, args: unknown[]) => unknown;
type Method = (this: unknown, ...args: unknown[]) => unknown;

function httpsAddress(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= MAX_ADDRESS_CHARS &&
    /^https:\/\//i.test(value)
    ? value
    : undefined;
}

/** The address an inline image came from, if it's known: a data URL or a Blob this has seen made. */
export function originOf(value: unknown): string | undefined {
  if (typeof value === "string") return exported.get(value);
  if (typeof value === "object" && value !== null) return blobs.get(value);
  return undefined;
}

/** The address behind whatever `canvas` holds, if it's one `https` image. */
function addressOf(canvas: unknown): string | undefined {
  const drawn = typeof canvas === "object" && canvas !== null ? canvases.get(canvas) : undefined;
  if (!drawn || drawn.other || drawn.sources.size !== 1) return undefined;
  return drawn.sources.values().next().value;
}

/** The prototype of the class `scope` has under `name` (the browser's own, or a fake in a test). */
function prototypeOf(scope: object, name: string): unknown {
  const constructor: unknown = Reflect.get(scope, name);
  return typeof constructor === "function" ||
    (typeof constructor === "object" && constructor !== null)
    ? Reflect.get(constructor, "prototype")
    : undefined;
}

/** Starts watching (once per world). */
export function trackImageOrigins(scope: object): void {
  const remember = (map: "data" | "blob", key: string | object, address: string): void => {
    if (map === "blob" && typeof key === "object") {
      blobs.set(key, address);
      return;
    }
    if (typeof key !== "string") return;
    exported.delete(key);
    exported.set(key, address);
    if (exported.size > MAX_TRACKED) {
      const oldest = exported.keys().next().value;
      if (oldest !== undefined) exported.delete(oldest);
    }
  };

  const context = prototypeOf(scope, "CanvasRenderingContext2D");
  patch(
    context,
    "drawImage",
    (original) =>
      function (this: unknown, ...args: unknown[]): unknown {
        const canvas: unknown =
          typeof this === "object" && this !== null ? Reflect.get(this, "canvas") : undefined;
        if (typeof canvas === "object" && canvas !== null) {
          const drawn = canvases.get(canvas) ?? { sources: new Set<string>(), other: false };
          const image = args[0];
          const address =
            typeof image === "object" && image !== null
              ? httpsAddress(Reflect.get(image, "currentSrc") || Reflect.get(image, "src"))
              : undefined;
          if (address) drawn.sources.add(address);
          else drawn.other = true;
          canvases.set(canvas, drawn);
        }
        return original(this, args);
      },
  );

  const canvas = prototypeOf(scope, "HTMLCanvasElement");
  patch(
    canvas,
    "toDataURL",
    (original) =>
      function (this: unknown, ...args: unknown[]): unknown {
        const result = original(this, args);
        const address = addressOf(this);
        if (address && typeof result === "string") remember("data", result, address);
        return result;
      },
  );
  patch(
    canvas,
    "toBlob",
    (original) =>
      function (this: unknown, ...args: unknown[]): unknown {
        const [callback, ...rest] = args;
        const address = addressOf(this);
        if (typeof callback !== "function" || !address) return original(this, args);
        const wrapped = (blob: unknown): unknown => {
          if (typeof blob === "object" && blob !== null) remember("blob", blob, address);
          return Reflect.apply(callback, undefined, [blob]);
        };
        return original(this, [wrapped, ...rest]);
      },
  );

  patch(
    prototypeOf(scope, "Response"),
    "blob",
    (original) =>
      function (this: unknown, ...args: unknown[]): unknown {
        const url =
          typeof this === "object" && this !== null
            ? httpsAddress(Reflect.get(this, "url"))
            : undefined;
        const result = original(this, args);
        if (!url || !(result instanceof Promise)) return result;
        return result.then((blob: unknown) => {
          const type = typeof blob === "object" && blob !== null ? Reflect.get(blob, "type") : "";
          if (
            typeof type === "string" &&
            type.startsWith("image/") &&
            typeof blob === "object" &&
            blob !== null
          ) {
            remember("blob", blob, url);
          }
          return blob;
        });
      },
  );
}

/** Replaces `prototype[name]` with `wrap(original)`, keeping `this` for the original. */
function patch(prototype: unknown, name: string, wrap: (original: Original) => Method): void {
  if (typeof prototype !== "object" || prototype === null) return;
  const original: unknown = Reflect.get(prototype, name);
  if (typeof original !== "function") return;
  try {
    Object.defineProperty(prototype, name, {
      value: wrap((self, args) => Reflect.apply(original, self, args)),
      configurable: true,
      writable: true,
    });
  } catch {
    // A prototype that can't be changed just means no origin for what it makes.
  }
}
