import { startDiscordRpcExtensionCompat } from "../compat/discord-rpc-extension";
import { builtInActivities, builtInManifests } from "../core/activities";
import { startBackground } from "./background";

const background = startBackground("Parousia/firefox", {
  registry: builtInActivities(),
  natives: builtInManifests(),
});
startDiscordRpcExtensionCompat(background.getActivity);
