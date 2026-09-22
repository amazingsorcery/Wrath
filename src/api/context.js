'use strict';

const chatUtil = require('../utils/chat');
const policy = require('../packets/policy');
const { UI } = require('./ui');
const rules = require('./rules');
const minecraft = require('../utils/minecraft');
const font = require('../utils/font');

const TITLE_ACTION = { TITLE: 0, SUBTITLE: 1, TIMES: 2, CLEAR: 3, RESET: 4 };

/**
 * Object passed to each plugin's init. No raw socket access, all packet calls
 * go through the policy.
 */
class PluginContext {
    constructor(api, plugin) {
        this._api = api;
        this._plugin = plugin;
        this.name = plugin.name;
        this.version = plugin.version;
        this.meta = plugin.meta;
        this.log = api.log.child(plugin.name);
        this.store = api.storage.forPlugin(plugin.name);
        this._timers = new Set();

        this.commands = {
            register: (name, options) => api.commands.register(name, { ...options, plugin: plugin.name }),
            unregister: (name) => api.commands.unregister(name, plugin.name)
        };

        // how commands have to be typed right now (ctx.ui already fixes these)
        this.cmd = (name) => api.proxy.commands.invocation(String(name).replace(/^\//, ''));

        // Which Hypixel game you are in right now.
        this.game = {
            get mode() {
                return api.session ? api.session.game.mode : 'unknown';
            },
            get title() {
                return api.session ? api.session.game.title : null;
            }
        };

        // teams
        const teamsOf = () => (api.session ? api.session.teams : null);
        this.teams = {
            of: (playerName) => {
                const registry = teamsOf();
                return registry ? registry.of(playerName) : null;
            },
            list: () => {
                const registry = teamsOf();
                return registry ? registry.list() : [];
            },
            sameTeam: (a, b) => {
                const registry = teamsOf();
                return registry ? registry.sameTeam(a, b) : false;
            },
            /** True when that player is on your side. */
            isTeammate: (playerName) => {
                const registry = teamsOf();
                const me = api.session ? api.session.username : null;
                return registry && me ? registry.sameTeam(me, playerName) : false;
            },
            get self() {
                const registry = teamsOf();
                const me = api.session ? api.session.username : null;
                return registry && me ? registry.of(me) : null;
            }
        };

        this.players = {
            list: () => this._registry().list(),
            get: (nameOrUuid) => this._registry().get(nameOrUuid),
            byEntityId: (id) => this._registry().byEntityId(id),
            get self() {
                return api.session ? api.session.selfInfo() : null;
            }
        };

        this.display = {
            set: (target, options) => this._setDisplay(target, options),
            clear: (target) => this._setDisplay(target, { prefix: '', suffix: '' }),
            get: (target) => {
                const player = this._registry().get(target);
                return player ? this._registry().getOverride(player.uuid) : null;
            }
        };

        this.chat = {
            send: (text) => this.send(text),
            actionBar: (text) => this.actionBar(text),
            title: (...args) => this.title(...args),
            clearTitle: () => this.clearTitle(),
            toServer: (message) => this.sendToServer(message)
        };

        this.sound = {
            play: (soundName, options) => this.playSound(soundName, options)
        };

        // hypixel api (checks tab list first to skip mojang lookups)
        const resolve = (target) => {
            const known = this._registry().get(target);
            return known && known.uuid ? known.uuid.replace(/-/g, '') : target;
        };
        this.hypixel = {
            get enabled() {
                return api.proxy.hypixel.enabled;
            },
            get rateLimit() {
                return { ...api.proxy.hypixel.rate };
            },
            player: (target) => api.proxy.hypixel.player(resolve(target)),
            playerRaw: (target) => api.proxy.hypixel.playerRaw(resolve(target)),
            status: (target) => api.proxy.hypixel.status(resolve(target)),
            guild: (target) => api.proxy.hypixel.guild(resolve(target)),
            recentGames: (target) => api.proxy.hypixel.recentGames(resolve(target)),
            uuidOf: (target) => api.proxy.hypixel.uuidOf(resolve(target)),
            batch: (targets, options) => api.proxy.hypixel.batch(targets.map(resolve), options)
        };

        this.urchin = {
            get enabled() {
                return api.proxy.urchin.enabled;
            },
            lookup: (names, options) => api.proxy.urchin.lookup(names, options),
            player: (name) => api.proxy.urchin.player(name),
            addTag: (uuid, type, reason, options) => api.proxy.urchin.addTag(uuid, type, reason, options),
            winstreaks: (target) => api.proxy.urchin.winstreaks(resolve(target)),
            session: (target, period) => api.proxy.urchin.session(resolve(target), period),
            highest: (tags) => require('../urchin').UrchinAPI.highest(tags),
            describe: (type) => require('../urchin').describeTag(type)
        };

        // services from other plugins
        this.shared = {
            set: (key, value) => api.setShared(plugin.name, key, value),
            get: (key) => api.shared.get(key),
            has: (key) => api.shared.has(key)
        };

        this.util = chatUtil;
        // so plugins don't need require
        this.rules = rules;
        this.minecraft = minecraft;
        this.font = font;
        this.ui = new UI(this);
    }

    // --- internals ---------------------------------------------------------

    _registry() {
        return this._api.session ? this._api.session.players : this._api.emptyRegistry;
    }

    _session() {
        return this._api.session;
    }

    get connected() {
        const session = this._session();
        return Boolean(session && session.targetReady);
    }

    get target() {
        return this._api.proxy.config.get('target');
    }

    // --- events ------------------------------------------------------------

    on(eventName, handler) {
        this._api.addListener(this._plugin.name, eventName, handler, false);
        return this;
    }

    once(eventName, handler) {
        this._api.addListener(this._plugin.name, eventName, handler, true);
        return this;
    }

    /** Read-only packet listener (used for movement). Gets a frozen copy. */
    observe(packetName, handler) {
        if (!policy.canObserve(packetName)) {
            throw new policy.PolicyError(
                `Plugin "${this._plugin.name}" tried to observe "${packetName}", which is not an observable packet.`
            );
        }
        this._api.addListener(this._plugin.name, `observe:${packetName}`, handler, false);
        return this;
    }

    off(eventName, handler) {
        this._api.removeListener(this._plugin.name, eventName, handler);
        return this;
    }

    /**
     * Emit a plugin event. Namespaced, so ctx.emit('scan') from autostats
     * becomes 'autostats:scan'.
     */
    emit(eventName, payload = {}) {
        const full = `${this._plugin.name}:${eventName}`;
        this._api.emit(full, { type: full, plugin: this._plugin.name, session: this._session(), ...payload });
        return this;
    }

    // --- timers (cleared automatically when the plugin unloads) -------------

    schedule(fn, ms) {
        const timer = setTimeout(() => {
            this._timers.delete(timer);
            this._guard(fn);
        }, ms);
        this._timers.add(timer);
        return timer;
    }

    interval(fn, ms) {
        const timer = setInterval(() => this._guard(fn), ms);
        this._timers.add(timer);
        return timer;
    }

    clear(timer) {
        clearTimeout(timer);
        clearInterval(timer);
        this._timers.delete(timer);
    }

    _guard(fn) {
        try {
            fn();
        } catch (err) {
            this.log.error('Timer threw:', err);
        }
    }

    dispose() {
        for (const timer of this._timers) {
            clearTimeout(timer);
            clearInterval(timer);
        }
        this._timers.clear();
    }

    // --- packet output (policy checked) ------------------------------------

    write(direction, name, data) {
        policy.assertInject(direction, name, this._plugin.name);
        const session = this._session();
        if (!session) return false;
        return direction === 'clientbound'
            ? session.sendClientbound(name, data)
            : session.sendServerbound(name, data);
    }

    /** Show a message in the player's chat box. The server never sees it. */
    send(text) {
        return this.write('clientbound', 'chat', {
            message: chatUtil.serialize(text),
            position: 0
        });
    }

    /** Show a message above the hotbar. */
    actionBar(text) {
        return this.write('clientbound', 'chat', {
            message: chatUtil.serialize(text),
            position: 2
        });
    }

    /** Send a chat message or command to the server as the player. */
    sendToServer(message) {
        return this.write('serverbound', 'chat', { message: String(message).slice(0, 100) });
    }

    title(title, subtitle = null, times = {}) {
        const { fadeIn = 10, stay = 40, fadeOut = 10 } = times;
        this.write('clientbound', 'title', {
            action: TITLE_ACTION.TIMES,
            fadeIn,
            stay,
            fadeOut
        });
        if (subtitle !== null && subtitle !== undefined) {
            this.write('clientbound', 'title', {
                action: TITLE_ACTION.SUBTITLE,
                text: chatUtil.serialize(subtitle)
            });
        }
        return this.write('clientbound', 'title', {
            action: TITLE_ACTION.TITLE,
            text: chatUtil.serialize(title)
        });
    }

    clearTitle() {
        return this.write('clientbound', 'title', { action: TITLE_ACTION.CLEAR });
    }

    /**
     * Play a sound to the local player only.
     * @param {string} soundName e.g. "note.pling", "random.orb"
     */
    playSound(soundName, { volume = 1, pitch = 63, position = null } = {}) {
        const session = this._session();
        const at = position || (session ? session.self : null) || { x: 0, y: 64, z: 0 };
        return this.write('clientbound', 'named_sound_effect', {
            soundName,
            x: Math.round(at.x * 8),
            y: Math.round(at.y * 8),
            z: Math.round(at.z * 8),
            volume,
            pitch: Math.max(0, Math.min(255, Math.round(pitch)))
        });
    }

    _setDisplay(target, options) {
        const registry = this._registry();
        const player = registry.get(target);
        if (!player) return false;
        registry.setOverride(player.uuid, options);
        const displayName = registry.renderDisplayName(player.uuid);
        return this.write('clientbound', 'player_info', {
            action: 3,
            data: [{ UUID: player.uuid, displayName: displayName || chatUtil.serialize(player.name) }]
        });
    }
}

module.exports = { PluginContext, TITLE_ACTION };
