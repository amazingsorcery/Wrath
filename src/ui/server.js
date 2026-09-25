'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { create, subscribe, currentFile } = require('../utils/logger');
const { getBaseDir, dataDir } = require('../utils/paths');
const chatUtil = require('../utils/chat');

const log = create('window');

const PUBLIC = path.join(__dirname, 'public');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

// settings the window is allowed to change
const WRITABLE = new Set([
    'proxyPort', 'target', 'hypixelKey', 'urchinKey', 'logLevel',
    'reconnect', 'reconnectAttempts'
]);

const HISTORY = 400;

/**
 * Local window server, loopback only.
 * Every request needs the startup token and a loopback Host header (blocks DNS rebinding).
 */
class WindowServer {
    constructor(proxy) {
        this.proxy = proxy;
        this.token = crypto.randomBytes(24).toString('hex');
        this.server = null;
        this.port = null;
        this.clients = new Set();
        this.history = [];
        this.unsubscribe = null;
        this.status = 'starting';
        this.session = null;
        this.lastScan = null;
        this.pendingAuth = null;
        this.pendingFault = null;
    }

    /** Keep the device code around, the page might connect after it was sent. */
    setAuth(details) {
        this.pendingAuth = details && details.code ? details : null;
        this.broadcast('auth', this.pendingAuth);
    }

    /** Same for errors. */
    setFault(fault) {
        this.pendingFault = fault && fault.message ? fault : null;
        this.broadcast('fault', this.pendingFault);
    }

    get url() {
        return `http://127.0.0.1:${this.port}/?token=${this.token}`;
    }

    // --- lifecycle --------------------------------------------------------

    async start(preferredPort) {
        this.server = http.createServer((req, res) => {
            try {
                this.route(req, res);
            } catch (err) {
                this.send(res, 500, { error: err.message });
            }
        });

        this.port = await this.listen(preferredPort);
        this.watch();
        return this.port;
    }

