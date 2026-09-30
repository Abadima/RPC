/**
 * The Activity API, version 1, as native Activities import it (`"parousia"`).
 * parousia-project/activities keeps its own copy (types/parousia.d.ts) for
 * writing Activities; `bun run activities:check` type-checks every Activity
 * against this one, so the two can't drift apart unnoticed.
 */
export type {
  Activity,
  ActivityAssets,
  ActivityButton,
  ActivityTimestamps,
  PageDataKind,
  SettingValue,
} from "./activity";
export type { PageMedia, SettingValues as Settings } from "./registry";
export type { NativePage as Page, NativeModule as NativeActivity } from "../activities/manifest";
