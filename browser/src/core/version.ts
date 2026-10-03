/**
 * Whether this extension and a Parousia Desktop can talk, from their release
 * versions. Only a different major version can't: minor, patch, and beta
 * differences keep working (the wire only gains optional fields within a
 * protocol, see desktop/src/link/protocol.rs), and the side that's behind is
 * told to update instead of being cut off.
 */

/** Which side is older and could update. */
export type UpdateNotice = "desktop" | "extension";

const RELEASE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+][\w.+-]{0,32})?$/;

/** A release's major, minor, and patch numbers; `null` for text that isn't one. A beta suffix is ignored: extension stores have no such versions. */
export function parseRelease(text: string): readonly [number, number, number] | null {
  const match = RELEASE.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * `null` when the majors differ or either version isn't a release (blocked);
 * otherwise the side that's behind, or `"none"` when they're level.
 */
export function compareVersions(extension: string, desktop: string): UpdateNotice | "none" | null {
  const mine = parseRelease(extension);
  const theirs = parseRelease(desktop);
  if (!mine || !theirs || mine[0] !== theirs[0]) return null;
  for (let i = 1; i < 3; i++) {
    const difference = (mine[i] ?? 0) - (theirs[i] ?? 0);
    if (difference !== 0) return difference > 0 ? "desktop" : "extension";
  }
  return "none";
}

/** Whether `candidate` is a later release than `than`, by their numbers; false if either isn't a release. */
export function isNewerRelease(candidate: string, than: string): boolean {
  const a = parseRelease(candidate);
  const b = parseRelease(than);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
