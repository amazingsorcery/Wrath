'use strict';

const mc = require('minecraft-protocol');

const { PlayerRegistry } = require('./api/players');
const { TeamRegistry } = require('./api/teams');
const { ChatEvent, OutgoingChatEvent, PacketEvent, PlayerEvent, ConnectionEvent, ObservedEvent } = require('./packets/events');
const policy = require('./packets/policy');
const chatUtil = require('./utils/chat');
const { authDir } = require('./utils/paths');
const { AUTH_OPTIONS, announce } = require('./auth');
const { create } = require('./utils/logger');

const log = create('session');

/**
 * One player's trip through the proxy: the local client on one side, the real
 * server on the other, with plugin events in between.
 */
class PlayerSession {
    constructor(proxy, client) {
        this.proxy = proxy;
        this.api = proxy.api;
        this.client = client;
        this.target = null;

        this.username = client.username;
        this.uuid = client.uuid;
        this.players = new PlayerRegistry();
        this.self = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };
        this.selfEntityId = null;

        this.targetReady = false;
        this.closed = false;
        this.lastKick = null;

        // current game, from the sidebar title
        this.game = { mode: 'unknown', title: null };
        this.objectives = new Map();
        this.sidebarObjective = null;

        // teams (hypixel uses them for nametag colors)
        this.teams = new TeamRegistry();
        this.queue = [];
        this.startedAt = Date.now();

        // reconnect state
        this.attempts = 0;
        this.reconnecting = false;
        this.retryTimer = null;
        this.lastDimension = null;
        this.needsWorldReload = false;
        this.deliberate = false;

