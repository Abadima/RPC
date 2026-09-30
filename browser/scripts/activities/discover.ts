import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Both Activity sources file one folder per website the same way,
 * `websites/<letter>/<Name>/` (PreMiD's layout, which parousia-project/activities
 * follows too), so one walk finds both; each source's adapter (native.ts,
 * premid.ts) reads what's in a folder.
 */
export interface WebsiteFolder {
  letter: string;
  name: string;
  dir: string;
  /** `websites/<letter>/<Name>`, for messages. */
  path: string;
}

async function folders(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"));
}

/** Every `websites/<letter>/<Name>/` folder under `root`, in order. */
export async function websiteFolders(root: string): Promise<WebsiteFolder[]> {
  const websites = join(root, "websites");
  if (!existsSync(websites)) return [];
  const found: WebsiteFolder[] = [];
  for (const letter of await folders(websites)) {
    for (const name of await folders(join(websites, letter))) {
      found.push({
        letter,
        name,
        dir: join(websites, letter, name),
        path: `websites/${letter}/${name}`,
      });
    }
  }
  return found;
}

/** The letter folder for a website: its first letter, `0-9` for a digit, `#` otherwise (PreMiD's rule). */
export function folderLetter(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  if (/[A-Z]/.test(first)) return first;
  if (/\d/.test(first)) return "0-9";
  return "#";
}

/** A native Activity's folder name: letters, digits, spaces, and `. ' & + _ -`, at most 64 characters. */
export const FOLDER_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} .'&+_-]{0,62}[\p{L}\p{N}'_+-])?$/u;

/** A native Activity's id: its folder's name in lowercase, words joined by "-" (`YouTube Music` is `youtube-music`). */
export function activityId(folder: string): string {
  return folder
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
