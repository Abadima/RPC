const iframe = new iFrame();

iframe.on("UpdateData", async () => {
  iframe.send({ title: "From the player" });
});
