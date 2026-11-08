/**
 * `text`, checked to be byte-identical to `JSON.stringify` of its own parse:
 * the smallest form, and the same on every build. An indent argument that
 * creeps into a writer fails the build instead of shipping larger files.
 */
export function atJsonFloor(text: string): string {
  if (JSON.stringify(JSON.parse(text)) !== text) {
    throw new Error(
      "generated JSON isn't at its minified floor (exact stringify of its own parse)",
    );
  }
  return text;
}
