'use strict';

// Offline tests: drives a PlayerSession with fake sockets, no network or login needed.

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wrath-test-'));
process.env.WRATH_HOME = home;
// real plugins, isolated config and data
fs.cpSync(path.join(__dirname, '..', 'plugins'), path.join(home, 'plugins'), { recursive: true });

const { WrathProxy } = require('../src/proxy');
const { PlayerSession } = require('../src/session');
const chatUtil = require('../src/utils/chat');
const policy = require('../src/packets/policy');
const font = require('../src/utils/font');

const results = [];
const check = (name, fn) => {
    try {
        fn();
        results.push(['PASS', name]);
    } catch (err) {
        results.push(['FAIL', `${name} :: ${err.message}`]);
    }
};

function fakeEndpoint() {
    const endpoint = new EventEmitter();
    endpoint.sent = [];
    endpoint.socket = { destroyed: false };
    endpoint.write = (name, data) => endpoint.sent.push({ name, data });
    endpoint.end = () => { endpoint.socket.destroyed = true; };
    return endpoint;
}

const UUID = '11111111-2222-3333-4444-555555555555';

const proxy = new WrathProxy();
proxy.api.loadAll();

const client = fakeEndpoint();
client.username = 'Tester';
client.uuid = '00000000-0000-0000-0000-000000000001';

const session = new PlayerSession(proxy, client);
const target = fakeEndpoint();
session.target = target;
session.targetReady = true;
proxy.session = session;
proxy.api.session = session;

const PLAY = { state: 'play' };
const toServer = (name, data) => client.emit('packet', data, { ...PLAY, name });
const toClient = (name, data) => session.onTargetPacket(data, { ...PLAY, name });
const lastToClient = (name) => [...client.sent].reverse().find((p) => p.name === name);

// clientbound chat passes through
check('clientbound chat is forwarded', () => {
    client.sent.length = 0;
    toClient('chat', { message: JSON.stringify({ text: 'hello world' }), position: 0 });
    const sent = lastToClient('chat');
    assert.ok(sent, 'no chat packet reached the client');
    assert.match(sent.data.message, /hello world/);
});

// serverbound movement passes through
check('serverbound movement is forwarded', () => {
    target.sent.length = 0;
    toServer('position', { x: 10.5, y: 64, z: -3.25, onGround: true });
    const sent = target.sent.find((p) => p.name === 'position');
    assert.ok(sent, 'position was not forwarded');
    assert.strictEqual(session.self.x, 10.5, 'self position was not tracked');
});

// chatfilter cancels a matching line
check('a plugin can cancel a chat line', () => {
    proxy.storage.forPlugin('chatfilter').set('patterns', ['buy ranks now']);
    client.sent.length = 0;
    toClient('chat', { message: JSON.stringify({ text: 'BUY RANKS NOW at example.com' }), position: 0 });
    assert.strictEqual(lastToClient('chat'), undefined, 'filtered line still reached the client');
    client.sent.length = 0;
    toClient('chat', { message: JSON.stringify({ text: 'a normal message' }), position: 0 });
    assert.ok(lastToClient('chat'), 'an unmatched line was wrongly dropped');
    proxy.storage.forPlugin('chatfilter').set('patterns', []);
});

// player_info fills the registry and fires player_join
check('player_info builds the player registry', () => {
    let joined = null;
    proxy.api.addListener('test', 'player_join', (e) => { joined = e.player; }, false);
    toClient('player_info', {
        action: 0,
        data: [{ UUID, name: 'Notch', properties: [], gamemode: 0, ping: 42 }]
    });
    assert.ok(joined, 'player_join never fired');
    assert.strictEqual(joined.name, 'Notch');
    assert.strictEqual(session.players.get('notch').ping, 42);
    assert.strictEqual(session.players.list().length, 1);
    proxy.api.removePluginListeners('test');
});

// entity ids map back to players
check('entity ids resolve to players', () => {
    toClient('named_entity_spawn', { entityId: 77, playerUUID: UUID, x: 0, y: 0, z: 0 });
    assert.strictEqual(session.players.byEntityId(77).name, 'Notch');
    toClient('entity_destroy', { entityIds: [77] });
    assert.strictEqual(session.players.byEntityId(77), null);
});

// display overrides rewrite the tab entry
check('display overrides decorate the tab list', () => {
    session.players.setOverride(UUID, { prefix: '§c[X] ', suffix: ' §8!' });
    client.sent.length = 0;
    toClient('player_info', {
        action: 0,
        data: [{ UUID, name: 'Notch', properties: [], gamemode: 0, ping: 42 }]
    });
    const sent = lastToClient('player_info');
    const rendered = chatUtil.toLegacy(sent.data.data[0].displayName);
    assert.match(rendered, /\[X\] Notch/, `got: ${rendered}`);
    session.players.clearOverrides();
});

// proxy commands are consumed, not forwarded
check('proxy commands do not reach the server', () => {
    target.sent.length = 0;
    client.sent.length = 0;
    toServer('chat', { message: '/wrath version' });
    assert.strictEqual(target.sent.length, 0, 'a proxy command leaked to the server');
    assert.ok(client.sent.length, 'the command produced no reply');
    const printed = client.sent
        .filter((p) => p.name === 'chat')
        .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
        .join(' ');
    assert.match(printed, /WRATH/i, `got: ${printed}`);
    assert.match(printed, /1\.8\.9/, 'the version card lost its Minecraft version');
});

// plugin commands live behind the prefix
check('plugin commands are reached through the prefix', () => {
    target.sent.length = 0;
    client.sent.length = 0;
    toServer('chat', { message: '/wrath highlight list' });
    assert.strictEqual(target.sent.length, 0, 'a plugin command leaked to the server');
    assert.ok(lastToClient('chat'), 'the plugin command produced no reply');

    // bare name goes to the server
    target.sent.length = 0;
    client.sent.length = 0;
    toServer('chat', { message: '/highlight list' });
    const forwarded = target.sent.filter((p) => p.name === 'chat').map((p) => p.data.message);
    assert.deepStrictEqual(forwarded, ['/highlight list'], 'the bare name was swallowed instead of forwarded');
});

// normal chat still reaches the server
check('normal chat still reaches the server', () => {
    target.sent.length = 0;
    toServer('chat', { message: 'hello everyone' });
    assert.strictEqual(target.sent.length, 1);
    assert.strictEqual(target.sent[0].data.message, 'hello everyone');
});

// policy blocks non-cosmetic packets
check('policy blocks non-cosmetic packets', () => {
    const ctx = proxy.api.plugins.get('welcome').context;
    for (const forbidden of ['position', 'use_entity', 'window_click', 'block_dig', 'abilities']) {
        assert.throws(
            () => ctx.write('serverbound', forbidden, {}),
            /only allows cosmetic packets/,
            `${forbidden} was not blocked`
        );
    }
    assert.throws(() => ctx.write('clientbound', 'set_slot', {}), /only allows cosmetic packets/);
    assert.strictEqual(policy.canInject('clientbound', 'chat'), true);
    assert.strictEqual(policy.canInject('serverbound', 'position'), false);
});

// a throwing plugin can't break the packet stream
check('a throwing handler does not break forwarding', () => {
    proxy.api.addListener('test', 'chat', () => { throw new Error('boom'); }, false);
    client.sent.length = 0;
    toClient('chat', { message: JSON.stringify({ text: 'still delivered' }), position: 0 });
    assert.ok(lastToClient('chat'), 'the packet was lost when a handler threw');
    proxy.api.removePluginListeners('test');
});

// component -> legacy text
check('chat components convert to legacy text', () => {
    const component = { text: '', extra: [{ text: 'Hi ', color: 'red' }, { text: 'there', color: 'gold', bold: true }] };
    const legacy = chatUtil.toLegacy(component);
    assert.strictEqual(legacy, '§cHi §6§lthere');
    assert.strictEqual(chatUtil.strip(legacy), 'Hi there');
});

// hypixel player flattening
check('hypixel stats are summarized', () => {
    const { summarize, networkLevel } = require('../src/hypixel');
    const stats = summarize({
        displayname: 'Someone',
        uuid: 'abc',
        newPackageRank: 'MVP_PLUS',
        monthlyPackageRank: 'SUPERSTAR',
        networkExp: 1_000_000,
        achievements: { bedwars_level: 312 },
        stats: {
            Bedwars: { final_kills_bedwars: 900, final_deaths_bedwars: 300, wins_bedwars: 400, losses_bedwars: 200 },
            SkyWars: { kills: 50, deaths: 25, wins: 10, losses: 5, levelFormatted: '§a12✦' }
        }
    });
    assert.strictEqual(stats.rank, 'MVP++', 'MVP++ was not detected');
    assert.strictEqual(stats.bedwars.star, 312);
    assert.strictEqual(stats.bedwars.fkdr, 3);
    assert.strictEqual(stats.bedwars.wlr, 2);
    assert.strictEqual(stats.skywars.kdr, 2);
    assert.strictEqual(stats.skywars.level, '12✦', 'colour codes were left in the level');
    assert.ok(networkLevel(1_000_000) > 1);
});

// username vs uuid detection
check('uuids are recognised without a lookup', () => {
    const { HypixelAPI } = require('../src/hypixel');
    assert.strictEqual(HypixelAPI.isUuid('b314afcb-7276-40fe-8e16-e806d61ddbca'), true);
    assert.strictEqual(HypixelAPI.isUuid('b314afcb727640fe8e16e806d61ddbca'), true);
    assert.strictEqual(HypixelAPI.isUuid('Technoblade'), false);
});

// threat tiers
check('threat tiers are assigned correctly', () => {
    const ui = proxy.api.plugins.get('welcome').context.ui;
    assert.strictEqual(ui.tier(77.4).label, 'DANGER');
    assert.strictEqual(ui.tier(10).label, 'DANGER');
    assert.strictEqual(ui.tier(6).label, 'HIGH');
    assert.strictEqual(ui.tier(3.2).label, 'MEDIUM');
    assert.strictEqual(ui.tier(1).label, 'LOW');
    assert.strictEqual(ui.tier(0.4).label, 'SAFE');
    assert.strictEqual(ui.tier(null).label, 'UNKNOWN', 'a missing ratio must not be treated as safe');
    assert.strictEqual(ui.short(20100), '20.1k');
    assert.strictEqual(ui.short(1_500_000), '1.5M');
});

