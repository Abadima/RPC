import { ActivityType, getTimestamps } from "premid";

enum Clients {
  Main = "503557087041683458",
  Music = "503557087041683459",
}

const presence = new Presence({
  clientId: Clients.Main,
});

presence.on("UpdateData", async () => {
  const strings = await presence.getStrings({
    playing: "general.playing",
    custom: "example.custom",
  });
  const buttons = await presence.getSetting<boolean>("buttons");
  const [startTimestamp, endTimestamp] = getTimestamps(30, 90);
  presence.setActivity({
    type: ActivityType.Watching,
    details: document.title,
    state: `${strings.playing} ${strings.custom}`,
    startTimestamp,
    endTimestamp,
    buttons: buttons ? [{ label: "Open", url: "https://example.com/watch" }] : undefined,
  });
});

presence.on("iFrameData", (data: unknown) => {
  presence.info(String(data));
});
