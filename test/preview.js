'use strict';

// Prints what the in-game chat looks like by running the real plugins against
// a fake session. Uses live Hypixel data if a key is saved, fixtures otherwise.
//
//   node test/preview.js

const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// isolated home so the preview doesn't touch the real config (keys are copied in)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wrath-preview-'));
process.env.WRATH_HOME = home;
fs.cpSync(path.join(__dirname, '..', 'plugins'), path.join(home, 'plugins'), { recursive: true });
const realConfig = path.join(__dirname, '..', 'config.json');
if (fs.existsSync(realConfig)) fs.copyFileSync(realConfig, path.join(home, 'config.json'));
process.on('exit', () => {
    try {
        fs.rmSync(home, { recursive: true, force: true });
    } catch { /* best effort */ }
});

const { WrathProxy } = require('../src/proxy');
const { PlayerSession } = require('../src/session');
const chatUtil = require('../src/utils/chat');
const { wordmark, panel, colours } = require('../src/utils/banner');

const ANSI = {
    0: '30', 1: '34', 2: '32', 3: '36', 4: '31', 5: '35', 6: '33', 7: '37',
    8: '90', 9: '94', a: '92', b: '96', c: '91', d: '95', e: '93', f: '97'
};

/** Translate a legacy Minecraft string into ANSI for the terminal. */
function render(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        if (text[i] === '§' && i + 1 < text.length) {
            const code = text[i + 1].toLowerCase();
            if (ANSI[code]) out += `\x1b[0m\x1b[${ANSI[code]}m`;
            else if (code === 'l') out += '\x1b[1m';
            else if (code === 'm') out += '\x1b[9m';
            else if (code === 'n') out += '\x1b[4m';
            else if (code === 'o') out += '\x1b[3m';
            else if (code === 'r') out += '\x1b[0m';
            i += 2;
            continue;
        }
        out += text[i];
        i += 1;
    }
    return out + '\x1b[0m';
}

/** Pull the plain text out of a chat packet, hover tooltips included. */
function describe(data) {
    let parsed;
    try {
        parsed = typeof data.message === 'string' ? JSON.parse(data.message) : data.message;
    } catch {
        parsed = { text: String(data.message) };
    }
    const legacy = chatUtil.toLegacy(parsed);
    const tips = [];
    const clicks = [];
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.hoverEvent && node.hoverEvent.value) tips.push(node.hoverEvent.value);
        if (node.clickEvent && node.clickEvent.value) clicks.push(node.clickEvent.value);
        for (const child of node.extra || []) walk(child);
    };
    walk(parsed);
    return { legacy, tips, clicks };
}

const proxy = new WrathProxy();
proxy.api.loadAll();

const client = new EventEmitter();
client.username = 'You';
client.uuid = '00000000-0000-0000-0000-00000000dead';
client.socket = { destroyed: false };
let lastTitleFrame = null;
client.write = (name, data) => {
    // only show the first and last frame of title animations
    if (name === 'title' && data.action === 0) {
        const text = chatUtil.toLegacy(data.text);
        if (text !== lastTitleFrame) {
            console.log('   [title]      ' + render(text));
            lastTitleFrame = text;
        }
        return;
    }
    if (name === 'title' && data.action === 1) {
        console.log('   [subtitle]   ' + render(chatUtil.toLegacy(data.text)));
        return;
    }
    if (name === 'playerlist_header') {
        const footer = chatUtil.toLegacy(data.footer).split('\n').pop();
        console.log('   [tab footer] ' + render(footer));
        return;
    }
    if (name !== 'chat') return;
    const { legacy, tips, clicks } = describe(data);
    const mark = clicks.length ? '[2m click:' + clicks[0] + '[0m' : '';
    if (data.position === 2) console.log('   [action bar] ' + render(legacy));
    else console.log('   ' + render(legacy) + mark);
    for (const tip of tips) {
        if (!process.env.SHOW_TOOLTIPS) continue;
        for (const line of tip.split('\n')) console.log('        \x1b[2m|\x1b[0m ' + render(line));
    }
};
client.end = () => {};

const session = new PlayerSession(proxy, client);
const target = new EventEmitter();
target.write = () => {};
target.end = () => {};
session.target = target;
session.targetReady = true;
proxy.session = session;
proxy.api.session = session;

