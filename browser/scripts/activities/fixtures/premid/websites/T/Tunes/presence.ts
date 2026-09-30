const presence = new Presence({
  clientId: "503557087041683460",
});

presence.on("UpdateData", () => {
  presence.setActivity({ details: document.title });
});
