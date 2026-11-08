# Store Listings

Text for the Chrome Web Store and Firefox Add-ons (25 languages). Entered in store dashboards; not read by stores automatically. Source text is in `listings/<code>.json` (`en` is source).

## Commands

```bash
bun run store check          # Validate all languages
bun run store export         # Generate dist/store/ outputs
bun run amo:push             # Send the Firefox listing to AMO (a dry run until --yes)
bun test scripts/store.test.ts
```

---

## Store Constraints

| Feature         | Chrome Web Store                                      | Firefox Add-ons                                             |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| **Name**        | Manifest `name` (max 75 chars). Kept as `Parousia`.   | Max 50 chars. Kept as `Parousia`.                           |
| **Summary**     | Max 132 chars (from `_locales/<code>/messages.json`). | Max 250 chars (plain text, set via Dev Hub / API).          |
| **Description** | Plain text (no fixed limit; current < 2,000 chars).   | Markdown supported (current uses plain text).               |
| **Languages**   | Requires `_locales/<code>/` in the uploaded package.  | Any supported platform code; package structure independent. |
| **Fallback**    | Default language (`en`).                              | Add-on default locale (`en-US`).                            |

---

## Language Mapping

| Source Code                                                                                                | Chrome Code       | Firefox Code              | Notes                                                          |
| ---------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------- | -------------------------------------------------------------- |
| `en`                                                                                                       | `en`              | `en-US`                   |                                                                |
| `ar`, `ca`, `de`, `el`, `et`, `fa`, `fr`, `ja`, `ko`, `lt`, `lv`, `nl`, `pl`, `ro`, `ru`, `sl`, `sw`, `tr` | _Same_            | _Same_                    | Direct 1:1 mapping                                             |
| `am`                                                                                                       | `am`              | _Same_                    | Not on AMO's list yet; the push and the export hold it back.   |
| `es`                                                                                                       | `es`              | `es-ES`                   |                                                                |
| `es-419`                                                                                                   | `es_419`          | `es-MX`, `es-AR`, `es-CL` | AMO repeats text across LatAm codes; others fall back to `en`. |
| `pt-BR` / `pt-PT`                                                                                          | `pt_BR` / `pt_PT` | `pt-BR` / `pt-PT`         | Underscores on Chrome, hyphens on Firefox.                     |
| `sv`                                                                                                       | `sv`              | `sv-SE`                   |                                                                |
| `zh`                                                                                                       | `zh_CN`           | `zh-CN`                   | Simplified Chinese only; Traditional falls back to `en`.       |

Each store decides from its own list in `scripts/store.ts` (`CWS_LOCALES`, `AMO_LOCALES`): the export and the push carry only what a store names, and where one doesn't yet, the text stays a paste file or nowhere until the list grows.

The packages gate the same way, on the browser lists (`CHROME_LOCALES`, `FIREFOX_LOCALES`; `PACKAGE_LANGUAGES`). The Chromium package carries the summary of every listable language in `_locales/` and every screen dictionary; Firefox's package has no `_locales/` (its listing lives in the Developer Hub) and carries the screens' dictionaries for the languages Firefox itself has today, so `am` and `sw` reach the Chrome package and not the Firefox one, whose zip is the smaller for it. The userscript may run anywhere and inlines everything it sees.

---

## Deployment Steps

### Chrome Web Store

1. Upload `dist/chromium.zip` to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) (enables language options).
2. Run `bun run store export`.
3. For each language, copy `dist/store/chrome/<code>.txt` into the listing **Description**.
4. Submit for review.

### Firefox Add-ons

- **Manual:** Go to **Developer Hub** > **Edit Product Page**. Add each language and paste `dist/store/firefox/<code>/summary.txt` and `description.txt`.
- **Push script** (`browser/scripts/amo.ts`, one PATCH for every non-English language): `bun run amo:push` to see what would be sent, `bun run amo:push --yes` to send it. It checks the listings first, and refuses to send anything when one has problems. The Developer Hub's key pair (from [API access](https://addons.mozilla.org/en-US/developers/addon/api/key/)) goes in `browser/.env` (`AMO_JWT_ISSUER`, `AMO_JWT_SECRET`; git-ignored; `browser/.env.example` is the template). English is left as the default locale's live text. There's no blocker list to maintain: `AMO_LOCALES` (`scripts/store.ts`) is the gate, so a language AMO doesn't name yet (`am` for now) is held back and reported, and joins the push the day the list has it.
- **API:**

```bash
curl -X PATCH https://addons.mozilla.org/api/v5/addons/addon/parousia/ \
  -H "Authorization: JWT $TOKEN" \
  -H "Content-Type: application/json" \
  --data @dist/store/firefox/listing.json
```
