/**
 * The Firefox Add-ons listing, sent over AMO's API instead of pasted into the
 * Developer Hub (store/README.md, Firefox Add-ons > API): one PATCH carries
 * every non-English language's summary and description. The Developer Hub's
 * key pair authorizes it (the issuer is the key, the secret signs a
 * short-lived token); the pair lives in `browser/.env`, which git leaves out.
 */

import {
  AMO_LOCALES,
  LIMITS,
  STORE_LOCALES,
  descriptionText,
  listingProblems,
  loadListings,
  termProblems,
  type Listing,
} from "./store";
import { LANGUAGES, type Language } from "../src/core/i18n";

/** Where the key pair comes from (`https://addons.mozilla.org/en-US/developers/addon/api/key/`). */
export interface AmoConfig {
  issuer: string;
  secret: string;
  slug: string;
  base: string;
}

/** Values that read as the templates still in place, in `.env` or `.env.example`. */
const SANDBAGS = new Set([
  "paste-your-issuer-here",
  "replace-with-the-secret-from-the-developer-hub",
  "the-secret-from-the-developer-hub",
]);

export function loadAmoConfig(env: NodeJS.ProcessEnv = process.env): AmoConfig {
  const issuer = env.AMO_JWT_ISSUER?.trim() ?? "";
  const secret = env.AMO_JWT_SECRET?.trim() ?? "";
  if (!issuer || !secret || SANDBAGS.has(secret) || SANDBAGS.has(issuer)) {
    throw new Error(
      "browser/.env needs the Developer Hub's key pair: AMO_JWT_ISSUER and AMO_JWT_SECRET " +
        "(https://addons.mozilla.org/en-US/developers/addon/api/key/; .env is git-ignored)",
    );
  }
  return {
    issuer,
    secret,
    slug: env.AMO_ADDON_SLUG?.trim() || "parousia",
    base: env.AMO_API_BASE?.trim() || "https://addons.mozilla.org/api/v5",
  };
}

const encoder = new TextEncoder();

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * AMO's authentication token (api.authentication): HS256 over a claim set
 * naming the issuer, with a one-off id and an expiry minutes away, so a token
 * leaked from a log is spent before anyone can use it.
 */
export async function signJwt(
  { issuer, secret }: { issuer: string; secret: string },
  now = Math.floor(Date.now() / 1000),
  lifetime = 4 * 60,
): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const claims = JSON.stringify({
    iss: issuer,
    jti: base64url(nonce),
    iat: now,
    exp: now + lifetime,
  });
  const payload = base64url(claims);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/** One AMO language's text, as the patch carries it. */
export interface AmoListing {
  code: string;
  summary: string;
  description: string;
}

/**
 * What the push sends and what it holds back: a code AMO's own list
 * (`AMO_LOCALES`, scripts/store.ts) doesn't have goes nowhere, so it's held
 * back rather than sent. Nothing is configured here: when AMO grows the
 * list, the language joins the next push by itself.
 */
function splitListings(listings: Record<Language, Listing>): {
  sent: AmoListing[];
  blocked: AmoListing[];
} {
  const sent: AmoListing[] = [];
  const blocked: AmoListing[] = [];
  for (const language of LANGUAGES) {
    // English is the add-on's default locale and already live; the patch leaves it alone.
    if (language === "en") continue;
    const listing = listings[language];
    for (const code of STORE_LOCALES[language].amo) {
      const put = AMO_LOCALES.has(code) ? sent : blocked;
      put.push({ code, summary: listing.summary, description: descriptionText(listing) });
    }
  }
  return { sent, blocked };
}

export function amoListings(listings: Record<Language, Listing>): AmoListing[] {
  return splitListings(listings).sent;
}

/** What AMO's list holds back, for `main` to report. */
export function blockedListings(listings: Record<Language, Listing>): AmoListing[] {
  return splitListings(listings).blocked;
}

/** The PATCH body: `summary` and `description` keyed by AMO's code (api.addon_patch). */
export function amoPatch(listings: Record<Language, Listing>): {
  summary: Record<string, string>;
  description: Record<string, string>;
} {
  const summary: Record<string, string> = {};
  const description: Record<string, string> = {};
  for (const { code, summary: text, description: body } of amoListings(listings)) {
    summary[code] = text;
    description[code] = body;
  }
  return { summary, description };
}

export interface AmoResult {
  url: string;
  status: number;
  /** `false`: a dry run, which sent nothing. */
  sent: boolean;
  body: string;
}

/**
 * Sends the patch, or describes it when `yes` is off (the default, since this
 * writes to the live store). A dry run needs the key pair anyway, so it fails
 * the same way a send would.
 */
export async function pushListings(
  config: AmoConfig,
  patch: { summary: Record<string, string>; description: Record<string, string> },
  { yes = false, log = console.log }: { yes?: boolean; log?(message: string): void } = {},
): Promise<AmoResult> {
  const url = `${config.base}/addons/addon/${config.slug}/`;
  log(`[store] ${Object.keys(patch.summary).length} AMO locales at ${url}`);
  if (!yes) {
    log("[store] a dry run: nothing sent. Run `bun run amo:push --yes` to send it.");
    return { url, status: 0, sent: false, body: "" };
  }
  const token = await signJwt(config);
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `JWT ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `AMO answered ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
    );
  }
  log(`[store] AMO answered ${response.status}`);
  return { url, status: response.status, sent: true, body };
}

/** The push's own validation, since the store is about to hold this text. */
async function checkListings(listings: Record<Language, Listing>): Promise<string[]> {
  const problems: string[] = [];
  for (const language of LANGUAGES) {
    if (language === "en") continue;
    const listing = listings[language];
    const dictionary = (await Bun.file(
      new URL(`../src/locales/${language}.json`, import.meta.url),
    ).json()) as Record<string, unknown>;
    const found = [
      ...listingProblems(language, listing, listings.en),
      ...termProblems(listing, dictionary),
    ];
    if (listing.summary.length > LIMITS.amoSummary) {
      found.push(
        `summary is ${listing.summary.length} characters; AMO allows ${LIMITS.amoSummary}`,
      );
    }
    if (found.length > 0) problems.push(`${language}: ${found.join("; ")}`);
  }
  return problems;
}

export async function main(): Promise<void> {
  const yes = process.argv.slice(2).includes("--yes");
  const config = loadAmoConfig();
  const listings = await loadListings();
  const problems = await checkListings(listings);
  if (problems.length > 0) {
    throw new Error(`the listings have problems, so nothing is sent:\n${problems.join("\n")}`);
  }
  const blocked = blockedListings(listings);
  if (blocked.length > 0) {
    console.log(
      `[store] not sent: ${blocked.map((one) => one.code).join(", ")} (AMO doesn't take them yet)`,
    );
  }
  await pushListings(config, amoPatch(listings), { yes });
}

if (import.meta.main) await main();
