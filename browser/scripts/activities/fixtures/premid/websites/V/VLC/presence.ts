const presence = new Presence({
  clientId: "503557087041683400",
});

presence.on("UpdateData", async () => {
  const text = document.createElement("div");
  text.innerHTML = document.title;
  presence.setActivity({ details: text.textContent ?? "VLC" });
});
