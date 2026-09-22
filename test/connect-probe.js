'use strict';

// One real login attempt with every event logged, to see where the
// connection dies.
//
//   node test/connect-probe.js [host] [port]

const mc = require('minecraft-protocol');
const { Config } = require('../src/config');
const { authDir } = require('../src/utils/paths');
const chatUtil = require('../src/utils/chat');

const config = new Config();
const target = config.get('target');
const host = process.argv[2] || target.host;
const port = Number.parseInt(process.argv[3], 10) || target.port;

const started = Date.now();
const since = () => `+${String(Date.now() - started).padStart(5)}ms`;
const seen = [];

console.log(`Connecting to ${host}:${port} as account "${config.get('account')}"`);

// same options as Starfish (no keepAlive override, no pinned auth title)
const client = mc.createClient({
    host,
    port,
    username: config.get('account', 'default'),
    version: '1.8.9',
    auth: 'microsoft',
    hideErrors: false,
    profilesFolder: authDir(),
    onMsaCode: (data) => console.log(`${since()} MSA CODE ${data.user_code || data.userCode}`)
});

client.on('connect', () => console.log(`${since()} connect (socket open, handshake sent)`));

client.on('state', (newState) => console.log(`${since()} state -> ${newState}`));

client.on('packet', (data, meta) => {
    if (meta.state !== 'play') {
        console.log(`${since()} <- [${meta.state}] ${meta.name}`);
        return;
    }
    seen.push(meta.name);
    if (seen.length <= 12) console.log(`${since()} <- ${meta.name}`);
});

client.on('login', () => console.log(`${since()} LOGIN OK — reached the play state`));

client.on('kick_disconnect', (packet) => {
    console.log(`${since()} KICKED: ${chatUtil.strip(chatUtil.toLegacy(packet.reason))}`);
});

client.on('disconnect', (packet) => {
    console.log(`${since()} DISCONNECT: ${chatUtil.strip(chatUtil.toLegacy(packet.reason))}`);
});

client.on('error', (err) => console.log(`${since()} ERROR: ${err.message}`));

client.on('end', (reason) => {
    console.log(`${since()} END: ${reason}`);
    console.log(`\nPackets received in play state: ${seen.length}`);
    console.log(seen.length ? 'Verdict: the login succeeded, the connection reached gameplay.' : 'Verdict: died before gameplay.');
    process.exit(0);
});

setTimeout(() => {
    console.log(`${since()} still connected after 20s — the connection is healthy.`);
    console.log(`Packets received in play state: ${seen.length}`);
    client.end();
    process.exit(0);
}, 20000);