// fake blacklist tags
const TAG_FIXTURES = new Map([
    ['ec70bcaf702f4bb8b48d276fa52a780c', [
        { type: 'confirmed_cheater', reason: 'killaura, video evidence in ticket 4821', addedOn: 1700000000, addedBy: 'staffMember', meta: null },
        { type: 'account', reason: 'alt of another tagged account', addedOn: 1702000000, addedBy: null, meta: null }
    ]],
    ['32b9d37005f34b3c9d1bc6d5c4e0f7a1', [
        { type: 'sniper', reason: 'follows streamers between lobbies', addedOn: 1705000000, addedBy: 'someone', meta: null }
    ]]
]);

if (process.env.NO_FIXTURES !== '1') {
    const { describeTag } = require('../src/urchin');
    for (const tags of TAG_FIXTURES.values()) for (const t of tags) t.meta = describeTag(t.type);
    proxy.urchin.lookup = async (uuids) => {
        const out = new Map();
        for (const uuid of uuids) {
            const bare = String(uuid).replace(/-/g, '').toLowerCase();
            out.set(bare, TAG_FIXTURES.get(bare) || []);
        }
        return out;
    };
    Object.defineProperty(proxy.urchin, 'enabled', { get: () => true });
}

// fake lobby
const LOBBY = [
    ['Technoblade', 'b876ec32-e396-476b-a115-8438d83c67d4'],
    ['Dream', 'ec70bcaf-702f-4bb8-b48d-276fa52a780c'],
    ['Purpled', '32b9d370-05f3-4b3c-9d1b-c6d5c4e0f7a1'],
    ['Notch', '069a79f4-44e9-4726-a5be-fca90e38aaf5']
];

function seedLobby() {
    session.onTargetPacket(
        {
            action: 0,
            data: LOBBY.map(([name, uuid]) => ({ UUID: uuid, name, properties: [], gamemode: 0, ping: 30 }))
        },
        { state: 'play', name: 'player_info' }
    );
}

function header(title) {
    console.log('\n' + colours.red('─'.repeat(4)) + ' ' + colours.bold(title) + ' ' + colours.red('─'.repeat(40 - title.length)) + '\n');
}

async function main() {
    console.log('');
    console.log(wordmark());
    console.log('');
    console.log(panel([
        ['version', colours.bold('v' + proxy.version)],
        ['account', colours.ember('oWrqth')],
        null,
        ['connect to', colours.bold('localhost:25565')],
        ['forwards to', 'mc.hypixel.net:25565'],
        null,
        ['plugins', [...proxy.api.plugins.values()].map((p) => p.name).join(', ')],
        ['hypixel key', proxy.hypixel.enabled ? colours.green('saved') : colours.grey('not set')],
        ['urchin key', proxy.urchin.enabled ? colours.green('saved') : colours.grey('not set')]
    ]));

    const run = (message) => client.emit('packet', { message }, { state: 'play', name: 'chat' });

    header('welcome splash');
    proxy.api.emit('server_connect', { type: 'server_connect', session, host: 'mc.hypixel.net' });
    await new Promise((r) => setTimeout(r, 1800));

    header('/wrathtest');
    run('/wrathtest');

    header('/stats Technoblade');
    run('/stats Technoblade');
    await new Promise((r) => setTimeout(r, 3500));

    header('/scan  (automatic lobby scan)');
    seedLobby();
    run('/scan');
    await new Promise((r) => setTimeout(r, 9000));

    header('/rules  (highlight rules)');
    run('/rules add 4 fkdr > 10 && star > 100');
    run('/rules add a fkdr < 1');
    run('/rules list');
    await new Promise((r) => setTimeout(r, 400));

    header('/scan  with rules applied');
    run('/scan');
    await new Promise((r) => setTimeout(r, 7000));

    header('/autostats compact  then /scan');
    run('/autostats compact');
    run('/scan');
    await new Promise((r) => setTimeout(r, 7000));
    run('/autostats compact');
    await new Promise((r) => setTimeout(r, 300));

    header('/bw status');
    run('/bw status');
    await new Promise((r) => setTimeout(r, 300));

    header('/quiet status');
    run('/quiet status');
    await new Promise((r) => setTimeout(r, 300));

    header('/autostats status');
    run('/autostats status');
    await new Promise((r) => setTimeout(r, 400));

    header('/wrath help');
    run('/wrath help');

    console.log('');
    proxy.stop();
    process.exit(0);
}

main();
