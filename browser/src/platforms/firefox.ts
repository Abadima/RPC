import { startDiscordRpcExtensionCompat } from "../compat/discord-rpc-extension";
import { startBackground } from "./background";

const background = startBackground("Parousia/firefox");
startDiscordRpcExtensionCompat(background.getActivity);
