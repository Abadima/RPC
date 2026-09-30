const presence = new Presence({
  clientId: "503557087041683400",
});

presence.on("UpdateData", async () => {
  presence.setActivity({ details: document.title });
});