    /** Use the configured port or any free one. */
    listen(preferred) {
        return new Promise((resolve, reject) => {
            const attempt = (port, retriesLeft) => {
                this.server.removeAllListeners('error');
                this.server.once('error', (err) => {
                    if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
                        attempt(port === 0 ? 0 : port + 1, retriesLeft - 1);
                        return;
                    }
                    if (err.code === 'EADDRINUSE') {
                        attempt(0, 0);
                        return;
                    }
                    reject(err);
                });
                this.server.listen(port, '127.0.0.1', () => {
                    resolve(this.server.address().port);
                });
            };
            attempt(preferred || 0, 8);
        });
    }

    /** Follow the log and the proxy's own events, and fan them out. */
    watch() {
        this.unsubscribe = subscribe((entry) => {
            this.history.push(entry);
            if (this.history.length > HISTORY) this.history.shift();
            this.broadcast('log', entry);
        });

        const api = this.proxy.api;
        api.addListener('__window', 'server_connect', (event) => {
            this.session = {
                username: (event.session && event.session.username) || null,
                host: event.host || null
            };
            this.setStatus('connected');
        }, false);

        api.addListener('__window', 'session_end', () => {
            this.session = null;
            this.lastScan = null;
            this.setStatus('listening');
        }, false);

        api.addListener('__window', 'world_change', () => this.pushState(), false);

        // scan results for the roster view
        api.addListener('__window', 'autostats:scan', (event) => {
            this.lastScan = this.summariseScan(event);
            this.broadcast('scan', this.lastScan);
        }, false);
    }

    stop() {
        if (this.unsubscribe) this.unsubscribe();
        for (const res of this.clients) {
            try {
                res.end();
            } catch { /* already gone */ }
        }
        this.clients.clear();
        if (this.server) {
            try {
                this.server.close();
            } catch { /* already closed */ }
        }
    }

    setStatus(status) {
        this.status = status;
        this.pushState();
    }

    // --- state ------------------------------------------------------------

    state() {
        const config = this.proxy.config;
        const target = config.get('target');
        return {
            version: this.proxy.version,
            status: this.status,
            account: this.proxy.profile ? this.proxy.profile.name : config.get('account'),
            port: config.get('proxyPort', 25565),
            target,
            logLevel: config.get('logLevel', 'info'),
            reconnect: config.get('reconnect', true),
            keys: {
                hypixel: Boolean(this.proxy.hypixel.enabled),
                urchin: Boolean(this.proxy.urchin.enabled)
            },
            rate: this.proxy.hypixel.rate,
            session: this.session,
            players: this.session && this.proxy.session ? this.proxy.session.players.list().length : 0,
            mode: this.proxy.session ? this.proxy.session.game.mode : null,
            plugins: this.proxy.api.list().map((plugin) => ({
                ...plugin,
                errors: this.proxy.api.errors.filter((e) => e.plugin === plugin.name).length
            })),
            errors: this.proxy.api.errors.slice(0, 10),
            logPath: currentFile(),
            baseDir: getBaseDir(),
            dataDir: dataDir()
        };
    }

    /** Flatten a scan into rows the page can render without knowing the games. */
    summariseScan(event) {
        const mode = event.mode || {};
        const rows = (event.players || []).map((player) => {
            const bw = (player.stats && player.stats.bedwars) || {};
            const sw = (player.stats && player.stats.skywars) || {};
            const duels = (player.stats && player.stats.duels) || {};
            return {
                name: player.name,
                uuid: player.uuid,
                rating: player.rating,
                tier: player.tier ? player.tier.colour : '7',
                team: player.team ? { label: player.team.label, colour: player.team.colour } : null,
                teammate: Boolean(player.teammate),
                tags: (player.tags || []).map((tag) => tag.type),
                stats: {
                    star: bw.star, fkdr: bw.fkdr, finals: bw.finalKills, wlr: bw.wlr,
                    wins: bw.wins, beds: bw.bedsBroken, bblr: bw.bblr, ws: bw.winstreak,
                    swLevel: sw.level, swKdr: sw.kdr, duelsWlr: duels.wlr, duelsWins: duels.wins
                }
            };
        });
        return {
            at: Date.now(),
            mode: { key: mode.key || null, label: mode.label || 'Lobby', ratingName: mode.ratingName || '' },
            rows,
            nicked: (event.nicked || []).map((n) => ({
                name: n.name,
                reason: n.reason || null,
                team: n.team ? { label: n.team.label, colour: n.team.colour } : null,
                teammate: Boolean(n.teammate)
            })),
            failed: (event.failed || []).map((f) => ({
                name: f.name,
                team: f.team ? { label: f.team.label, colour: f.team.colour } : null
            })),
            average: event.average,
            worst: event.worst
        };
    }

    // --- transport --------------------------------------------------------

    broadcast(type, payload) {
        if (!this.clients.size) return;
        const frame = `data: ${JSON.stringify({ type, payload })}\n\n`;
        for (const res of this.clients) {
            try {
                res.write(frame);
            } catch { /* the stream closes itself */ }
        }
    }

    pushState() {
        this.broadcast('state', this.state());
    }

    send(res, code, body) {
        const text = JSON.stringify(body);
        res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store'
        });
        res.end(text);
    }

    /** Request needs a loopback Host and the token (DNS rebinding). */
    loopback(req) {
        const host = (req.headers.host || '').split(':')[0];
        return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
    }

    authorised(req, url) {
        if (!this.loopback(req)) return false;
        const supplied = req.headers['x-wrath-token'] || url.searchParams.get('token');
        if (!supplied) return false;
        const a = Buffer.from(String(supplied));
        const b = Buffer.from(this.token);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    route(req, res) {
        const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        const route = url.pathname;

        // static files are open, the api needs the token
        if (!this.loopback(req)) {
            this.send(res, 403, { error: 'Local requests only.' });
            return;
        }

        const isApi = route.startsWith('/api/');
        if (isApi && !this.authorised(req, url)) {
            this.send(res, 403, { error: 'Open Wrath from its own window or shortcut.' });
            return;
        }

        if (route === '/api/events') return this.stream(req, res);
        if (route === '/api/state') return this.send(res, 200, this.state());
        if (route === '/api/log') return this.send(res, 200, { lines: this.history });
        if (route === '/api/scan') return this.send(res, 200, this.lastScan);

        if (req.method === 'POST') return this.command(req, res, route);

        return this.static(res, route);
    }

    stream(req, res) {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no'
        });
        res.write('retry: 2000\n\n');
        res.write(`data: ${JSON.stringify({ type: 'state', payload: this.state() })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'history', payload: this.history })}\n\n`);
        if (this.lastScan) res.write(`data: ${JSON.stringify({ type: 'scan', payload: this.lastScan })}\n\n`);
        if (this.pendingAuth) res.write(`data: ${JSON.stringify({ type: 'auth', payload: this.pendingAuth })}\n\n`);
        if (this.pendingFault) res.write(`data: ${JSON.stringify({ type: 'fault', payload: this.pendingFault })}\n\n`);

        this.clients.add(res);

        // keepalive so idle streams don't get closed
        const ping = setInterval(() => {
            try {
                res.write(': ping\n\n');
            } catch { /* handled by close */ }
        }, 20000);

        req.on('close', () => {
            clearInterval(ping);
            this.clients.delete(res);
        });
    }

    command(req, res, route) {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            // cap the body size
            if (body.length > 64 * 1024) req.destroy();
        });
        req.on('end', () => {
            let payload = {};
            try {
                payload = body ? JSON.parse(body) : {};
            } catch {
                return this.send(res, 400, { error: 'Malformed request.' });
            }
            try {
                return this.handle(res, route, payload);
            } catch (err) {
                return this.send(res, 400, { error: err.message });
            }
        });
    }

    handle(res, route, payload) {
        const config = this.proxy.config;

        if (route === '/api/plugin') {
            const { name, enabled } = payload;
            if (!name) throw new Error('No plugin named.');
            const result = enabled ? this.proxy.api.enable(name) : this.proxy.api.disable(name);
            if (!result.ok) throw new Error(result.error);
            log.info(`${enabled ? 'Enabled' : 'Disabled'} ${name} from the window.`);
            this.pushState();
            return this.send(res, 200, { ok: true });
        }

        if (route === '/api/config') {
            const { key, value } = payload;
            if (!WRITABLE.has(key)) throw new Error(`"${key}" cannot be changed here.`);

            if (key === 'target') {
                const host = String(value.host || '').trim();
                const port = Number.parseInt(value.port, 10) || 25565;
                if (!host) throw new Error('Give a server address.');
                config.set('target', { host, port });
            } else if (key === 'proxyPort') {
                const port = Number.parseInt(value, 10);
                if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
                config.set('proxyPort', port);
            } else if (key === 'hypixelKey' || key === 'urchinKey') {
                const trimmed = String(value || '').trim();
                config.set(key, trimmed || null);
                // picked up on the next request, no restart
            } else {
                config.set(key, value);
            }

            log.info(`Changed ${key} from the window.`);
            this.pushState();
            return this.send(res, 200, { ok: true, restartNeeded: key === 'proxyPort' });
        }

        if (route === '/api/verify') {
            const which = payload.which === 'urchin' ? this.proxy.urchin : this.proxy.hypixel;
            return which.verify()
                .then((result) => this.send(res, 200, { ok: true, result: result || null }))
                .catch((err) => this.send(res, 200, { ok: false, error: err.message }));
        }

        if (route === '/api/scan') {
            if (!this.proxy.session) throw new Error('Nothing is connected yet.');
            // use the current command form
            this.proxy.commands.handle(this.proxy.commands.invocation('scan'), this.proxy.session);
            return this.send(res, 200, { ok: true });
        }

        if (route === '/api/say') {
            if (!this.proxy.session) throw new Error('Nothing is connected yet.');
            const text = String(payload.text || '').trim();
            if (!text) throw new Error('Nothing to send.');
            this.proxy.session.sendClientbound('chat', {
                message: chatUtil.serialize(text),
                position: 0
            });
            return this.send(res, 200, { ok: true });
        }

        if (route === '/api/retry') {
            // retry
            this.setFault(null);
            this.setStatus('starting');
            this.proxy.listen();
            return this.send(res, 200, { ok: true });
        }

        if (route === '/api/reload') {
            this.proxy.api.reloadAll();
            this.watchAgain();
            this.pushState();
            return this.send(res, 200, { ok: true });
        }

        if (route === '/api/quit') {
            this.send(res, 200, { ok: true });
            // respond before exiting
            setTimeout(() => {
                this.proxy.stop();
                process.exit(0);
            }, 150);
            return undefined;
        }

        throw new Error('No such action.');
    }

    /** Reloading plugins drops our listeners with theirs, so put them back. */
    watchAgain() {
        const api = this.proxy.api;
        api.removePluginListeners('__window');
        const keepHistory = this.history;
        if (this.unsubscribe) this.unsubscribe();
        this.watch();
        this.history = keepHistory;
    }

    // --- static files -----------------------------------------------------

    static(res, route) {
        const wanted = route === '/' ? '/index.html' : route;
        const file = path.join(PUBLIC, path.normalize(wanted).replace(/^([/\\])+/, ''));

        // make sure the path stays inside PUBLIC
        if (!file.startsWith(PUBLIC)) {
            this.send(res, 403, { error: 'No.' });
            return;
        }

        fs.readFile(file, (err, data) => {
            if (err) {
                this.send(res, 404, { error: 'Not found.' });
                return;
            }
            res.writeHead(200, {
                'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
                'cache-control': 'no-store'
            });
            res.end(data);
        });
    }
}

module.exports = { WindowServer };
