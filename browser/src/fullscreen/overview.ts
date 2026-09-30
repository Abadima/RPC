import { renderPresence, type PresenceSnapshot } from "../shared/presence-view";
import {
  connectionBadge,
  discordBridgeLabel,
  isOffline,
  showsDiscordBridge,
} from "../shared/connection-status";
import { presenceIcons, renderBadge, renderDiscordAside, renderOffline } from "../shared/views";
import { fromTemplate, slot, type View, type ViewContext } from "./view";

export function overviewView(context: ViewContext): View {
  const element = fromTemplate("overview");
  const offline = slot(element, "offline");
  const retry = offline.querySelector("[data-retry]");
  retry?.addEventListener("click", context.reconnect);
  let shownSnapshot: PresenceSnapshot | null = null;

  return {
    title: "Overview",
    element,
    update({ connection, checking, snapshot, settings }) {
      const sharing = snapshot?.activity != null;
      renderBadge(slot(element, "badge"), connection, sharing);
      // Desktop missing is its own screen, as in the popup.
      offline.hidden = !isOffline(connection);
      slot(element, "online").hidden = isOffline(connection);
      renderOffline(offline, connection, checking, context.origin);
      slot(element, "status").textContent = connectionBadge(connection, sharing).text;
      slot(element, "version").textContent = settings.report?.version ?? "Unknown";
      slot(element, "discord-row").hidden = !showsDiscordBridge(connection);
      slot(element, "discord").textContent = discordBridgeLabel(settings.discord);
      renderDiscordAside(slot(element, "discord-aside"), settings.discord);
      if (snapshot && snapshot !== shownSnapshot) {
        shownSnapshot = snapshot;
        renderPresence(slot(element, "presence"), snapshot, presenceIcons);
      }
    },
  };
}