        this.client.on('packet', (data, meta) => this.onClientPacket(data, meta));
        this.client.on('end', () => this.close('client disconnected'));
        this.client.on('error', (err) => {
            log.warn(`Client error: ${err.message}`);
            this.close('client error');
        });
    }

    // --- lifecycle ---------------------------------------------------------

    connect() {
        const target = this.proxy.config.get('target');
        log.info(`${this.username} connecting to ${target.host}:${target.port}`);

        this.target = mc.createClient({
            host: target.host,
            port: target.port,
            version: '1.8.9',
            username: this.proxy.config.get('account', 'default'),
            auth: 'microsoft',
            profilesFolder: authDir(),
            // Pinned so this matches the cache written by `wrath login`.
            ...AUTH_OPTIONS,
            keepAlive: false,
            onMsaCode: announce
        });

        this.target.on('packet', (data, meta) => this.onTargetPacket(data, meta));

        this.target.on('login', () => this.onTargetLogin(target));

        this.target.on('end', (reason) => {
            this.api.emit('server_disconnect', new ConnectionEvent('server_disconnect', this, { reason }));
            if (this.tryReconnect(reason, target)) return;

            const explanation = this.explainDisconnect(reason, target);
            if (explanation.log) log.error(explanation.log);
            this.close(`server closed the connection${reason ? `: ${reason}` : ''}`, explanation.screen);
        });

        this.target.on('error', (err) => {
            // retry loop handles reconnect errors, only the first connect is fatal
            if (this.reconnecting || this.retryTimer) return;
            if (this.targetReady && this.tryReconnect(err.message, target)) return;
            log.error(`Server connection failed: ${err.message}`);
            this.disconnect(`§cWrath could not reach ${target.host}:${target.port}\n§7${err.message}`);
        });
    }

    /**
     * Join game packet. nmp fires 'login' for every join game and hypixel sends
     * one on every server switch, so only the first one is the real connection.
     */
    onTargetLogin(target) {
        const firstTime = !this.targetReady;
        const wasReconnecting = this.reconnecting;
        this.targetReady = true;
        this.flushQueue();

        if (wasReconnecting) {
            this.reconnecting = false;
            this.attempts = 0;
            // make the client drop the old world
            if (this.needsWorldReload) {
                this.forceWorldReload(this.lastDimension);
                this.needsWorldReload = false;
            }
            log.info(`Reconnected to ${target.host}:${target.port}.`);
            this.sendClientbound('title', { action: 3 });
            this.tell('§aReconnected.');
            this.api.emit('reconnected', new ConnectionEvent('reconnected', this, { host: target.host, port: target.port }));
            return;
        }

        if (!firstTime) return;

        log.info(`Connected to ${target.host}:${target.port} as ${this.target.username}`);
        this.api.emit('server_connect', new ConnectionEvent('server_connect', this, {
            host: target.host,
            port: target.port
        }));
    }

    /**
     * Try to reconnect without kicking the player. Only after a successful
     * first connection.
     *
     * @returns {boolean} true if a retry is scheduled
     */
    tryReconnect(reason, target) {
        if (this.closed || this.deliberate) return false;
        if (!this.targetReady) return false;
        if (!this.proxy.config.get('reconnect', true)) return false;

        const limit = this.proxy.config.get('reconnectAttempts', 5);
        if (this.attempts >= limit) {
            log.error(`Gave up reconnecting after ${limit} attempts.`);
            this.tell(`§cCould not get back to ${target.host} after ${limit} tries.`);
            return false;
        }

        this.attempts += 1;
        this.reconnecting = true;
        this.targetReady = false;

        // backoff, capped
        const delay = Math.min(1000 * (2 ** (this.attempts - 1)), 15000);
        log.warn(`Lost the server (${reason || 'no reason given'}). Reconnecting in ${Math.round(delay / 1000)}s, attempt ${this.attempts}/${limit}.`);

        this.tell(`§eLost the connection. §7Reconnecting in ${Math.round(delay / 1000)}s… §8(${this.attempts}/${limit})`);
        this.sendClientbound('title', { action: 2, fadeIn: 0, stay: 200, fadeOut: 10 });
        this.sendClientbound('title', { action: 0, text: chatUtil.serialize('§e§lRECONNECTING') });

        // Anything the old server told the client is now stale.
        this.players.clear();
        this.teams.clear();
        this.objectives.clear();

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.closed) return;
            try {
                if (this.target) this.target.removeAllListeners();
            } catch { /* already gone */ }
            this.connect();
        }, delay);
        if (this.retryTimer.unref) this.retryTimer.unref();
        return true;
    }

    /**
     * Vanilla ignores a join for the same dimension, so bounce through another
     * one to force a reload.
     */
    forceWorldReload(dimension) {
        const other = dimension === 0 ? -1 : 0;
        const common = { difficulty: 2, gamemode: 0, levelType: 'default' };
        this.sendClientbound('respawn', { dimension: other, ...common });
        this.sendClientbound('respawn', { dimension, ...common });
    }

    close(reason, clientMessage = null) {
        if (this.closed) return;
        this.closed = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        log.info(`Session ended for ${this.username} (${reason}).`);
        this.api.emit('session_end', new ConnectionEvent('session_end', this, { reason }));
        try {
            if (this.target) this.target.end();
        } catch { /* already gone */ }
        try {
            if (this.client && this.client.socket && !this.client.socket.destroyed) this.client.end(clientMessage || '');
        } catch { /* already gone */ }
        this.proxy.onSessionEnd(this);
    }

    /** Kick the local client with a visible reason. */
    disconnect(reason) {
        this.deliberate = true;
        try {
            this.client.end(reason);
        } catch { /* already gone */ }
        this.close('disconnected by proxy');
    }

    // --- packet output -----------------------------------------------------

    sendClientbound(name, data) {
        if (this.closed || !this.client || !this.client.socket || this.client.socket.destroyed) return false;
        try {
            this.client.write(name, data);
            return true;
        } catch (err) {
            log.warn(`Could not send ${name} to client: ${err.message}`);
            return false;
        }
    }

    sendServerbound(name, data) {
        if (this.closed) return false;
        if (!this.targetReady) {
            this.queue.push({ name, data });
            return true;
        }
        try {
            this.target.write(name, data);
            return true;
        } catch (err) {
            log.warn(`Could not send ${name} to server: ${err.message}`);
            return false;
        }
    }

    flushQueue() {
        const pending = this.queue;
        this.queue = [];
        for (const { name, data } of pending) {
            try {
                this.target.write(name, data);
            } catch (err) {
                log.warn(`Dropped queued ${name}: ${err.message}`);
            }
        }
    }

    // --- serverbound (client -> server) ------------------------------------

    onClientPacket(data, meta) {
        if (meta.state !== mc.states.PLAY || this.closed) return;

        if (meta.name === 'position' || meta.name === 'position_look') {
            this.self.x = data.x;
            this.self.y = data.y;
            this.self.z = data.z;
        }
        if (meta.name === 'look' || meta.name === 'position_look') {
            this.self.yaw = data.yaw;
            this.self.pitch = data.pitch;
        }

        if (meta.name === 'chat') {
            if (this.proxy.commands.handle(data.message, this)) return;
            const event = new OutgoingChatEvent(data, this);
            this.api.emit('outgoing_chat', event);
            this.api.emit('packet:chat:serverbound', event);
            if (event.cancelled) return;
        } else if (policy.canMutate('serverbound', meta.name) && this.hasListeners(`packet:${meta.name}:serverbound`)) {
            const event = new PacketEvent(meta.name, data, 'serverbound', this);
            this.api.emit(`packet:${meta.name}:serverbound`, event);
            if (event.cancelled) return;
        }

        this.sendServerbound(meta.name, data);
    }

    // --- clientbound (server -> client) ------------------------------------

    onTargetPacket(data, meta) {
        if (meta.state !== mc.states.PLAY || this.closed) return;

        switch (meta.name) {
            case 'login': {
                // same dimension join gets ignored, flag it for a forced reload
                this.needsWorldReload = this.reconnecting && this.lastDimension === data.dimension;
                this.selfEntityId = data.entityId;
                this.lastDimension = data.dimension;
                this.players.clear();
                this.objectives.clear();
                this.sidebarObjective = null;
                this.teams.clear();
                this.setGameMode('unknown', null);
                this.api.emit('world_change', new ConnectionEvent('world_change', this, { dimension: data.dimension, reason: 'join' }));
                break;
            }
            case 'respawn':
                this.api.emit('world_change', new ConnectionEvent('world_change', this, { dimension: data.dimension, reason: 'respawn' }));
                break;
            case 'position':
                this.self.x = data.x;
                this.self.y = data.y;
                this.self.z = data.z;
                break;
            case 'named_entity_spawn':
                this.players.linkEntity(data.entityId, data.playerUUID);
                break;
            case 'entity_destroy':
                for (const id of data.entityIds || []) this.players.unlinkEntity(id);
                break;
            case 'player_info':
                this.handlePlayerInfo(data);
                break;
            case 'scoreboard_objective':
                // action 0 creates, 2 updates; both carry the display title.
                if (data.action === 0 || data.action === 2) {
                    this.objectives.set(data.name, data.displayText);
                    if (data.name === this.sidebarObjective) this.refreshGameMode();
                } else if (data.action === 1) {
                    this.objectives.delete(data.name);
                }
                break;
            case 'scoreboard_team':
                this.teams.apply(data);
                break;
            case 'scoreboard_display_objective':
                // Position 1 is the sidebar.
                if (data.position === 1) {
                    this.sidebarObjective = data.name || null;
                    this.refreshGameMode();
                }
                break;
            case 'kick_disconnect':
                this.lastKick = chatUtil.toLegacy(data.reason);
                log.warn(`Server kicked us: ${chatUtil.strip(this.lastKick)}`);
                break;
            default:
                break;
        }

        // read-only watchers first
        if (policy.canObserve(meta.name) && this.hasListeners(`observe:${meta.name}`)) {
            this.api.emit(`observe:${meta.name}`, new ObservedEvent(meta.name, data, this));
        }

        if (meta.name === 'chat') {
            const event = new ChatEvent(data, this);
            this.api.emit('chat', event);
            this.api.emit('packet:chat:clientbound', event);
            if (event.cancelled) return;
        } else if (policy.canMutate('clientbound', meta.name) && this.hasListeners(`packet:${meta.name}:clientbound`)) {
            const event = new PacketEvent(meta.name, data, 'clientbound', this);
            this.api.emit(`packet:${meta.name}:clientbound`, event);
            if (event.cancelled) return;
        }

        this.sendClientbound(meta.name, data);
    }

    /** Work the game out from the sidebar title and announce any change. */
    refreshGameMode() {
        const raw = this.sidebarObjective ? this.objectives.get(this.sidebarObjective) : null;
        const title = raw === undefined || raw === null ? null : chatUtil.strip(chatUtil.toLegacy(raw)).trim();
        this.setGameMode(PlayerSession.modeFromTitle(title), title);
    }

    setGameMode(mode, title) {
        if (this.game.mode === mode && this.game.title === title) return;
        const previous = this.game.mode;
        this.game = { mode, title };
        this.api.emit('game_change', new ConnectionEvent('game_change', this, { mode, title, previous }));
    }

    /** Map a sidebar title to a known Hypixel game. */
    static modeFromTitle(title) {
        if (!title) return 'unknown';
        const upper = title.toUpperCase();
        if (/BED\s*WARS/.test(upper)) return 'bedwars';
        if (/SKY\s*WARS/.test(upper)) return 'skywars';
        if (/DUELS?/.test(upper)) return 'duels';
        if (/MURDER/.test(upper)) return 'murder';
        if (/SKYBLOCK/.test(upper)) return 'skyblock';
        if (/BUILD\s*BATTLE/.test(upper)) return 'buildbattle';
        if (/ARCADE/.test(upper)) return 'arcade';
        if (/HYPIXEL/.test(upper)) return 'lobby';
        return 'unknown';
    }

    handlePlayerInfo(packet) {
        const { added, removed } = this.players.applyPlayerInfo(packet);
        this.players.decorate(packet);
        for (const player of added) {
            this.api.emit('player_join', new PlayerEvent('player_join', player, this));
        }
        for (const player of removed) {
            this.api.emit('player_leave', new PlayerEvent('player_leave', player, this));
        }
    }

    // --- helpers -----------------------------------------------------------

    /**
     * Turn socket errors into a readable reason. Mainly: closed before login
     * finished = the server refused us.
     */
    explainDisconnect(reason, target) {
        const where = `${target.host}:${target.port}`;

        if (this.lastKick) {
            return { log: null, screen: `§cKicked by ${target.host}

§r${this.lastKick}` };
        }

        if (!this.targetReady) {
            return {
                log: `${where} closed the connection before login finished. Run "node src/index.js check" for details.`,
                screen: [
                    `§cCould not log in to ${target.host}`,
                    '',
                    '§7The server closed the connection before login finished.',
                    '§7Wrath never got to send anything, so this is the server',
                    '§7refusing this network rather than a proxy fault.',
                    '',
                    `§7Try joining §f${target.host}§7 directly without Wrath.`,
                    '§7If that fails too, the block is not caused by Wrath.'
                ].join('\n')
            };
        }

        return { log: null, screen: `§cDisconnected from ${target.host}
§7${reason || 'connection closed'}` };
    }

    hasListeners(eventName) {
        const list = this.api.listeners.get(eventName);
        if (list && list.length) return true;
        const wildcard = this.api.listeners.get('*');
        return Boolean(wildcard && wildcard.length);
    }

    selfInfo() {
        return {
            uuid: this.uuid,
            name: this.username,
            entityId: this.selfEntityId,
            position: { ...this.self }
        };
    }

    /** Convenience used by the proxy and commands to talk to the player. */
    tell(text) {
        return this.sendClientbound('chat', { message: chatUtil.serialize(text), position: 0 });
    }
}

module.exports = { PlayerSession };