// gradients and rules
check('ui primitives emit valid legacy text', () => {
    const ui = proxy.api.plugins.get('welcome').context.ui;
    const brand = ui.brand();
    assert.strictEqual(chatUtil.strip(brand), 'WRATH');
    assert.ok(brand.includes('§4'), 'the wordmark lost its colour codes');
    const bar = ui.bar(5, 10, 10);
    assert.strictEqual(chatUtil.strip(bar).length, 10, 'the bar is not the requested width');

    // position 1 shouldn't wrap to the first color
    const codes = brand.match(/§[0-9a-f]/g);
    assert.strictEqual(codes[codes.length - 1], '§e', 'the gradient wrapped at the final character');
    assert.notStrictEqual(codes[0], codes[codes.length - 1]);

    // rules are exactly the requested width
    for (const width of [10, 24, 52, 53, 80]) {
        assert.strictEqual(chatUtil.strip(ui.rule(width)).length, width, `rule(${width}) is the wrong width`);
    }

    assert.strictEqual(chatUtil.strip(ui.rankName('MVP+', 'Someone')), '[MVP+] Someone');
    assert.strictEqual(chatUtil.strip(ui.rankName('NONE', 'Someone')), 'Someone');

    const clickable = ui.action('&7hi', '/stats Notch', '&7tip');
    assert.strictEqual(clickable.clickEvent.action, 'run_command');
    // click value uses the prefixed command
    assert.strictEqual(clickable.clickEvent.value, '/wrath stats Notch');
    assert.ok(clickable.hoverEvent, 'the action lost its tooltip');
});

// terminal panels don't overflow
check('terminal panels stay inside their border', () => {
    const { panel, visibleLength } = require('../src/utils/banner');
    const lines = panel([
        ['short', 'ok'],
        null,
        ['very long', 'x'.repeat(200)]
    ], { width: 58 }).split('\n');
    for (const line of lines) {
        assert.strictEqual(visibleLength(line), 60, `row is the wrong width: ${visibleLength(line)}`);
    }
});

// server_connect only fires once, not on every server switch
check('server_connect fires once, world_change every switch', () => {
    let connects = 0;
    let worldChanges = 0;
    proxy.api.addListener('test', 'server_connect', () => { connects += 1; }, false);
    proxy.api.addListener('test', 'world_change', () => { worldChanges += 1; }, false);

    const fake = fakeEndpoint();
    fake.username = 'Tester';
    const fresh = new PlayerSession(proxy, fake);
    fresh.target = fakeEndpoint();
    const where = { host: 'example.net', port: 25565 };

    // lobby, game, game
    for (let i = 0; i < 3; i += 1) {
        fresh.onTargetLogin(where);
        fresh.onTargetPacket({ entityId: i, dimension: 0 }, { state: 'play', name: 'login' });
    }

    assert.strictEqual(connects, 1, `server_connect fired ${connects} times, should be 1`);
    assert.strictEqual(worldChanges, 3, `world_change fired ${worldChanges} times, should be 3`);
    assert.strictEqual(fresh.targetReady, true);

    proxy.api.removePluginListeners('test');
    fresh.closed = true;
});

// urchin winstreaks and session deltas
check('urchin winstreaks and session deltas are parsed', () => {
    const { summariseDelta } = require('../src/urchin');

    const delta = summariseDelta({
        networkExp: 5400,
        achievements: { bedwars_level: 4 },
        stats: {
            Bedwars: {
                final_kills_bedwars: 61, final_deaths_bedwars: 12,
                wins_bedwars: 9, losses_bedwars: 3, beds_broken_bedwars: 14
            },
            SkyWars: { wins: 2, kills: 18 }
        }
    });

    assert.strictEqual(delta.bedwars.stars, 4);
    assert.strictEqual(delta.bedwars.finalKills, 61);
    assert.strictEqual(delta.gamesPlayed, 12, 'games played is wins plus losses');
    assert.strictEqual(delta.sessionFkdr, 5.08, 'the session ratio is wrong');
    assert.strictEqual(delta.skywars.kills, 18);
    assert.strictEqual(delta.active, true);

    // empty diff = hasn't played, not zero stats
    const quiet = summariseDelta({});
    assert.strictEqual(quiet.active, false);
    assert.strictEqual(quiet.gamesPlayed, 0);
    assert.strictEqual(quiet.sessionFkdr, 0);

    // unrelated fields aren't activity
    assert.strictEqual(summariseDelta({ lastLogin: 123, someOther: { thing: 1 } }).active, false);

    // no final deaths = ratio is just kills
    assert.strictEqual(summariseDelta({ stats: { Bedwars: { final_kills_bedwars: 7 } } }).sessionFkdr, 7);
});

// /stats on a mapped nick uses the real account
check('stat lookups follow a saved nickname mapping', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'statcheck.js'), 'utf8');
    for (const command of ['player', 'status', 'guild']) {
        assert.match(
            source,
            new RegExp(`\\.${command}\\(\\s*(resolve\\(|real\\b)`),
            `/${command} does not resolve the nickname before looking it up`
        );
    }

    const nicks = proxy.api.plugins.get('nicks').context;
    nicks.store.set('map', { hiddenone: 'TheRealAccount' });
    const resolver = proxy.api.shared.get('resolveNick');
    assert.strictEqual(resolver('HiddenOne'), 'TheRealAccount');
    nicks.store.set('map', {});
});

// scoreboard packets serialize correctly
check('sidebar and nametag packets are valid 1.8', () => {
    const protodef = require('protodef');
    const mcData = require('minecraft-data')('1.8.9');
    const proto = new protodef.ProtoDef();
    proto.addTypes(mcData.protocol.types);
    proto.addTypes(mcData.protocol.play.toClient.types);

    const serialise = (name, data) => proto.createPacketBuffer(`packet_${name}`, data);

    // same shapes the plugins build
    assert.doesNotThrow(() => serialise('scoreboard_objective', {
        name: 'wrath', action: 0, displayText: '§cWRATH', type: 'integer'
    }), 'the objective packet is malformed');
    assert.doesNotThrow(() => serialise('scoreboard_objective', { name: 'wrath', action: 1 }));
    assert.doesNotThrow(() => serialise('scoreboard_display_objective', { position: 1, name: 'wrath' }));
    assert.doesNotThrow(() => serialise('scoreboard_score', {
        itemName: '§fAce §c12.5', action: 0, scoreName: 'wrath', value: 5
    }), 'itemName is the line and scoreName is the objective, not the reverse');
    assert.doesNotThrow(() => serialise('scoreboard_score', { itemName: 'gone', action: 1, scoreName: 'wrath' }));
    assert.doesNotThrow(() => serialise('scoreboard_team', {
        team: 'wr_1', mode: 0, name: 'wr_1', prefix: '§c[R] ', suffix: ' §8[§c9.9§8]',
        friendlyFire: 1, nameTagVisibility: 'always', color: 15, players: ['Someone']
    }), 'the team packet is malformed');

    // team prefix/suffix max 16 chars incl color codes
    const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'nametags.js'), 'utf8');
    assert.match(source, /MAX_SUFFIX = 16/, 'the suffix limit is not stated');
    assert.doesNotMatch(source, /suffix\.slice\(0, 16\)/, 'a blind slice can cut a colour code in half');

    const worstCase = ' §8[§c999.9§8] §f9999✫ §5✘';
    assert.ok(worstCase.length > 16, 'the worst case should exceed the limit');
});

// team tracking
check('teams are tracked from scoreboard packets', () => {
    const teams = session.teams;
    teams.clear();

    const create = (key, prefix, colour, players) => toClient('scoreboard_team', {
        team: key, mode: 0, name: key, prefix, suffix: '', friendlyFire: 1, nameTagVisibility: 'always', color: colour, players
    });

    create('red', '§c§l[R] ', 14, ['Tester', 'Ally']);
    create('blue', '§9§l[B] ', 1, ['Enemy']);

    assert.strictEqual(teams.of('Ally').label, 'R', 'the team label was not read from the prefix');
    assert.strictEqual(teams.of('Ally').colour, 'c', 'the colour was not read from the prefix');
    assert.strictEqual(teams.of('enemy').colour, '9', 'lookups must not be case sensitive');
    assert.strictEqual(teams.sameTeam('Tester', 'Ally'), true);
    assert.strictEqual(teams.sameTeam('Tester', 'Enemy'), false);
    assert.strictEqual(teams.of('Nobody'), null);

    // players can only be on one team
    toClient('scoreboard_team', { team: 'blue', mode: 3, players: ['Ally'] });
    assert.strictEqual(teams.of('Ally').label, 'B', 'a moved player kept the old team');
    assert.strictEqual(teams.of('Tester').members.has('ally'), false, 'the old team kept a stale member');

    toClient('scoreboard_team', { team: 'blue', mode: 4, players: ['Ally'] });
    assert.strictEqual(teams.of('Ally'), null, 'a removed player still has a team');

    toClient('scoreboard_team', { team: 'red', mode: 1 });
    assert.strictEqual(teams.of('Tester'), null, 'removing a team left its members attached');

    // server switch resets
    create('red', '§c[R] ', 14, ['Tester']);
    toClient('login', { entityId: 9, dimension: 0 });
    assert.strictEqual(session.teams.list().length, 0, 'teams survived a server switch');
});

// isTeammate
check('teammates are identified through the context', () => {
    const ctx = proxy.api.plugins.get('welcome').context;
    session.teams.clear();
    toClient('scoreboard_team', {
        team: 'red', mode: 0, name: 'red', prefix: '§c[R] ', suffix: '',
        friendlyFire: 1, nameTagVisibility: 'always', color: 14, players: ['Tester', 'Ally']
    });
    toClient('scoreboard_team', {
        team: 'blue', mode: 0, name: 'blue', prefix: '§9[B] ', suffix: '',
        friendlyFire: 1, nameTagVisibility: 'always', color: 1, players: ['Enemy']
    });

    // session username is Tester, so red is ours
    assert.strictEqual(ctx.teams.self.label, 'R', 'could not work out which team is mine');
    assert.strictEqual(ctx.teams.isTeammate('Ally'), true);
    assert.strictEqual(ctx.teams.isTeammate('Enemy'), false);
    assert.strictEqual(ctx.teams.isTeammate('Nobody'), false);
    assert.strictEqual(ctx.teams.list().length, 2);
    session.teams.clear();
});

