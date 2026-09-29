import { describe, expect, test } from "bun:test";
import { classifyPresence, formatElapsed } from "./render";

describe("classifyPresence", () => {
  test("no source available takes priority over everything else", () => {
    expect(classifyPresence({ available: false, activity: { name: "x" } })).toBe("unavailable");
  });

  test("available with no activity is empty", () => {
    expect(classifyPresence({ available: true, activity: null })).toBe("empty");
  });

  test("available with an activity is activity", () => {
    expect(classifyPresence({ available: true, activity: { name: "x" } })).toBe("activity");
  });
});

describe("formatElapsed", () => {
  test("minutes and seconds under an hour, hours once past one", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(59_999)).toBe("0:59");
    expect(formatElapsed(61_000)).toBe("1:01");
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(9_257_000)).toBe("2:34:17");
  });

  test("a start time in the future (clock skew) reads as zero", () => {
    expect(formatElapsed(-5000)).toBe("0:00");
  });
});
