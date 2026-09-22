#!/usr/bin/env node
'use strict';

const { program } = require('commander');

const { WrathProxy } = require('./proxy');
const { Config } = require('./config');
const { ensureAuth } = require('./auth');
const { create, setLevel, setFile, currentFile } = require('./utils/logger');
const { getBaseDir, pluginsDir, dataDir } = require('./utils/paths');
const path = require('path');

const log = create(null);
const pkg = require('../package.json');

// start the log file first so errors are kept after the console closes
try {
    if (new Config().get('logFile', true)) {
        setFile(path.join(dataDir(), 'logs', 'wrath.log'));
    }
} catch { /* logging must never stop the CLI from running */ }

function fail(err) {
    log.error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
}

program
    .name('wrath')
    .description('A Minecraft 1.8.9 proxy with a cosmetic-only plugin API')
    .version(pkg.version);

program
    .command('start', { isDefault: true })
    .description('Start the proxy')
    .option('-p, --port <port>', 'port to listen on', (v) => Number.parseInt(v, 10))
    .option('-t, --target <host[:port]>', 'server to forward to')
    .option('-a, --account <name>', 'which saved account to use')
    .option('-v, --verbose', 'print debug logging')
    .option('-w, --window', 'open the Wrath window')
    .option('--no-window', 'run in this console only')
    .action(async (options) => {
        const overrides = {};
        if (options.port) overrides.proxyPort = options.port;
        if (options.account) overrides.account = options.account;
        if (options.target) {
            const [host, portText] = options.target.split(':');
            overrides.target = { host, port: portText ? Number.parseInt(portText, 10) : 25565 };
        }
        if (options.verbose) overrides.logLevel = 'debug';

        const proxy = new WrathProxy(overrides);
        if (options.verbose) setLevel('debug');

        // flag wins, otherwise use the last mode
        const wantsWindow = options.window === undefined
            ? proxy.config.get('window', false)
            : options.window;
        if (options.window !== undefined) proxy.config.set('window', Boolean(options.window));

        const shutdown = () => {
            proxy.stop();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        try {
            await proxy.start({ window: Boolean(wantsWindow) });
        } catch (err) {
            fail(err);
            // no console, keep the window open on the log
            if (wantsWindow && proxy.window) {
                proxy.window.setStatus('error');
                return;
            }
            proxy.stop();
        }
    });

program
    .command('window')
    .description('Start Wrath with its window')
    .option('-a, --account <name>', 'which saved account to use')
    .action(async (options) => {
        const overrides = {};
        if (options.account) overrides.account = options.account;

        const proxy = new WrathProxy(overrides);
        proxy.config.set('window', true);

        const shutdown = () => {
            proxy.stop();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        try {
            await proxy.start({ window: true });
        } catch (err) {
            fail(err);
            if (proxy.window) proxy.window.setStatus('error');
            else proxy.stop();
        }
    });

program
    .command('login')
    .description('Sign in with a Microsoft account and cache the token')
    .option('-a, --account <name>', 'label to store this account under')
    .action(async (options) => {
        const config = new Config();
        const account = options.account || config.get('account', 'default');
        try {
            const profile = await ensureAuth(account);
            if (options.account) config.set('account', account);
            log.info(`Signed in as ${profile.name} (stored as "${account}").`);
        } catch (err) {
            fail(err);
        }
    });

program
    .command('target [address]')
    .description('Show or set the server Wrath forwards to')
    .action(async (address) => {
        const config = new Config();

        if (address) {
            const [host, portText] = address.split(':');
            const port = portText ? Number.parseInt(portText, 10) : 25565;
            if (!host || Number.isNaN(port)) {
                log.error('Could not parse that address. Use host or host:port.');
                process.exitCode = 1;
                return;
            }
            // keep port 25565, nmp only follows SRV records on the default port
            config.set('target', { host, port });
            log.info(`Target set to ${host}:${port}`);
            if (portText && port !== 25565) {
                log.warn('An explicit non-default port disables SRV lookup. Drop the port if the host uses an SRV record.');
            }
        }

        const target = config.get('target');
        log.info(`Current target: ${target.host}:${target.port}`);
    });

program
    .command('check [target]')
    .description('Test whether the target server is reachable from this machine')
    .action(async (targetText) => {
        const config = new Config();
        const { diagnose } = require('./diagnose');

        let host;
        let port;
        if (targetText) {
            const [h, p] = targetText.split(':');
            host = h;
            port = p ? Number.parseInt(p, 10) : 25565;
        } else {
            const target = config.get('target');
            host = target.host;
            port = target.port;
        }

        log.info(`Checking ${host}:${port} ...`);
        const report = await diagnose(host, port);

        if (report.dns && report.dns.srv) log.info(`DNS   SRV record -> ${report.dns.host}:${report.dns.port}`);
        else if (report.dns && report.dns.addresses) log.info(`DNS   ${report.dns.addresses.join(', ')}`);

        if (report.tcp && report.tcp.ok) {
            log.info(`TCP   connected in ${report.tcp.connectedAt}ms` + (report.tcp.heldOpen ? ', held open' : `, closed by server after ${report.tcp.closedAfter}ms`));
        }
        if (report.ping && report.ping.ok) {
            log.info(`PING  ${report.ping.version}, ${report.ping.online} players online`);
        }

        const say = report.verdict === 'ok' ? log.info : log.error;
        say(`Verdict: ${report.verdict}`);
        for (const line of report.advice) say(`  ${line}`);
        if (report.verdict !== 'ok') process.exitCode = 1;
    });

program
    .command('logout')
    .description('Delete every cached Microsoft token and start over')
    .action(() => {
        const { clearTokens } = require('./auth');
        const removed = clearTokens();
        log.info(`Removed ${removed} cached token file${removed === 1 ? '' : 's'}. Run "npm run login" to sign in again.`);
    });

program
    .command('key [value]')
    .description('Save your Hypixel API key, or check the saved one')
    .action(async (value) => {
        const config = new Config();
        const { HypixelAPI } = require('./hypixel');

        if (value) {
            config.set('hypixelKey', value.trim());
            log.info('Key saved to config.json.');
        }

        const api = new HypixelAPI(config);
        if (!api.enabled) {
            log.warn('No key is saved. Get one at https://developer.hypixel.net and run: wrath key <key>');
            process.exitCode = 1;
            return;
        }

        try {
            const result = await api.verify();
            log.info('Key works.');
            if (result.limit !== null) log.info(`Quota: ${result.remaining}/${result.limit} requests left this window.`);
        } catch (err) {
            log.error(err.message);
            process.exitCode = 1;
        }
    });

program
    .command('urchin [value]')
    .description('Save your Urchin API key, or check the saved one')
    .action(async (value) => {
        const config = new Config();
        const { UrchinAPI } = require('./urchin');

        if (value) {
            config.set('urchinKey', value.trim());
            log.info('Urchin key saved to config.json.');
        }

        const api = new UrchinAPI(config);
        if (!api.enabled) {
            log.warn('No Urchin key is saved. Run: wrath urchin <your-key>');
            process.exitCode = 1;
            return;
        }

        try {
            await api.verify();
            log.info('Urchin key works.');
        } catch (err) {
            log.error(err.message);
            process.exitCode = 1;
        }
    });

program
    .command('tags <players...>')
    .description('Look up Urchin tags for one or more players')
    .action(async (players) => {
        const config = new Config();
        const { UrchinAPI } = require('./urchin');
        const api = new UrchinAPI(config);
        for (const name of players) {
            try {
                // player() accepts usernames; the batch endpoint is UUID-only.
                const { tags } = await api.player(name);
                if (!tags.length) {
                    log.info(`${name}: clean`);
                    continue;
                }
                log.warn(`${name}: ${tags.length} tag${tags.length === 1 ? '' : 's'}`);
                for (const tag of tags) {
                    const age = tag.addedOn ? new Date(tag.addedOn * 1000).toISOString().slice(0, 10) : 'unknown date';
                    log.warn(`   [${tag.meta.icon}] ${tag.meta.label} - ${tag.reason || 'no reason given'} (${age})`);
                }
            } catch (err) {
                log.error(`${name}: ${err.message}`);
                process.exitCode = 1;
            }
        }
    });

program
    .command('stats <player>')
    .description('Look up a player on Hypixel from the terminal')
    .action(async (player) => {
        const config = new Config();
        const { HypixelAPI } = require('./hypixel');
        try {
            const stats = await new HypixelAPI(config).player(player);
            log.info(`${stats.name}  rank ${stats.rank}  network level ${stats.networkLevel}`);
            log.info(`Bedwars  star ${stats.bedwars.star}  FKDR ${stats.bedwars.fkdr}  wins ${stats.bedwars.wins}`);
            log.info(`SkyWars  level ${stats.skywars.level || 'n/a'}  KDR ${stats.skywars.kdr}  wins ${stats.skywars.wins}`);
            log.info(`Duels    WLR ${stats.duels.wlr}  wins ${stats.duels.wins}`);
        } catch (err) {
            fail(err);
        }
    });

program
    .command('plugins')
    .description('List installed plugins')
    .action(() => {
        const proxy = new WrathProxy();
        proxy.api.loadAll();
        const plugins = proxy.api.list();
        if (!plugins.length) {
            log.info(`No plugins found in ${pluginsDir()}`);
            return;
        }
        for (const plugin of plugins) {
            log.info(`${plugin.enabled ? 'on ' : 'off'}  ${plugin.name} v${plugin.version} - ${plugin.description}`);
        }
        proxy.stop();
    });

program
    .command('where')
    .description('Print the folders Wrath reads and writes')
    .action(() => {
        log.info(`base:    ${getBaseDir()}`);
        log.info(`plugins: ${pluginsDir()}`);
        log.info(`data:    ${dataDir()}`);
        log.info(`log:     ${currentFile() || 'disabled'}`);
    });

program.parseAsync(process.argv).catch(fail);
