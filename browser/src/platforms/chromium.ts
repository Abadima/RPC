import { startDiscordRpcExtensionCompat } from "../compat/discord-rpc-extension";
import { builtInActivities, builtInManifests } from "../core/activities";
import { startBackground } from "./background";

const background = startBackground("Parousia/chromium", {
  registry: builtInActivities(),
  natives: builtInManifests(),
});
startDiscordRpcExtensionCompat(background.getActivity);
