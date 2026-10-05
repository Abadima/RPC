const DiscordRPC = require('discord-rpc');
const client = new DiscordRPC.Client({ transport: 'ipc' });
require('dotenv').config(); // This is for .env

(async () => {
    client.on('ready', async () => {
        await client.setActivity({
            buttons: [
                { label: "Test", url: "URL_LINK" }, // (OPTIONAL) Button 1
                { label: "Test2", url: "URL_LINK2" } // (OPTIONAL) Button 2
            ], // Buttons & URLs ()
            details: "Description", // Description
            state: "State", // (OPTIONAL) State
            type: 0, // (OPTIONAL) 0 = Playing, 1 = Streaming, 2 = Listening, 3 = Watching, 5 = Competing
            largeImageKey: "lmk", // (OPTIONAL) Asset ID
            largeImageText: "Testy Test.", // (OPTIONAL) When you hover your mouse over the image
            smallImageKey: "starairlines", // (OPTIONAL) The small Image to the bottom right of your large
            smallImageText: "Smol Testy Test.", // (OPTIONAL) Small Image Text
            startTimestamp: Math.floor(Date.now() / 1000), // (OPTIONAL) Elapsed Time
            endTimestamp: Math.floor(Date.now() / 1000) + 3600, // (OPTIONAL) Remaining Time
        }).catch(err => console.log(err));

        console.log("Abadima's Rich Presence Active.");
    });

    await client.login({ clientId: process.env.applicationID }).catch(console.error);
})();