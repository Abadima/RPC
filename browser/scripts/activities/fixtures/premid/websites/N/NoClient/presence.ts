const presence = new Presence({ clientId: "none" });

presence.on("UpdateData", () => presence.clearActivity());
