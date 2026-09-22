'use strict';

const mc = require('minecraft-protocol');

const { Config } = require('./config');
const { Storage } = require('./storage');
const { CommandHandler } = require('./commands');
const PluginAPI = require('./api');
const { PlayerSession } = require('./session');
const { ensureAuth } = require('./auth');
const { HypixelAPI } = require('./hypixel');
const { UrchinAPI } = require('./urchin');
const { create, setLevel, closeFile } = require('./utils/logger');
const { splash, divider, panel, colours } = require('./utils/banner');
const { ConnectionEvent } = require('./packets/events');

const log = create('proxy');
const MINECRAFT_VERSION = '1.8.9';
const PROTOCOL_VERSION = 47;

class WrathProxy {
    constructor(overrides = {}) {
        this.version = require('../package.json').version;
        this.config = new Config();
        Object.assign(this.config.data, overrides);
        setLevel(this.config.get('logLevel', 'info'));

        this.storage = new Storage();
        this.hypixel = new HypixelAPI(this.config);
        this.urchin = new UrchinAPI(this.config);
        this.commands = new CommandHandler(this);
        this.api = new PluginAPI(this);

        this.server = null;
        this.session = null;
        this.window = null;
    }

    async start({ window = false } = {}) {
        log.raw('');
        log.raw(splash());
        log.raw('');

        // start the window first so sign in prompts have somewhere to show up
        if (window) await this.openWindow();

        const account = this.config.get('account', 'default');
        if (this.window) this.window.setStatus('signing in');

        const profile = await ensureAuth(account, {
            onCode: (details) => {
                if (this.window) this.window.setAuth(details);
            }
        });
        this.profile = profile;
        if (this.window) this.window.setAuth(null);

        this.api.loadAll();
        this.listen();
    }

    /** Start the local window server. browser = false when running inside electron. */
    async openWindow({ browser = true } = {}) {
        const { WindowServer } = require('./ui/server');
        const { openWindow } = require('./ui/open');
        try {
            this.window = new WindowServer(this);
            await this.window.start(this.config.get('windowPort', 0));
            // no browser for tests / headless
            if (!browser || process.env.WRATH_NO_BROWSER) log.info(`Window ready at ${this.window.url}`);
            else openWindow(this.window.url);
        } catch (err) {
            log.error(`Could not start the window: ${err.message}`);
            log.error('Wrath keeps running; everything still works from in game.');
            this.window = null;
        }
    }

    /** The summary panel printed once the listener is up. */
    printPanel() {
        const target = this.config.get('target');
        const port = this.config.get('proxyPort', 25565);
        const enabled = [...this.api.plugins.values()].filter((p) => p.enabled);
        const key = this.hypixel.enabled ? colours.green('saved') : colours.grey('not set');

        log.raw(panel([
            ['version', colours.bold(`v${this.version}`)],
            ['account', colours.ember(this.profile ? this.profile.name : this.config.get('account'))],
            null,
            ['connect to', colours.bold(`localhost:${port}`)],
            ['forwards to', `${target.host}:${target.port}`],
            null,
            ['plugins', enabled.length ? enabled.map((p) => p.name).join(', ') : colours.grey('none')],
            ['hypixel key', key],
            ['urchin key', this.urchin.enabled ? colours.green('saved') : colours.grey('not set')]
        ]));
        log.raw(divider());
        log.raw(`  ${colours.grey('Add')} ${colours.bold(`localhost:${port}`)} ${colours.grey('in Minecraft 1.8.9 and join.')}`);
        log.raw('');
    }

    listen() {
        const port = this.config.get('proxyPort', 25565);

        // close the old server on retry so it doesn't leak
        if (this.server) {
            try {
                this.server.close();
            } catch { /* it never bound, which is why we are here */ }
            this.server = null;
        }

        this.server = mc.createServer({
            'online-mode': true,
            version: MINECRAFT_VERSION,
            port,
            host: '127.0.0.1',
            keepAlive: false,
            maxPlayers: 1,
            motd: this.config.get('motd'),
            beforeLogin: (client) => {
                if (client.protocolVersion !== PROTOCOL_VERSION) {
                    client.end(`§cWrath expects Minecraft ${MINECRAFT_VERSION}.`);
                }
            }
        });

        this.server.on('listening', () => {
            this.printPanel();
            if (this.window) {
                this.window.setFault(null);
                this.window.setStatus('listening');
            }
        });

        this.server.on('error', (err) => {
            const message = err.code === 'EADDRINUSE'
                ? `Port ${port} is already in use. Another copy of Wrath is probably still running.`
                : `Server error: ${err.message}`;
            log.error(message);
            if (err.code === 'EADDRINUSE') {
                log.error('Change the port in Settings, or quit the other copy.');
            }
            // show errors in the window too, not just the log
            if (this.window) {
                this.window.setStatus('error');
                this.window.setFault({ message });
            }
            process.exitCode = 1;
        });

        this.server.on('login', (client) => this.handleLogin(client));
    }

    handleLogin(client) {
        if (this.session && !this.session.closed) {
            client.end('§cWrath is already in use by another connection.');
            return;
        }

        log.info(`${client.username} connected to the proxy.`);
        const session = new PlayerSession(this, client);
        this.session = session;
        this.api.session = session;
        this.api.emit('session_start', new ConnectionEvent('session_start', session));
        session.connect();
    }

    onSessionEnd(session) {
        if (this.session === session) {
            this.session = null;
            this.api.session = null;
        }
        this.storage.flushAll();
    }

    stop() {
        if (this.session) this.session.close('proxy shutting down');
        if (this.window) this.window.stop();
        for (const plugin of this.api.plugins.values()) this.api.stop(plugin);
        this.storage.flushAll();
        if (this.server) {
            try {
                this.server.close();
            } catch { /* already closed */ }
        }
        log.info('Wrath stopped.');
        closeFile();
    }
}

module.exports = { WrathProxy, MINECRAFT_VERSION, PROTOCOL_VERSION };