// game detection from the sidebar title
check('the game is detected from the sidebar', () => {
    const modes = [
        ['§e§lBED WARS', 'bedwars'],
        ['§e§lSKYWARS', 'skywars'],
        ['§e§lDUELS', 'duels'],
        ['§e§lHYPIXEL', 'lobby'],
        ['§eSomething else', 'unknown']
    ];

    let announced = null;
    proxy.api.addListener('test', 'game_change', (e) => { announced = e.mode; }, false);

    for (const [title, expected] of modes) {
        toClient('scoreboard_objective', { name: 'sidebar', action: 0, displayText: title, type: 'integer' });
        toClient('scoreboard_display_objective', { position: 1, name: 'sidebar' });
        assert.strictEqual(session.game.mode, expected, `"${title}" was read as ${session.game.mode}`);
        assert.strictEqual(announced, expected, 'game_change did not fire');
    }

    // server switch clears it
    toClient('login', { entityId: 5, dimension: 0 });
    assert.strictEqual(session.game.mode, 'unknown', 'the old game survived a server switch');

    proxy.api.removePluginListeners('test');
});

// plugins can't use require (plugins folder can be anywhere)
check('no plugin reaches outside its folder', () => {
    const dir = path.join(__dirname, '..', 'plugins');
    const offenders = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        // ignore comments and strings
        if (/(^|[^\w.])require\s*\(/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))) {
            offenders.push(file);
        }
    }
    assert.deepStrictEqual(offenders, [], `these plugins require modules: ${offenders.join(', ')}`);

    // everything is on the context instead
    const ctx = proxy.api.plugins.get('welcome').context;
    assert.ok(typeof ctx.rules.compile === 'function', 'ctx.rules is missing');
    assert.ok(typeof ctx.minecraft.particles.id === 'function', 'ctx.minecraft is missing');
    assert.strictEqual(ctx.minecraft.particles.id('enchantmenttable'), 25);
    assert.strictEqual(ctx.minecraft.particles.id('nonsense'), null);
});

// every bundled plugin loads
check('every bundled plugin loads and starts', () => {
    const dir = path.join(__dirname, '..', 'plugins');
    const expected = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_')).length;
    const loaded = proxy.api.list();
    assert.strictEqual(loaded.length, expected, `${expected} plugin files but ${loaded.length} loaded`);
    const broken = loaded.filter((p) => !p.enabled).map((p) => p.name);
    assert.deepStrictEqual(broken, [], `these plugins failed to start: ${broken.join(', ')}`);
    assert.deepStrictEqual(proxy.api.errors.filter((e) => /failed to load/.test(e.message)), []);
});

// packet muting (1.8 particles use numeric ids)
check('quiet mutes real sounds and particles', () => {
    const mcData = require('minecraft-data')('1.8.9');
    const particles = new Map((mcData.particlesArray || []).map((p) => [p.name.toLowerCase(), p.id]));
    const enchant = particles.get('enchantmenttable');
    const heart = particles.get('heart');
    assert.ok(typeof enchant === 'number', 'the particle table is missing enchantmenttable');

    const store = proxy.storage.forPlugin('quiet');
    store.set('particles', ['glyphs']);
    store.set('sounds', ['portal']);
    store.set('lobbyOnly', false);

    client.sent.length = 0;
    toClient('world_particles', { particleId: enchant, x: 0, y: 0, z: 0 });
    assert.strictEqual(lastToClient('world_particles'), undefined, 'a glyph particle was not muted');

    client.sent.length = 0;
    toClient('world_particles', { particleId: heart, x: 0, y: 0, z: 0 });
    assert.ok(lastToClient('world_particles'), 'an unrelated particle was wrongly muted');

    client.sent.length = 0;
    toClient('named_sound_effect', { soundName: 'portal.travel', x: 0, y: 0, z: 0, volume: 1, pitch: 63 });
    assert.strictEqual(lastToClient('named_sound_effect'), undefined, 'a portal sound was not muted');

    client.sent.length = 0;
    toClient('named_sound_effect', { soundName: 'mob.blaze.death', x: 0, y: 0, z: 0, volume: 1, pitch: 63 });
    assert.ok(lastToClient('named_sound_effect'), 'an unrelated sound was wrongly muted');

    store.set('particles', []);
    store.set('sounds', []);
});

// plugin services + error recording
check('plugins share services and errors are recorded', () => {
    assert.ok(proxy.api.shared.has('resolveNick'), 'the nicks plugin did not publish its resolver');

    const nicks = proxy.api.plugins.get('nicks').context;
    nicks.store.set('map', { somenick: 'RealAccount' });
    const resolve = proxy.api.shared.get('resolveNick');
    assert.strictEqual(resolve('SomeNick'), 'RealAccount', 'the resolver ignored case');
    assert.strictEqual(resolve('nobody'), null);
    nicks.store.set('map', {});

    // disabled plugin removes its services
    proxy.api.disable('nicks');
    assert.strictEqual(proxy.api.shared.has('resolveNick'), false, 'a stopped plugin left a stale service');
    proxy.api.enable('nicks');
    assert.strictEqual(proxy.api.shared.has('resolveNick'), true, 'the service did not come back');

    proxy.api.errors.length = 0;
    proxy.api.addListener('test', 'chat', () => { throw new Error('deliberate'); }, false);
    toClient('chat', { message: JSON.stringify({ text: 'trigger' }), position: 0 });
    proxy.api.removePluginListeners('test');

    assert.strictEqual(proxy.api.errors.length, 1, 'the failure was not recorded');
    assert.strictEqual(proxy.api.errors[0].plugin, 'test');
    assert.match(proxy.api.errors[0].message, /deliberate/);
    proxy.api.errors.length = 0;
});

// highlight rules evaluate correctly and can't run code
check('highlight rules parse and evaluate', () => {
    const rules = require('../src/api/rules');
    const vars = rules.variablesFor({
        networkLevel: 297,
        bedwars: { star: 223, fkdr: 77.4, finalKills: 20100, finalDeaths: 260, wins: 4924, losses: 259, wlr: 19.01, winstreak: 5 },
        skywars: { level: '23', kdr: 12.56, wins: 7398 },
        duels: { wlr: 7.56 }
    });

    assert.strictEqual(vars.star, 223);
    assert.strictEqual(vars.fkdr, 77.4);
    assert.strictEqual(vars.ws, 5);

    const cases = [
        ['fkdr > 5', true],
        ['fkdr > 100', false],
        ['star >= 200 && fkdr >= 10', true],
        ['star < 100 || fkdr > 50', true],
        ['(star + 77) * 2 > 500', true],
        ['ws = 5', true],
        ['ws != 5', false],
        ['!(fkdr > 5)', false],
        ['index > 100000', true],
        ['unknownvariable > 0', false]
    ];
    for (const [expression, expected] of cases) {
        assert.strictEqual(rules.compile(expression)(vars), expected, `"${expression}" gave the wrong answer`);
    }

    for (const bad of ['fkdr >', '((star', 'fkdr $$ 3', '', 'a b c d']) {
        assert.throws(() => rules.compile(bad), /RuleError|Rule|Unexpected|Expected/, `"${bad}" should have been rejected`);
    }

    // no way to reach globals
    assert.strictEqual(rules.compile('process > 0')({}), false);
    assert.strictEqual(rules.compile('constructor > 0')({}), false);
});

// urchin tag parsing and severity
check('urchin tags parse and rank correctly', () => {
    const { normaliseTag, UrchinAPI, describeTag } = require('../src/urchin');

    const parsed = normaliseTag({
        tag_type: 'CONFIRMED_CHEATER',
        reason: 'killaura on video',
        added_on: 1700000000,
        added_by_username: 'someStaff',
        hide_username: false
    });
    assert.strictEqual(parsed.type, 'confirmed_cheater', 'tag_type was not read');
    assert.strictEqual(parsed.reason, 'killaura on video');
    assert.strictEqual(parsed.addedBy, 'someStaff');
    assert.strictEqual(parsed.meta.icon, 'CCC');

    const worst = UrchinAPI.highest([
        { type: 'info' },
        { type: 'confirmed_cheater' },
        { type: 'caution' }
    ]);
    assert.strictEqual(worst.type, 'confirmed_cheater', 'the most severe tag was not chosen');
    assert.strictEqual(UrchinAPI.highest([]), null);
    assert.strictEqual(UrchinAPI.highest(null), null);

    assert.ok(describeTag('sniper').severity > describeTag('info').severity);
    assert.strictEqual(describeTag('nonsense').icon, '?', 'an unknown type must not crash the display');
});

