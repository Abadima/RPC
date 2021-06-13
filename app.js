const DiscordRPC = require('discord-rpc');
const client = new DiscordRPC.Client({ transport: 'ipc' });
require('dotenv').config(); // This is for .env

(async () => {
    client.on('ready', async () => {
        await client.setActivity({
           buttons: [
               { label: "Test", url: "URL_LINK"}, // (OPTIONAL) Button 1
               { label: "Test2", url: "URL_LINK2"} // (OPTIONAL) Button 2
            ], // Buttons & URLs ()
            details: "Description", // Description
            largeImageKey: "lmk", // (OPTIONAL) Asset ID
            largeImageText: "Testy Test.", // (OPTIONAL) When you hover your mouse over the image
            smallImageKey: "starairlines", // (OPTIONAL) The small Image to the bottom right of your large
            smallImageText: "Smol Testy Test." // (OPTIONAL) Small Image Text
        }).catch(err => console.log(err));

        console.log("Abadima's Rich Presence Active.");
    });

    await client.login({ clientId: process.env.applicationID }).catch(console.error);
})();
