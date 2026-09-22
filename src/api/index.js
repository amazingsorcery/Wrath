'use strict';

const fs = require('fs');
const path = require('path');

const { PluginContext } = require('./context');
const { PlayerRegistry } = require('./players');
const { pluginsDir } = require('../utils/paths');
const { create } = require('../utils/logger');
const { PolicyError } = require('../packets/policy');

/**
 * Loads plugin files, hands each one a PluginContext, and dispatches events.
 * Dispatch is synchronous because it sits directly in the packet path.
 */
class PluginAPI {
    constructor(proxy) {
        this.proxy = proxy;
        this.storage = proxy.storage;
        this.commands = proxy.commands;
        this.log = create('plugins');
        this.plugins = new Map();
        this.listeners = new Map(); // eventName -> [{plugin, handler, once}]
        this.session = null;
        this.emptyRegistry = new PlayerRegistry();
        // service registry so plugins can share stuff (e.g. the nick resolver)
        this.shared = new Map();
        this.sharedOwners = new Map();
        this.errors = [];
    }

    // --- loading -----------------------------------------------------------

    loadAll() {
        const dir = pluginsDir();
        let files;
        try {
            files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
        } catch (err) {
            this.log.error('Could not read plugins directory:', err.message);
            return;
        }

        for (const file of files.sort()) {
            this.loadFile(path.join(dir, file));
        }

        const active = [...this.plugins.values()].filter((p) => p.enabled).length;
        this.log.info(`Loaded ${active} plugin${active === 1 ? '' : 's'} (${this.plugins.size} found).`);
    }

    loadFile(file) {
        const base = path.basename(file, '.js');
        let module_;
        try {
            delete require.cache[require.resolve(file)];
            module_ = require(file);
        } catch (err) {
            this.log.error(`Failed to load ${base}:`, err.message);
            this.recordError(base, `failed to load: ${err.message}`);
            return null;
        }

        const definition = module_ && module_.default ? module_.default : module_;
        if (!definition || typeof definition.init !== 'function') {
            this.log.error(`Skipping ${base}: a plugin must export an object with an init(ctx) function.`);
            return null;
        }

        const name = definition.name || base;
        if (this.plugins.has(name)) {
            this.log.warn(`Duplicate plugin name "${name}" from ${base}, skipping.`);
            return null;
        }

        const plugin = {
            name,
            version: definition.version || '0.0.0',
            author: definition.author || 'unknown',
            description: definition.description || '',
            file,
            definition,
            meta: { ...definition },
            enabled: this.proxy.config.pluginEnabled(name),
            context: null
        };
        this.plugins.set(name, plugin);

        if (plugin.enabled) this.start(plugin);
        else this.log.info(`${name} is disabled.`);
        return plugin;
    }

    start(plugin) {
        try {
            plugin.context = new PluginContext(this, plugin);
            plugin.definition.init(plugin.context);
            plugin.enabled = true;
            this.log.info(`Enabled ${plugin.name} v${plugin.version}`);
            return true;
        } catch (err) {
            this.recordError(plugin.name, `init failed: ${err.message}`);
            this.log.error(`${plugin.name} failed during init:`, err);
            this.stop(plugin);
            plugin.enabled = false;
            return false;
        }
    }

    stop(plugin) {
        if (!plugin) return;
        try {
            if (typeof plugin.definition.unload === 'function' && plugin.context) {
                plugin.definition.unload(plugin.context);
            }
        } catch (err) {
            this.log.error(`${plugin.name} threw while unloading:`, err.message);
        }
        if (plugin.context) plugin.context.dispose();
        this.removePluginListeners(plugin.name);
        this.removePluginShared(plugin.name);
        this.commands.unregisterPlugin(plugin.name);
        plugin.context = null;
        plugin.enabled = false;
    }

    enable(name) {
        const plugin = this.plugins.get(name);
        if (!plugin) return { ok: false, error: `No plugin named "${name}".` };
        if (plugin.enabled) return { ok: false, error: `${name} is already enabled.` };
        this.proxy.config.setPluginEnabled(name, true);
        return this.start(plugin) ? { ok: true } : { ok: false, error: `${name} failed to start.` };
    }

    disable(name) {
        const plugin = this.plugins.get(name);
        if (!plugin) return { ok: false, error: `No plugin named "${name}".` };
        if (!plugin.enabled) return { ok: false, error: `${name} is already disabled.` };
        this.stop(plugin);
        this.proxy.config.setPluginEnabled(name, false);
        return { ok: true };
    }

    reloadAll() {
        for (const plugin of this.plugins.values()) this.stop(plugin);
        this.plugins.clear();
        this.listeners.clear();
        this.shared.clear();
        this.sharedOwners.clear();
        this.loadAll();
        if (this.session) this.emit('session_start', { session: this.session, type: 'session_start' });
    }

    // --- listeners ---------------------------------------------------------

    addListener(pluginName, eventName, handler, once) {
        if (typeof handler !== 'function') throw new TypeError('Event handler must be a function.');
        if (!this.listeners.has(eventName)) this.listeners.set(eventName, []);
        this.listeners.get(eventName).push({ plugin: pluginName, handler, once });
    }

    removeListener(pluginName, eventName, handler) {
        const list = this.listeners.get(eventName);
        if (!list) return;
        this.listeners.set(
            eventName,
            list.filter((entry) => !(entry.plugin === pluginName && entry.handler === handler))
        );
    }

    removePluginListeners(pluginName) {
        for (const [eventName, list] of this.listeners) {
            this.listeners.set(eventName, list.filter((entry) => entry.plugin !== pluginName));
        }
    }

    /** Dispatch an event. Errors are caught so one plugin can't break the packet stream. */
    emit(eventName, event) {
        const lists = [this.listeners.get(eventName), this.listeners.get('*')];
        for (const list of lists) {
            if (!list || list.length === 0) continue;
            for (const entry of [...list]) {
                if (entry.once) this.removeListener(entry.plugin, eventName, entry.handler);
                try {
                    entry.handler(event);
                } catch (err) {
                    this.recordError(entry.plugin, `${eventName}: ${err.message}`);
                    if (err instanceof PolicyError) this.log.error(err.message);
                    else this.log.error(`${entry.plugin} threw handling "${eventName}":`, err);
                }
            }
        }
        return event;
    }

    /** Publish a service other plugins can look up. */
    setShared(pluginName, key, value) {
        this.shared.set(key, value);
        this.sharedOwners.set(key, pluginName);
    }

    /** Remove everything a plugin published. */
    removePluginShared(pluginName) {
        for (const [key, owner] of [...this.sharedOwners]) {
            if (owner !== pluginName) continue;
            this.shared.delete(key);
            this.sharedOwners.delete(key);
        }
    }

    /** Last few plugin errors, for showing in game. */
    recordError(plugin, message) {
        this.errors.unshift({ plugin, message, at: Date.now() });
        if (this.errors.length > 20) this.errors.length = 20;
    }

    list() {
        return [...this.plugins.values()].map((p) => ({
            name: p.name,
            version: p.version,
            author: p.author,
            description: p.description,
            enabled: p.enabled
        }));
    }
}

module.exports = PluginAPI;
module.exports.PluginAPI = PluginAPI;
