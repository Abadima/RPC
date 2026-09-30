import { describe, expect, test } from "bun:test";
import { originOf, trackImageOrigins } from "./image-origin";

/** Stand-ins for the browser's canvas and response classes, patched the way the real ones are. */
function browser() {
  class Canvas {
    toDataURL(): string {
      return `data:image/png;base64,${"A".repeat(40)}${Math.random()}`;
    }
    toBlob(callback: (blob: Blob) => void): void {
      callback(new Blob(["png"], { type: "image/png" }));
    }
  }
  class Context {
    constructor(readonly canvas: Canvas) {}
    drawImage(_image: unknown): void {}
  }
  class FakeResponse {
    constructor(
      readonly url: string,
      private readonly type: string,
    ) {}
    blob(): Promise<Blob> {
      return Promise.resolve(new Blob(["x"], { type: this.type }));
    }
  }
  const scope = {
    HTMLCanvasElement: Canvas,
    CanvasRenderingContext2D: Context,
    Response: FakeResponse,
  };
  trackImageOrigins(scope);
  return { Canvas, Context, FakeResponse };
}

const image = (src: string) => ({ src, currentSrc: src });
const THUMBNAIL = "https://i3.ytimg.com/vi/abc123/mqdefault.jpg";

describe("where an inline image came from", () => {
  test("a canvas that drew one https image exports as that image's address, padding and all", () => {
    const { Canvas, Context } = browser();
    const canvas = new Canvas();
    const context = new Context(canvas);
    context.drawImage(image(THUMBNAIL));
    expect(originOf(canvas.toDataURL())).toBe(THUMBNAIL);
  });

  test("a Blob from toBlob has the same origin", () => {
    const { Canvas, Context } = browser();
    const canvas = new Canvas();
    new Context(canvas).drawImage(image(THUMBNAIL));
    let made: Blob | undefined;
    canvas.toBlob((blob) => (made = blob));
    expect(made && originOf(made)).toBe(THUMBNAIL);
  });

  test("a canvas that drew anything else has no origin: two pictures, a video frame, a drawn shape", () => {
    const { Canvas, Context } = browser();
    const two = new Canvas();
    new Context(two).drawImage(image(THUMBNAIL));
    new Context(two).drawImage(image("https://example.com/other.png"));
    expect(originOf(two.toDataURL())).toBeUndefined();

    const frame = new Canvas();
    new Context(frame).drawImage({ tagName: "VIDEO" });
    expect(originOf(frame.toDataURL())).toBeUndefined();

    const mixed = new Canvas();
    new Context(mixed).drawImage(image(THUMBNAIL));
    new Context(mixed).drawImage({ tagName: "CANVAS" });
    expect(originOf(mixed.toDataURL())).toBeUndefined();

    expect(originOf(new Canvas().toDataURL())).toBeUndefined();
  });

  test("only https addresses count, never http, data, or blob", () => {
    const { Canvas, Context } = browser();
    for (const src of [
      "http://example.com/a.png",
      "data:image/png;base64,AAAA",
      "blob:https://x/1",
    ]) {
      const canvas = new Canvas();
      new Context(canvas).drawImage(image(src));
      expect(originOf(canvas.toDataURL())).toBeUndefined();
    }
  });

  test("a fetched image's Blob has the address it was fetched from; other responses don't", async () => {
    const { FakeResponse } = browser();
    const picture = await new FakeResponse(
      "https://cdn.example.com/cover.jpg",
      "image/jpeg",
    ).blob();
    expect(originOf(picture)).toBe("https://cdn.example.com/cover.jpg");
    const page = await new FakeResponse("https://example.com/", "text/html").blob();
    expect(originOf(page)).toBeUndefined();
    const plain = await new FakeResponse("http://example.com/a.png", "image/png").blob();
    expect(originOf(plain)).toBeUndefined();
  });

  test("only the newest exports are remembered, and a string it never saw has no origin", () => {
    const { Canvas, Context } = browser();
    const first = new Canvas();
    new Context(first).drawImage(image(THUMBNAIL));
    const oldest = first.toDataURL();
    for (let i = 0; i < 20; i++) {
      const canvas = new Canvas();
      new Context(canvas).drawImage(image(`https://example.com/${i}.png`));
      canvas.toDataURL();
    }
    expect(originOf(oldest)).toBeUndefined();
    expect(originOf("data:image/png;base64,never-seen")).toBeUndefined();
    expect(originOf("https://example.com/a.png")).toBeUndefined();
    expect(originOf(null)).toBeUndefined();
  });

  test("a scope without those classes is left alone", () => {
    expect(() => trackImageOrigins({})).not.toThrow();
  });
});
