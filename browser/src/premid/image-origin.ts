/**
 * Where an inline image came from. PreMiD hosts an Activity's inline image
 * (base64, a Blob, an element) on its image service; Parousia sends nothing to
 * any image host, so an inline image that's really a picture the page serves
 * (YouTube draws `i3.ytimg.com/vi/<id>/mqdefault.jpg` onto a canvas to pad it)
 * is sent as that `https` address, and any other is left out. Watched: an
 * `https` image drawn onto a canvas then exported (`toDataURL`, `toBlob`), and a
 * fetched image's Blob.
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

type Original = (self: unknown, args: unknown[]) => unknown;
type Method = (this: unknown, ...args: unknown[]) => unknown;

function httpsAddress(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= MAX_ADDRESS_CHARS &&
    /^https:\/\//i.test(value)
    ? value
    : undefined;
}

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

function prototypeOf(scope: object, name: string): unknown {
  const constructor: unknown = Reflect.get(scope, name);
  return typeof constructor === "function" ||
    (typeof constructor === "object" && constructor !== null)
    ? Reflect.get(constructor, "prototype")
    : undefined;
}

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
