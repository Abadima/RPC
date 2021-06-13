const DiscordRPC = require('discord-rpc');
const client = new DiscordRPC.Client({ transport: 'ipc' });
require('dotenv').config(); // This is for .env

(async () => {
    client.on('ready', async () => {
        await client.setActivity({
            buttons: [{ label: "Button Title Here", url: "Link For Button Here" }], // Buttons & URLs
            details: "Description", // Description
            largeImageKey: "rpc_icon", // Asset ID
            largeImageText: "This text is shown when hovering over the largeImageKey in Discord." // When you hover your mouse over the image
        }).catch(err => console.log(err));

        console.log("Discord Rich Presence has been enabled.");
    });

    await client.login({ clientId: process.env.applicationID }).catch(console.error);
})();
