import { describe, expect, test } from "bun:test";
import { atJsonFloor } from "./json";

describe("atJsonFloor", () => {
  test("minified JSON reads back as itself", () => {
    expect(atJsonFloor('{"a":1,"b":"é\\n"}')).toBe('{"a":1,"b":"é\\n"}');
    expect(atJsonFloor("[1,2,3]")).toBe("[1,2,3]");
    expect(atJsonFloor('"plain"')).toBe('"plain"');
  });

  test("formatting down to whitespace is refused", () => {
    for (const pretty of ['{ "a": 1 }', '{\n  "a": 1\n}', "[1, 2, 3]", "[ 1 ]"]) {
      expect(() => atJsonFloor(pretty)).toThrow("minified floor");
    }
  });

  test("invalid JSON never passes", () => {
    expect(() => atJsonFloor("{")).toThrow();
    expect(() => atJsonFloor("noopener")).toThrow();
    expect(() => atJsonFloor('{"a":\t1} "b"')).toThrow();
  });
});