async function asyncChecks() {
    // anticheat can add to the local watchlist but never submits to urchin
    await (async () => {
        const name = 'auto-watch marks locally and never reports anyone';
        try {
            const store = proxy.storage.forPlugin('anticheat');
            for (const key of ['checkVelocity', 'checkRotation', 'checkSpeed', 'checkScaffold']) store.set(key, false);
            store.set('enabled', true);
            store.set('checkAutoBlock', true);
            store.set('autoWatch', true);
            store.set('announce', false);
            store.set('threshold', 1);
            proxy.storage.forPlugin('highlight').set('names', []);

            // fail if anything submits a tag
            const realAddTag = proxy.urchin.addTag;
            let submitted = 0;
            proxy.urchin.addTag = async () => { submitted += 1; };

            session.players.clear();
            const uuid = '0ac00001-0000-4000-8000-00000000ac01';
            toClient('player_info', { action: 0, data: [{ UUID: uuid, name: 'Suspect', properties: [], gamemode: 0, ping: 20 }] });
            toClient('named_entity_spawn', { entityId: 901, playerUUID: uuid, x: 0, y: 64 * 32, z: 0, yaw: 0, pitch: 0, currentItem: 0, metadata: [] });

            for (let i = 0; i < 8; i += 1) {
                toClient('entity_metadata', { entityId: 901, metadata: [{ key: 0, type: 0, value: 0x10 }] });
                toClient('animation', { entityId: 901, animation: 0 });
                await new Promise((r) => setTimeout(r, 4));
            }
            await new Promise((r) => setTimeout(r, 60));

            const watchlist = proxy.api.shared.get('watchlist');
            assert.ok(watchlist, 'the watchlist service is not published');
            assert.strictEqual(watchlist.has('Suspect'), true, 'a flagged player was not added to the local watchlist');
            assert.strictEqual(submitted, 0, 'a flagged player was reported to the shared blacklist');

            proxy.urchin.addTag = realAddTag;
            store.set('autoWatch', false);
            store.set('enabled', false);
            proxy.storage.forPlugin('highlight').set('names', []);
            session.players.clear();
            results.push(['PASS', name]);
        } catch (err) {
            proxy.storage.forPlugin('anticheat').set('enabled', false);
            proxy.storage.forPlugin('anticheat').set('autoWatch', false);
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // autoblock: swinging with block still up. unblocking first is fine
    await (async () => {
        const name = 'autoblock is told apart from fair sword fighting';
        try {
            const store = proxy.storage.forPlugin('anticheat');
            for (const key of ['checkVelocity', 'checkRotation', 'checkSpeed', 'checkScaffold']) store.set(key, false);
            store.set('enabled', true);
            store.set('checkAutoBlock', true);
            store.set('announce', false);
            store.set('threshold', 1);

            session.players.clear();
            const USING_ITEM = 0x10;

            const spawn = (playerName, entityId, index) => {
                const uuid = `0ab0000${index}-0000-4000-8000-0000000000${index}${index}`;
                toClient('player_info', { action: 0, data: [{ UUID: uuid, name: playerName, properties: [], gamemode: 0, ping: 20 }] });
                toClient('named_entity_spawn', { entityId, playerUUID: uuid, x: 0, y: 64 * 32, z: 0, yaw: 0, pitch: 0, currentItem: 0, metadata: [] });
            };
            const blocking = (entityId, on) => toClient('entity_metadata', {
                entityId, metadata: [{ key: 0, type: 0, value: on ? USING_ITEM : 0 }]
            });
            const swing = (entityId) => toClient('animation', { entityId, animation: 0 });
            const pause = () => new Promise((r) => setTimeout(r, 4));

            spawn('FairFighter', 801, 1);
            spawn('AutoBlocker', 802, 2);

            // same blocks and swings, different order
            for (let i = 0; i < 8; i += 1) {
                blocking(801, true);
                await pause();
                blocking(801, false);
                swing(801);
                await pause();
            }
            for (let i = 0; i < 8; i += 1) {
                blocking(802, true);
                await pause();
                swing(802);
                await pause();
            }

            client.sent.length = 0;
            toServer('chat', { message: '/wrath flags' });
            await new Promise((r) => setTimeout(r, 200));
            const report = client.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join('\n');

            assert.match(report, /AutoBlocker/, 'swinging while blocking went unnoticed');
            assert.match(report, /autoblock/, 'the check did not name itself');
            assert.doesNotMatch(report, /FairFighter/, 'releasing block before swinging was flagged');

            store.set('enabled', false);
            session.players.clear();
            results.push(['PASS', name]);
        } catch (err) {
            proxy.storage.forPlugin('anticheat').set('enabled', false);
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // scaffold vs hand bridging, difference is where they're looking
    await (async () => {
        const name = 'scaffold is told apart from bridging by hand';
        try {
            const store = proxy.storage.forPlugin('anticheat');
            store.set('enabled', true);
            store.set('checkVelocity', false);
            store.set('checkRotation', false);
            store.set('checkSpeed', false);
            store.set('checkScaffold', true);
            store.set('announce', false);
            store.set('threshold', 1);

            session.players.clear();
            const POS = 32;
            const ANGLE = 360 / 256;

            const spawn = (playerName, entityId, index, startX) => {
                const uuid = `0dd0000${index}-0000-4000-8000-0000000000${index}${index}`;
                toClient('player_info', { action: 0, data: [{ UUID: uuid, name: playerName, properties: [], gamemode: 0, ping: 20 }] });
                toClient('named_entity_spawn', {
                    entityId, playerUUID: uuid,
                    x: startX * POS, y: 64 * POS, z: 0,
                    // facing -X while moving +X
                    yaw: Math.round(90 / ANGLE), pitch: 0, currentItem: 0, metadata: []
                });
            };

            const bridge = async (entityId, startX, pitchDegrees, blocks) => {
                for (let i = 0; i < blocks; i += 1) {
                    toClient('entity_move_look', {
                        entityId,
                        dX: Math.round(0.25 * POS), dY: 0, dZ: 0,
                        yaw: Math.round(90 / ANGLE),
                        pitch: Math.round(pitchDegrees / ANGLE),
                        onGround: true
                    });
                    toClient('block_change', {
                        location: { x: Math.floor(startX + i * 0.25), y: 63, z: 0 },
                        type: 1 << 4
                    });
                    await new Promise((r) => setTimeout(r, 4));
                }
            };

            spawn('HandBridger', 701, 1, 100);
            spawn('Scaffolder', 702, 2, 300);

            // same route and speed, only the head differs
            await bridge(701, 100, 65, 16);
            await bridge(702, 300, 3, 16);

            client.sent.length = 0;
            toServer('chat', { message: '/wrath flags' });
            await new Promise((r) => setTimeout(r, 200));
            const report = client.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join('\n');

            assert.match(report, /Scaffolder/, 'placing blocks while looking level went unnoticed');
            assert.match(report, /scaffold/, 'the check did not name itself');
            assert.doesNotMatch(report, /HandBridger/, 'bridging by hand was flagged, which every Bedwars player does');

            store.set('enabled', false);
            session.players.clear();
            results.push(['PASS', name]);
        } catch (err) {
            proxy.storage.forPlugin('anticheat').set('enabled', false);
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // movement checks catch the obvious and leave normal play alone
    await (async () => {
        const name = 'movement flagging catches the odd and spares the honest';
        try {
            const store = proxy.storage.forPlugin('anticheat');
            store.set('enabled', true);
            store.set('checkVelocity', true);
            store.set('checkRotation', true);
            store.set('checkSpeed', true);
            store.set('announce', false);
            store.set('threshold', 3);

            session.players.clear();
            const POS = 32;
            const VEL = 8000;
            const ANGLE = 360 / 256;

            const add = (playerName, entityId, index) => {
                const uuid = `0abc000${index}-0000-4000-8000-0000000000${index}${index}`;
                toClient('player_info', { action: 0, data: [{ UUID: uuid, name: playerName, properties: [], gamemode: 0, ping: 20 }] });
                toClient('named_entity_spawn', { entityId, playerUUID: uuid, x: 0, y: 0, z: 0 });
            };
            add('Honest', 501, 1);
            add('Odd', 502, 2);

            const pause = () => new Promise((r) => setTimeout(r, 6));

            // legit: sprint jitter, jump, takes knockback, normal head movement
            for (let tick = 0; tick < 30; tick += 1) {
                const step = Math.round((0.28 + (Math.random() - 0.5) * 0.06) * POS);
                toClient('rel_entity_move', { entityId: 501, dX: step, dY: 0, dZ: 0, onGround: true });
                toClient('entity_look', { entityId: 501, yaw: Math.round((Math.sin(tick / 4) * 40) / ANGLE), pitch: 0, onGround: true });
                if (tick === 15) {
                    toClient('entity_velocity', { entityId: 501, velocity: { x: 0.4 * VEL, y: 0.3 * VEL, z: 0 } });
                    toClient('rel_entity_move', { entityId: 501, dX: Math.round(0.38 * POS), dY: Math.round(0.3 * POS), dZ: 0, onGround: false });
                }
                await pause();
            }

            // cheating: no knockback, snap rotation, too fast
            for (let hit = 0; hit < 4; hit += 1) {
                toClient('entity_velocity', { entityId: 502, velocity: { x: 0.5 * VEL, y: 0.3 * VEL, z: 0 } });
                toClient('rel_entity_move', { entityId: 502, dX: Math.round(0.02 * POS), dY: 0, dZ: 0, onGround: true });
                await pause();
            }
            for (let snap = 0; snap < 4; snap += 1) {
                for (const yaw of [10, 170, 10]) {
                    toClient('entity_look', { entityId: 502, yaw: Math.round(yaw / ANGLE), pitch: 0, onGround: true });
                    await pause();
                }
            }
            for (let tick = 0; tick < 8; tick += 1) {
                toClient('rel_entity_move', { entityId: 502, dX: Math.round(1.6 * POS), dY: 0, dZ: 0, onGround: true });
                await pause();
            }

            client.sent.length = 0;
            toServer('chat', { message: '/wrath flags' });
            await new Promise((r) => setTimeout(r, 200));
            const report = client.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join('\n');

            assert.match(report, /Odd/, 'the odd player was not flagged at all');
            assert.match(report, /velocity/, 'ignoring knockback went unnoticed');
            assert.match(report, /rotation/, 'snapping round and back went unnoticed');
            assert.doesNotMatch(report, /Honest/, 'an honest player was flagged, which makes the tool useless');

            // read path stays read-only
            const ctx = proxy.api.plugins.get('anticheat').context;
            assert.throws(() => ctx.write('clientbound', 'rel_entity_move', {}), /only allows cosmetic packets/);
            assert.throws(() => ctx.observe('window_items', () => {}), /not an observable packet/);

            store.set('enabled', false);
            session.players.clear();
            results.push(['PASS', name]);
        } catch (err) {
            proxy.storage.forPlugin('anticheat').set('enabled', false);
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // chat patterns can be checked, captured and fixed in game
    await (async () => {
        const name = 'a dead chat pattern can be found and fixed in game';
        try {
            const store = proxy.storage.forPlugin('bedwars');
            store.set('patterns', {});
            store.set('trapReminder', true);
            store.set('alertChannels', ['chat']);

            // wording the default pattern misses
            const line = 'Your Alarm Trap was tripped by SomePlayer!';
            const fired = () => client.sent
                .filter((p) => p.name === 'chat')
                .some((p) => /Trap triggered/i.test(chatUtil.strip(chatUtil.toLegacy(p.data.message))));

            client.sent.length = 0;
            toClient('chat', { message: JSON.stringify({ text: line }), position: 0 });
            await new Promise((r) => setTimeout(r, 80));
            assert.strictEqual(fired(), false, 'the test line was supposed to go unmatched');

            // report shows it never matched
            client.sent.length = 0;
            toServer('chat', { message: '/wrath patterns' });
            await new Promise((r) => setTimeout(r, 120));
            const report = client.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join('\n');
            assert.match(report, /trap\s+never matched/, 'a dead pattern was not reported as dead');

            // capture records the real wording
            toServer('chat', { message: '/wrath capture 5' });
            await new Promise((r) => setTimeout(r, 60));
            toClient('chat', { message: JSON.stringify({ text: line }), position: 0 });
            await new Promise((r) => setTimeout(r, 60));
            client.sent.length = 0;
            toServer('chat', { message: '/wrath capture last' });
            await new Promise((r) => setTimeout(r, 120));
            const recorded = client.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join('\n');
            assert.match(recorded, /tripped/, 'capture did not record the line');
            toServer('chat', { message: '/wrath capture stop' });
            await new Promise((r) => setTimeout(r, 60));

            // fixed pattern works
            toServer('chat', { message: '/wrath patterns trap Trap was (?:set off|triggered|tripped)' });
            await new Promise((r) => setTimeout(r, 80));
            client.sent.length = 0;
            toClient('chat', { message: JSON.stringify({ text: line }), position: 0 });
            await new Promise((r) => setTimeout(r, 120));
            assert.strictEqual(fired(), true, 'the corrected pattern still did not fire');

            // bad regex is rejected
            client.sent.length = 0;
            toServer('chat', { message: '/wrath patterns trap ((unclosed' });
            await new Promise((r) => setTimeout(r, 80));
            const refused = client.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join(' ');
            assert.match(refused, /not a valid pattern/i, 'a broken regex was accepted');

            store.set('patterns', {});
            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // plugins actually draw stuff
    await (async () => {
        const name = 'the visual plugins actually draw after a scan';
        const realBatch = proxy.hypixel.batch;
        try {
            const store = proxy.storage.forPlugin('autostats');
            store.set('enabled', false);
            store.set('playSound', false);
            store.set('tabSummary', true);
            store.set('tabTable', true);
            proxy.storage.forPlugin('sidebar').set('enabled', true);
            proxy.storage.forPlugin('nametags').set('enabled', true);
            proxy.storage.forPlugin('nametags').set('hideTeammates', false);

            proxy.hypixel.batch = async (targets) => targets.map((target) => ({
                target,
                stats: {
                    name: String(target).includes('eeee') ? 'Alpha' : 'Beta',
                    uuid: target, rank: 'NONE', networkLevel: 5, karma: 0,
                    bedwars: { star: 210, finalKills: 90, finalDeaths: 10, fkdr: 9, wins: 30, losses: 10, wlr: 3, winstreak: 0 },
                    skywars: { level: '4', kills: 1, deaths: 1, kdr: 1, wins: 1, losses: 1 },
                    duels: { wins: 1, losses: 1, wlr: 1 }
                },
                error: null
            }));
            Object.defineProperty(proxy.hypixel, 'enabled', { get: () => true, configurable: true });

            session.players.clear();
            session.teams.clear();
            for (const [tag, playerName] of [['eeee', 'Alpha'], ['ffff', 'Beta']]) {
                toClient('player_info', {
                    action: 0,
                    data: [{ UUID: `${tag}${tag}-0000-4000-8000-${tag}${tag}${tag}`, name: playerName, properties: [], gamemode: 0, ping: 20 }]
                });
            }
            // server has its own sidebar
            toClient('scoreboard_objective', { name: 'hypixel', action: 0, displayText: '§eBED WARS', type: 'integer' });
            toClient('scoreboard_display_objective', { position: 1, name: 'hypixel' });

            client.sent.length = 0;
            toServer('chat', { message: '/wrath scan' });
            await new Promise((r) => setTimeout(r, 600));

            // sidebar takes the slot and writes lines
            const objectives = client.sent.filter((p) => p.name === 'scoreboard_objective' && p.data.name === 'wrath');
            const scores = client.sent.filter((p) => p.name === 'scoreboard_score' && p.data.scoreName === 'wrath');
            const display = client.sent.filter((p) => p.name === 'scoreboard_display_objective' && p.data.name === 'wrath');
            assert.ok(objectives.length, 'the sidebar never created its objective');
            assert.ok(display.length, 'the sidebar never claimed the display slot');
            assert.ok(scores.length >= 3, `the sidebar drew ${scores.length} lines`);

            // nametags gives each player a team with a suffix
            const tagTeams = client.sent.filter((p) => p.name === 'scoreboard_team' && p.data.suffix);
            assert.ok(tagTeams.length >= 2, `only ${tagTeams.length} nametags were written`);
            for (const packet of tagTeams) {
                assert.ok(packet.data.suffix.length <= 16, `a suffix was ${packet.data.suffix.length} characters`);
                assert.match(chatUtil.strip(packet.data.suffix), /9/, 'the rating is missing from the nametag');
            }

            // footer still has the summary
            const footers = client.sent.filter((p) => p.name === 'playerlist_header');
            assert.ok(footers.length, 'the tab footer was never written');
            const footerText = chatUtil.strip(chatUtil.toLegacy(footers[footers.length - 1].data.footer));
            assert.match(footerText, /WRATH/, 'the footer lost its branding');

            // tab entries: header row + one row per player
            const headerText = chatUtil.toLegacy(footers[footers.length - 1].data.header);
            const titleRow = headerText.split('\n').find((line) => /Stars/.test(chatUtil.strip(line)));
            assert.ok(titleRow, `the tab table header is missing: ${chatUtil.strip(headerText)}`);
            assert.match(chatUtil.strip(titleRow), /Player/, 'the header lost its name column');

            const rows = client.sent
                .filter((p) => p.name === 'player_info' && p.data.action === 3)
                .map((p) => chatUtil.toLegacy(p.data.data[0].displayName))
                .filter((text) => /[0-9]/.test(chatUtil.strip(text)));
            assert.ok(rows.length >= 2, `only ${rows.length} tab rows were drawn`);

            // every row padded to the same pixel width
            const widths = new Set(rows.map((row) => font.width(row)));
            assert.strictEqual(widths.size, 1, `tab rows came out ${[...widths].join(', ')} pixels wide`);

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        } finally {
            proxy.hypixel.batch = realBatch;
            delete proxy.hypixel.enabled;
            proxy.storage.forPlugin('sidebar').set('enabled', false);
            session.players.clear();
            session.teams.clear();
        }
    })();

    // rate limit (429) waits instead of failing the scan
    await (async () => {
        const name = 'a rate limit is waited out, a bad key is not';
        try {
            const { HypixelAPI, HypixelError } = require('../src/hypixel');
            const api = new HypixelAPI(proxy.config);

            let calls = 0;
            const started = Date.now();
            const result = await api.withRetry(async () => {
                calls += 1;
                if (calls < 3) throw new HypixelError('Rate limited.', 429);
                return 'recovered';
            }, { attempts: 3 });

            assert.strictEqual(result, 'recovered');
            assert.strictEqual(calls, 3, 'the call was not retried twice');
            assert.ok(Date.now() - started >= 1000, 'it retried with no backoff at all');

            // bad key doesn't retry
            let fatalCalls = 0;
            await assert.rejects(
                () => api.withRetry(async () => {
                    fatalCalls += 1;
                    throw new HypixelError('Bad key', 403);
                }, { attempts: 3 }),
                /Bad key/
            );
            assert.strictEqual(fatalCalls, 1, 'a fatal error was retried');

            // still reports the real reason
            await assert.rejects(
                () => api.withRetry(async () => { throw new HypixelError('Rate limited.', 429); }, { attempts: 2 }),
                /Rate limited/
            );

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // atomic writes
    await (async () => {
        const name = 'saved files are replaced atomically';
        try {
            const { writeJsonAtomic, readJsonSafe } = require('../src/utils/atomic');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrath-atomic-'));
            const file = path.join(dir, 'rules.json');

            writeJsonAtomic(file, { rules: ['fkdr > 10'] });
            assert.deepStrictEqual(readJsonSafe(file), { rules: ['fkdr > 10'] });

            writeJsonAtomic(file, { rules: ['fkdr > 10', 'star > 300'] });
            assert.strictEqual(readJsonSafe(file).rules.length, 2, 'the replacement did not take');
            assert.deepStrictEqual(
                fs.readdirSync(dir).filter((f) => f.includes('tmp')), [],
                'a temp file was left behind'
            );

            // truncated json falls back
            fs.writeFileSync(file, '{ "rules": [');
            assert.deepStrictEqual(readJsonSafe(file, { rescued: true }), { rescued: true });

            fs.rmSync(dir, { recursive: true, force: true });
            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // reconnect keeps the client in the world
    await (async () => {
        const name = 'a dropped server reconnects instead of kicking';
        try {
            // disable auto scan so it doesn't fire during later tests
            proxy.storage.forPlugin('autostats').set('enabled', false);

            const fake = fakeEndpoint();
            fake.username = 'Tester';
            const fresh = new PlayerSession(proxy, fake);
            fresh.target = fakeEndpoint();
            const where = { host: 'example.net', port: 25565 };

            let dialled = 0;
            fresh.connect = () => { dialled += 1; };

            // connected, dimension 0
            fresh.onTargetLogin(where);
            fresh.onTargetPacket({ entityId: 1, dimension: 0 }, { state: 'play', name: 'login' });
            assert.strictEqual(fresh.targetReady, true);

            // server drops
            const retried = fresh.tryReconnect('socketClosed', where);
            assert.strictEqual(retried, true, 'the drop was not retried');
            assert.strictEqual(fresh.closed, false, 'the client was kicked instead of held');
            assert.strictEqual(fresh.targetReady, false);
            assert.strictEqual(fake.socket.destroyed, false, 'the client socket was torn down');

            const shown = fake.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join(' ');
            assert.match(shown, /Reconnecting/i, 'the player was not told what was happening');

            await new Promise((r) => setTimeout(r, 1200));
            assert.strictEqual(dialled, 1, 'the retry never dialled the server');

            // same dimension forces a reload
            fresh.onTargetPacket({ entityId: 2, dimension: 0 }, { state: 'play', name: 'login' });
            assert.strictEqual(fresh.needsWorldReload, true, 'the same dimension was not noticed');
            fake.sent.length = 0;
            fresh.onTargetLogin(where);
            const respawns = fake.sent.filter((p) => p.name === 'respawn');
            assert.strictEqual(respawns.length, 2, 'the world was not bounced through another dimension');
            assert.notStrictEqual(respawns[0].data.dimension, 0, 'the first respawn must leave the dimension');
            assert.strictEqual(respawns[1].data.dimension, 0, 'the second respawn must return to it');
            assert.strictEqual(fresh.attempts, 0, 'the attempt counter did not reset on success');

            // manual disconnect isn't retried
            fresh.attempts = 0;
            fresh.deliberate = true;
            assert.strictEqual(fresh.tryReconnect('bye', where), false, 'a deliberate kick was retried');

            // failed first connection isn't retried
            const cold = new PlayerSession(proxy, fakeEndpoint());
            assert.strictEqual(cold.tryReconnect('refused', where), false, 'a failed first connection was retried');
            cold.closed = true;

            fresh.closed = true;
            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // teammates don't trigger threat alerts
    await (async () => {
        const name = 'a dangerous teammate does not trigger alerts';
        const realBatch = proxy.hypixel.batch;
        try {
            const store = proxy.storage.forPlugin('autostats');
            // manual /scan, auto scan off
            store.set('enabled', false);
            store.set('tabSummary', false);
            store.set('playSound', true);
            store.set('announceThreshold', 5);
            store.set('alertTeammates', false);

            proxy.hypixel.batch = async (targets) => targets.map((target) => ({
                target,
                stats: {
                    name: String(target).includes('1111') ? 'Ally' : 'Enemy',
                    uuid: target, rank: 'NONE', networkLevel: 1, karma: 0,
                    bedwars: {
                        star: 100, finalKills: 100, finalDeaths: 5,
                        fkdr: String(target).includes('1111') ? 20 : 0.5,
                        wins: 1, losses: 1, wlr: 1, winstreak: 0
                    },
                    skywars: { level: '1', kills: 0, deaths: 0, kdr: 0, wins: 0, losses: 0 },
                    duels: { wins: 0, losses: 0, wlr: 0 }
                },
                error: null
            }));
            Object.defineProperty(proxy.hypixel, 'enabled', { get: () => true, configurable: true });

            session.players.clear();
            session.teams.clear();
            const add = (tag, playerName) => toClient('player_info', {
                action: 0,
                data: [{ UUID: `${tag}${tag}-0000-4000-8000-${tag}${tag}${tag}`, name: playerName, properties: [], gamemode: 0, ping: 20 }]
            });
            add('1111', 'Ally');
            add('2222', 'Enemy');
            toClient('scoreboard_team', {
                team: 'red', mode: 0, name: 'red', prefix: '§c[R] ', suffix: '',
                friendlyFire: 1, nameTagVisibility: 'always', color: 14, players: ['Tester', 'Ally']
            });

            client.sent.length = 0;
            toServer('chat', { message: '/wrath scan' });
            await new Promise((r) => setTimeout(r, 500));

            // match the threat alert sound specifically
            const threatSound = (packets) => packets.some(
                (p) => p.name === 'named_sound_effect' && /blaze|wither/.test(p.data.soundName)
            );
            assert.strictEqual(threatSound(client.sent), false, 'a 20 FKDR teammate set off the threat alert');

            // enemy still triggers it
            proxy.hypixel.batch = async (targets) => targets.map((target) => ({
                target,
                stats: {
                    name: 'Enemy', uuid: target, rank: 'NONE', networkLevel: 1, karma: 0,
                    bedwars: { star: 100, finalKills: 100, finalDeaths: 5, fkdr: 20, wins: 1, losses: 1, wlr: 1, winstreak: 0 },
                    skywars: { level: '1', kills: 0, deaths: 0, kdr: 0, wins: 0, losses: 0 },
                    duels: { wins: 0, losses: 0, wlr: 0 }
                },
                error: null
            }));
            session.teams.clear();
            client.sent.length = 0;
            toServer('chat', { message: '/wrath scan' });
            await new Promise((r) => setTimeout(r, 500));
            assert.ok(threatSound(client.sent), 'a 20 FKDR player on no team failed to raise the alert');

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        } finally {
            proxy.hypixel.batch = realBatch;
            delete proxy.hypixel.enabled;
            session.players.clear();
            session.teams.clear();
            proxy.storage.forPlugin('autostats').set('playSound', false);
        }
    })();

    // nick vs failed lookup
    await (async () => {
        const name = 'a nick is told apart from a failed lookup';
        const realBatch = proxy.hypixel.batch;
        try {
            const store = proxy.storage.forPlugin('autostats');
            store.set('tabSummary', false);
            store.set('playSound', false);

            class ApiError extends Error {
                constructor(message, status) {
                    super(message);
                    this.status = status;
                }
            }

            proxy.hypixel.batch = async (targets) => targets.map((target) => {
                const key = String(target);
                if (key.includes('aaaa')) {
                    return {
                        target,
                        stats: {
                            name: 'Known', uuid: target, rank: 'NONE', networkLevel: 1, karma: 0,
                            bedwars: { star: 10, finalKills: 2, finalDeaths: 1, fkdr: 2, wins: 1, losses: 1, wlr: 1, winstreak: 0 },
                            skywars: { level: '1', kills: 0, deaths: 0, kdr: 0, wins: 0, losses: 0 },
                            duels: { wins: 0, losses: 0, wlr: 0 }
                        },
                        error: null
                    };
                }
                if (key.includes('bbbb')) {
                    const err = new ApiError('No Minecraft account named that.', 404);
                    err.reason = 'no-mojang-account';
                    return { target, stats: null, error: err };
                }
                if (key.includes('dddd')) {
                    // real mojang account that never played hypixel = nick
                    const err = new ApiError('RealElsewhere has no Hypixel record.', 404);
                    err.reason = 'no-hypixel-record';
                    return { target, stats: null, error: err };
                }
                return { target, stats: null, error: new ApiError('Rate limited by Hypixel.', 429) };
            });
            Object.defineProperty(proxy.hypixel, 'enabled', { get: () => true, configurable: true });

            session.players.clear();
            const add = (tag, playerName) => toClient('player_info', {
                action: 0,
                data: [{ UUID: `${tag}${tag}-0000-4000-8000-${tag}${tag}${tag}`, name: playerName, properties: [], gamemode: 0, ping: 20 }]
            });
            add('aaaa', 'Known');
            add('bbbb', 'NickedGuy');
            add('cccc', 'RateLimited');
            add('dddd', 'RealElsewhere');

            client.sent.length = 0;
            toServer('chat', { message: '/wrath scan' });
            await new Promise((r) => setTimeout(r, 500));

            const printed = client.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join('\n');

            assert.match(printed, /NICK\s+NickedGuy/, 'the nicked player got no NICK row');
            // no hypixel record in a hypixel game = nick
            assert.match(printed, /NICK\s+RealElsewhere/, 'a real account with no Hypixel record was not called a nick');
            assert.match(printed, /RealElsewhere\s+no Hypixel record/, 'the reason shown was wrong for that case');
            assert.match(printed, /NickedGuy\s+no such account/, 'the reason shown was wrong for a fake name');
            assert.match(printed, /2 nicked/, 'the header did not count both nicks');
            assert.match(printed, /Lookup failed: RateLimited/, 'a rate-limited lookup was not reported separately');
            assert.doesNotMatch(printed, /NICK\s+RateLimited/, 'a rate-limited player was wrongly called nicked');

            // same in the tab list
            const tabNames = client.sent
                .filter((p) => p.name === 'player_info' && p.data.action === 3)
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.data[0].displayName)));
            // every row starts with the team bar
            const withoutBar = tabNames.map((n) => n.replace(/^[▌┃]\s*/, ''));
            assert.ok(
                withoutBar.some((n) => /^\[NICK\]\s+NickedGuy/.test(n)),
                `no NICK tab tag: ${tabNames.join(' | ')}`
            );
            assert.ok(
                withoutBar.some((n) => /^\[\?\]\s+RateLimited/.test(n)),
                `a failed lookup lost its neutral tab tag: ${tabNames.join(' | ')}`
            );

            // 404 for a typed /players name = typo, not a nick
            const store2 = proxy.storage.forPlugin('autostats');
            store2.set('manual', ['NotAPlayer']);
            proxy.hypixel.batch = async (targets) => targets.map((target) => ({
                target, stats: null, error: new ApiError('No Minecraft account named that.', 404)
            }));
            session.players.clear();
            client.sent.length = 0;
            toServer('chat', { message: '/wrath scan' });
            await new Promise((r) => setTimeout(r, 400));
            const typed = client.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join('\n');
            assert.match(typed, /No such account: NotAPlayer/, 'a typed name that does not exist was not reported');
            assert.doesNotMatch(typed, /NICK\s+NotAPlayer/, 'a name you typed was wrongly called a nick');
            store2.set('manual', []);

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        } finally {
            proxy.hypixel.batch = realBatch;
            delete proxy.hypixel.enabled;
            session.players.clear();
        }
    })();

    // auto scan shows the whole lobby
    await (async () => {
        const name = 'each automatic scan covers the whole lobby';
        const realBatch = proxy.hypixel.batch;
        try {
            const store = proxy.storage.forPlugin('autostats');
            // set explicitly so other tests can't affect it
            store.set('enabled', true);
            store.set('settleMs', 40);
            store.set('minPlayers', 1);
            store.set('tabSummary', false);
            store.set('playSound', false);

            proxy.hypixel.batch = async (targets) => targets.map((target) => ({
                target,
                stats: {
                    name: `P${String(target).slice(-2)}`, uuid: target, rank: 'NONE', networkLevel: 1, karma: 0,
                    bedwars: { star: 1, finalKills: 1, finalDeaths: 1, fkdr: 1, wins: 1, losses: 1, wlr: 1, winstreak: 0 },
                    skywars: { level: '1', kills: 0, deaths: 0, kdr: 0, wins: 0, losses: 0 },
                    duels: { wins: 0, losses: 0, wlr: 0 }
                },
                error: null
            }));
            Object.defineProperty(proxy.hypixel, 'enabled', { get: () => true, configurable: true });

            const rowsOfLastTable = () => {
                const lines = client.sent
                    .filter((p) => p.name === 'chat' && p.data.position !== 2)
                    .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)));
                const start = lines.map((l, i) => (/\d+ found/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
                if (start === undefined) return -1;
                return lines.slice(start).filter((l) => /fkdr/.test(l) && !/avg fkdr/.test(l)).length;
            };

            const addPlayer = (n) => toClient('player_info', {
                action: 0,
                data: [{ UUID: `0000${String(n).padStart(4, '0')}-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, name: `Player${n}`, properties: [], gamemode: 0, ping: 20 }]
            });

            session.players.clear();
            toClient('login', { entityId: 1, dimension: 0 });
            for (let i = 1; i <= 4; i += 1) addPlayer(i);
            client.sent.length = 0;
            await new Promise((r) => setTimeout(r, 400));
            assert.strictEqual(rowsOfLastTable(), 4, 'the first scan did not cover the four players present');

            for (let i = 5; i <= 6; i += 1) addPlayer(i);
            client.sent.length = 0;
            await new Promise((r) => setTimeout(r, 400));
            assert.strictEqual(rowsOfLastTable(), 6, 'the second scan showed only the newcomers');

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        } finally {
            proxy.hypixel.batch = realBatch;
            // remove the stub, restores the class getter
            delete proxy.hypixel.enabled;
            const store = proxy.storage.forPlugin('autostats');
            store.set('enabled', false);
            session.players.clear();
        }
    })();

    // username in uuid batch fails, never comes back clean
    await (async () => {
        const name = 'urchin refuses usernames in batch lookup';
        try {
            const { UrchinAPI } = require('../src/urchin');
            const api = new UrchinAPI(proxy.config);
            proxy.config.data.urchinKey = 'test-key';
            await assert.rejects(() => api.lookup(['Technoblade']), /takes UUIDs, not usernames/);
            proxy.config.data.urchinKey = null;
            results.push(['PASS', name]);
        } catch (err) {
            proxy.config.data.urchinKey = null;
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // no urchin key = helpful error
    await (async () => {
        const name = 'urchin lookups fail clearly with no key';
        try {
            assert.strictEqual(proxy.urchin.enabled, false);
            await assert.rejects(
                () => proxy.urchin.player('Technoblade'),
                /No Urchin API key is set/
            );
            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // /who players with no uuid get their tags once hypixel gives us the uuid
    await (async () => {
        const name = 'blacklist tags reach players /who named before the tab list did';
        const realBatch = proxy.hypixel.batch;
        const realLookup = proxy.urchin.lookup;
        const lookups = [];
        try {
            const store = proxy.storage.forPlugin('autostats');
            store.set('enabled', true);
            store.set('playSound', false);
            store.set('checkTags', true);
            store.set('minPlayers', 1);
            store.set('settleMs', 50);

            const LATE_UUID = 'cccccccc-0000-4000-8000-cccccccccccc';

            proxy.hypixel.batch = async (targets) => targets.map((target) => ({
                target,
                stats: {
                    name: 'LateArrival',
                    // uuid comes from this reply
                    uuid: LATE_UUID,
                    rank: 'NONE', networkLevel: 5, karma: 0,
                    bedwars: { star: 100, finalKills: 10, finalDeaths: 10, fkdr: 1, wins: 1, losses: 1, wlr: 1, bedsBroken: 1, bedsLost: 1, bblr: 1, kills: 1, deaths: 1, kdr: 1, winstreak: 0 },
                    skywars: { level: '1', kills: 1, deaths: 1, kdr: 1, wins: 1, losses: 1 },
                    duels: { wins: 1, losses: 1, wlr: 1 }
                },
                error: null
            }));
            Object.defineProperty(proxy.hypixel, 'enabled', { get: () => true, configurable: true });
            Object.defineProperty(proxy.urchin, 'enabled', { get: () => true, configurable: true });

            proxy.urchin.lookup = async (uuids) => {
                lookups.push([...uuids]);
                const out = new Map();
                for (const uuid of uuids) {
                    if (String(uuid).replace(/-/g, '').toLowerCase() === LATE_UUID.replace(/-/g, '')) {
                        out.set(LATE_UUID.replace(/-/g, '').toLowerCase(), [{ type: 'CHEATING', reason: 'test', addedOn: null }]);
                    }
                }
                return out;
            };

            session.players.clear();
            session.teams.clear();
            client.sent.length = 0;

            // empty tab list, roster only from /who
            toClient('chat', { message: chatUtil.serialize('ONLINE: LateArrival'), position: 0 });
            await new Promise((r) => setTimeout(r, 900));

            // only the second urchin request can include this player
            assert.ok(lookups.length >= 1, 'the blacklist was never asked about anyone');
            const asked = lookups.flat().map((u) => String(u).replace(/-/g, '').toLowerCase());
            assert.ok(
                asked.includes(LATE_UUID.replace(/-/g, '')),
                `the late player was never looked up; asked about ${JSON.stringify(asked)}`
            );

            const printed = client.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join('\n');
            assert.match(printed, /LateArrival/, 'the late player never made it into the table');

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        } finally {
            proxy.hypixel.batch = realBatch;
            proxy.urchin.lookup = realLookup;
            proxy.storage.forPlugin('autostats').set('enabled', false);
            proxy.storage.forPlugin('autostats').set('minPlayers', 2);
            delete proxy.hypixel.enabled;
            delete proxy.urchin.enabled;
        }
    })();

    // team bar lines up for players with and without a team
    await (async () => {
        const name = 'the tab table shows teams and blacklist tags';
        const realBatch = proxy.hypixel.batch;
        try {
            const store = proxy.storage.forPlugin('autostats');
            store.set('enabled', false);
            store.set('playSound', false);
            proxy.storage.forPlugin('taboverlay').set('enabled', true);
            proxy.storage.forPlugin('taboverlay').set('showTeams', true);

            proxy.hypixel.batch = async (targets) => targets.map((target) => ({
                target,
                stats: {
                    name: String(target).includes('1111') ? 'RedOne' : 'NoTeam',
                    uuid: target, rank: 'NONE', networkLevel: 5, karma: 0,
                    bedwars: { star: 210, finalKills: 90, finalDeaths: 10, fkdr: 9, wins: 30, losses: 10, wlr: 3, bedsBroken: 40, bedsLost: 20, bblr: 2, kills: 5, deaths: 5, kdr: 1, winstreak: 4 },
                    skywars: { level: '4', kills: 1, deaths: 1, kdr: 1, wins: 1, losses: 1 },
                    duels: { wins: 1, losses: 1, wlr: 1 }
                },
                error: null
            }));
            Object.defineProperty(proxy.hypixel, 'enabled', { get: () => true, configurable: true });

            session.players.clear();
            session.teams.clear();
            const RED = '11111111-0000-4000-8000-111111111111';
            const SOLO = '22222222-0000-4000-8000-222222222222';
            toClient('player_info', { action: 0, data: [{ UUID: RED, name: 'RedOne', properties: [], gamemode: 0, ping: 20 }] });
            toClient('player_info', { action: 0, data: [{ UUID: SOLO, name: 'NoTeam', properties: [], gamemode: 0, ping: 20 }] });

            // one with a team, one without
            toClient('scoreboard_team', {
                team: 'Red', mode: 0, name: 'Red', prefix: '\u00a7c\u00a7l[R] ', suffix: '',
                friendlyFire: 1, nameTagVisibility: 'always', color: 12, players: ['RedOne']
            });

            client.sent.length = 0;
            toServer('chat', { message: '/wrath scan' });
            await new Promise((r) => setTimeout(r, 700));

            const rows = new Map();
            for (const packet of client.sent.filter((p) => p.name === 'player_info' && p.data.action === 3)) {
                const entry = packet.data.data[0];
                rows.set(entry.UUID, chatUtil.toLegacy(entry.displayName));
            }

            const red = rows.get(RED);
            const solo = rows.get(SOLO);
            assert.ok(red, 'the player on a team got no tab row');
            assert.ok(solo, 'the player with no team got no tab row');

            // colored with a team, grey without
            assert.match(red, /\u00a7c\u258cR/, `the team bar and letter are missing: ${JSON.stringify(red)}`);
            assert.match(solo, /\u00a78\u258c/, `a player with no team lost the bar entirely: ${JSON.stringify(solo)}`);

            // same start pixel
            const startOf = (row) => font.width(row.slice(0, row.search(/\u258c|\u2503/)));
            assert.strictEqual(startOf(red), startOf(solo), 'the team bar sits on two different columns');

            // same width
            assert.strictEqual(font.width(red), font.width(solo), `rows came out ${font.width(red)} and ${font.width(solo)} pixels wide`);

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        } finally {
            proxy.hypixel.batch = realBatch;
            delete proxy.hypixel.enabled;
        }
    })();

    // hypixel's /who /stats /tag pass through to the server
    await (async () => {
        const name = 'server commands pass through, Wrath commands do not';
        try {
            proxy.config.data.interceptPluginCommands = false;

            // names hypixel also uses
            const CLASHES = ['/who', '/stats Notch', '/tag', '/v Notch', '/teams', '/session'];

            for (const typed of CLASHES) {
                target.sent.length = 0;
                client.sent.length = 0;
                toServer('chat', { message: typed });
                await new Promise((r) => setTimeout(r, 60));

                const forwarded = target.sent.filter((p) => p.name === 'chat').map((p) => p.data.message);
                assert.ok(
                    forwarded.includes(typed),
                    `"${typed}" never reached the server; Wrath ate it`
                );
            }

            // prefixed form works and doesn't reach the server
            target.sent.length = 0;
            client.sent.length = 0;
            toServer('chat', { message: '/wrath tab' });
            await new Promise((r) => setTimeout(r, 200));

            const leaked = target.sent.filter((p) => p.name === 'chat');
            assert.strictEqual(leaked.length, 0, 'a Wrath command was forwarded to the server');

            const answered = client.sent
                .filter((p) => p.name === 'chat')
                .map((p) => chatUtil.strip(chatUtil.toLegacy(p.data.message)))
                .join('\n');
            assert.match(answered, /Tab table/, `"/wrath tab" was not answered: ${answered}`);

            // root alias works
            target.sent.length = 0;
            toServer('chat', { message: '/wr help' });
            await new Promise((r) => setTimeout(r, 120));
            assert.strictEqual(
                target.sent.filter((p) => p.name === 'chat').length, 0,
                '/wr was forwarded to the server'
            );

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();

    // printed commands match how they have to be typed
    await (async () => {
        const name = 'printed commands and clickable rows carry the prefix';
        try {
            proxy.config.data.interceptPluginCommands = false;

            client.sent.length = 0;
            toServer('chat', { message: '/wrath tab' });
            await new Promise((r) => setTimeout(r, 200));

            const messages = client.sent.filter((p) => p.name === 'chat').map((p) => p.data.message);
            const flat = JSON.stringify(messages);

            // no bare forms left
            const stale = chatUtil.strip(messages.map((m) => chatUtil.toLegacy(m)).join(' '))
                .match(/(?:^|[^A-Za-z0-9/._-])\/(tab|scan|stats|who|highlight|anticheat)\b/);
            assert.ok(!stale, `still printing a bare command: ${stale && stale[0]}`);

            // clickable rows use the prefix
            const clicks = [];
            const walk = (node) => {
                if (!node || typeof node !== 'object') return;
                if (node.clickEvent && node.clickEvent.value) clicks.push(node.clickEvent.value);
                for (const child of node.extra || []) walk(child);
            };
            // components are JSON strings
            for (const message of messages) {
                try {
                    walk(typeof message === 'string' ? JSON.parse(message) : message);
                } catch { /* not a component, nothing to walk */ }
            }

            assert.ok(clicks.length, 'no clickable rows were produced at all');
            for (const click of clicks) {
                assert.ok(
                    click.startsWith('/wrath ') || click.startsWith('/wr '),
                    `a clickable row would run "${click}", which goes to the server`
                );
            }

            // interception on brings the short form back
            proxy.config.data.interceptPluginCommands = true;
            assert.strictEqual(proxy.commands.qualify('/tab columns'), '/tab columns', 'the short form did not come back');
            assert.strictEqual(proxy.commands.invocation('tab'), '/tab', 'invocation ignored the setting');
            proxy.config.data.interceptPluginCommands = false;
            assert.strictEqual(proxy.commands.invocation('tab'), '/wrath tab', 'invocation ignored the setting');

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        } finally {
            proxy.config.data.interceptPluginCommands = false;
        }
    })();

    // nametags keeps the tab list grouped by team (1.8 sorts by team name, then username)
    await (async () => {
        const name = 'tagging nametags keeps the tab list grouped by team';
        const realBatch = proxy.hypixel.batch;
        try {
            const store = proxy.storage.forPlugin('autostats');
            store.set('enabled', false);
            store.set('playSound', false);
            store.set('maxPlayers', 30);
            store.set('checkTags', false);
            proxy.storage.forPlugin('nametags').set('enabled', true);
            proxy.storage.forPlugin('nametags').set('hideTeammates', false);

            proxy.hypixel.batch = async (targets) => targets.map((target) => ({
                target,
                stats: {
                    name: 'x', uuid: target, rank: 'NONE', networkLevel: 5, karma: 0,
                    bedwars: { star: 100, finalKills: 10, finalDeaths: 10, fkdr: 1, wins: 1, losses: 1, wlr: 1, bedsBroken: 1, bedsLost: 1, bblr: 1, kills: 1, deaths: 1, kdr: 1, winstreak: 0 },
                    skywars: { level: '1', kills: 1, deaths: 1, kdr: 1, wins: 1, losses: 1 },
                    duels: { wins: 1, losses: 1, wlr: 1 }
                },
                error: null
            }));
            Object.defineProperty(proxy.hypixel, 'enabled', { get: () => true, configurable: true });

            session.players.clear();
            session.teams.clear();

            // 11 players (so the counter hits 10), not in team order
            const LOBBY = [
                ['Zeta', 'Red'], ['Yuri', 'Blue'], ['Wren', 'Green'],
                ['Alpha', 'Red'], ['Cass', 'Blue'], ['Quinn', 'Yellow'],
                ['Mika', 'Red'], ['Nova', 'Blue'], ['Dex', 'Green'],
                ['Bo', 'Red'], ['Echo', 'Yellow']
            ];
            const REGISTERED = { Red: '1Red', Blue: '2Blue', Green: '3Green', Yellow: '4Yellow' };
            const COLOUR_OF = new Map(LOBBY.map(([who, team]) => [who, team]));

            LOBBY.forEach(([who], i) => {
                toClient('player_info', {
                    action: 0,
                    data: [{ UUID: `5000000${i}-0000-4000-8000-50000000000${i}`, name: who, properties: [], gamemode: 0, ping: 30 }]
                });
            });
            for (const [label, registered] of Object.entries(REGISTERED)) {
                toClient('scoreboard_team', {
                    team: registered, mode: 0, name: registered,
                    prefix: `\u00a7c\u00a7l[${label[0]}] `, suffix: '',
                    friendlyFire: 1, nameTagVisibility: 'always', color: 15,
                    players: LOBBY.filter(([, team]) => team === label).map(([who]) => who)
                });
            }

            client.sent.length = 0;
            toServer('chat', { message: '/wrath scan' });
            await new Promise((r) => setTimeout(r, 900));

            // rebuild the client's team table, not wrath's registry
            const teamOf = new Map();
            const members = new Map();
            const join = (team, players) => {
                for (const raw of players || []) {
                    const who = String(raw);
                    const previous = teamOf.get(who);
                    if (previous && members.has(previous)) members.get(previous).delete(who);
                    teamOf.set(who, team);
                    if (!members.has(team)) members.set(team, new Set());
                    members.get(team).add(who);
                }
            };
            for (const packet of client.sent) {
                if (packet.name !== 'scoreboard_team') continue;
                const { team, mode, players } = packet.data;
                if (mode === 0 || mode === 3) join(team, players);
                else if (mode === 1) {
                    for (const who of members.get(team) || []) teamOf.delete(who);
                    members.delete(team);
                }
            }

            // 1.8 sort: team name, then username
            const order = LOBBY.map(([who]) => who).sort((a, b) => {
                const ta = teamOf.get(a) || '';
                const tb = teamOf.get(b) || '';
                if (ta !== tb) return ta < tb ? -1 : 1;
                return a < b ? -1 : 1;
            });

            const runs = [];
            let previous = null;
            for (const who of order) {
                const colour = COLOUR_OF.get(who);
                if (colour !== previous) runs.push(colour);
                previous = colour;
            }

            // make sure nametags actually ran
            const originals = new Set(Object.values(REGISTERED));
            assert.ok(
                order.some((who) => !originals.has(teamOf.get(who))),
                'nametags never tagged anyone, so this proves nothing'
            );
            assert.strictEqual(
                runs.length, new Set(runs).size,
                `the tab list is no longer grouped by team: ${runs.join(' ')}`
            );

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        } finally {
            proxy.hypixel.batch = realBatch;
            delete proxy.hypixel.enabled;
            proxy.storage.forPlugin('autostats').set('maxPlayers', 20);
        }
    })();

    // window server needs the token
    await (async () => {
        const name = 'the window is reachable only with its token';
        const { WindowServer } = require('../src/ui/server');
        const win = new WindowServer(proxy);
        try {
            const port = await win.start(0);
            const base = `http://127.0.0.1:${port}`;

            const get = async (route, options = {}) => {
                const res = await fetch(base + route, options);
                return { status: res.status, body: await res.text() };
            };

            // no token
            const bare = await get('/api/state');
            assert.strictEqual(bare.status, 403, 'state was served without a token');

            // wrong token (different length shouldn't throw)
            const wrong = await get('/api/state?token=nope');
            assert.strictEqual(wrong.status, 403, 'a wrong token was accepted');

            // right token
            const good = await get(`/api/state?token=${win.token}`);
            assert.strictEqual(good.status, 200, 'the real token was refused');
            const state = JSON.parse(good.body);
            assert.strictEqual(state.version, proxy.version, 'the state carried the wrong version');
            assert.ok(Array.isArray(state.plugins) && state.plugins.length, 'no plugins in the state');

            // keys never sent to the page
            assert.ok(!good.body.includes('hypixelKey'), 'the state exposed a key field');
            assert.strictEqual(typeof state.keys.hypixel, 'boolean', 'key presence should be a flag');

            // bad Host header is refused (raw request since fetch can't set Host)
            const foreign = await new Promise((resolve, reject) => {
                const request = require('http').request({
                    host: '127.0.0.1',
                    port,
                    path: `/api/state?token=${win.token}`,
                    headers: { host: 'evil.example.com' }
                }, (res) => {
                    res.resume();
                    resolve(res.statusCode);
                });
                request.on('error', reject);
                request.end();
            });
            assert.strictEqual(foreign, 403, 'a non-loopback Host was served');

            // static files don't need the token
            const css = await get('/app.css');
            assert.strictEqual(css.status, 200, 'the stylesheet was not served');

            // writes need the token and an allowed key
            const write = await fetch(`${base}/api/config`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-wrath-token': win.token },
                body: JSON.stringify({ key: 'commandPrefix', value: '/pwn' })
            });
            const writeBody = await write.json();
            assert.ok(writeBody.error, 'an unlisted config key was writable from the window');
            assert.strictEqual(proxy.config.get('commandPrefix'), '/wrath', 'the config was changed anyway');

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        } finally {
            win.stop();
        }
    })();

    // scan reaches the window as rows
    await (async () => {
        const name = 'a scan reaches the window as rows';
        const { WindowServer } = require('../src/ui/server');
        const win = new WindowServer(proxy);
        try {
            const summary = win.summariseScan({
                mode: { key: 'bedwars', label: 'Bedwars', ratingName: 'FKDR' },
                players: [{
                    name: 'Someone',
                    uuid: 'abc',
                    rating: 4.2,
                    tier: { colour: 'c' },
                    tags: [{ type: 'CHEATING' }],
                    team: { label: 'Red', colour: 'c' },
                    teammate: false,
                    stats: { bedwars: { star: 300, fkdr: 4.2, finalKills: 900, bedsBroken: 210, bblr: 1.4, winstreak: 7 }, skywars: {}, duels: {} }
                }],
                nicked: [{ name: 'Hidden', reason: 'no Hypixel record' }],
                failed: [{ name: 'Timeout' }],
                average: 4.2,
                worst: 4.2
            });

            assert.strictEqual(summary.rows.length, 1, 'the row was lost');
            assert.strictEqual(summary.rows[0].stats.star, 300, 'the star did not survive');
            assert.strictEqual(summary.rows[0].stats.bblr, 1.4, 'BBLR did not survive');
            assert.deepStrictEqual(summary.rows[0].tags, ['CHEATING'], 'tags were not flattened');
            assert.strictEqual(summary.nicked[0].reason, 'no Hypixel record', 'the nick reason was lost');
            assert.deepStrictEqual(summary.failed.map((f) => f.name), ['Timeout'], 'the failed lookup was lost');

            // page can't look anything up, so everything has to be in here
            assert.ok(JSON.stringify(summary).length < 20000, 'the scan payload is too large to stream');

            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        } finally {
            win.stop();
        }
    })();

    // no hypixel key = helpful error
    await (async () => {
        const name = 'hypixel lookups fail clearly with no key';
        try {
            assert.strictEqual(proxy.hypixel.enabled, false, 'the test config should have no key');
            await assert.rejects(
                () => proxy.hypixel.request('player', { uuid: 'x' }),
                /No Hypixel API key is set/
            );
            results.push(['PASS', name]);
        } catch (err) {
            results.push(['FAIL', `${name} :: ${err.message}`]);
        }
    })();
}

asyncChecks().then(() => {
    proxy.stop();
    fs.rmSync(home, { recursive: true, force: true });

    const failed = results.filter(([status]) => status === 'FAIL');
    for (const [status, name] of results) {
        console.log(`${status === 'PASS' ? '  ok  ' : '  FAIL'} ${name}`);
    }
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
});
