'use strict';

const fs = require('fs');
const { configFile } = require('./utils/paths');
const { writeJsonAtomic, readJsonSafe } = require('./utils/atomic');
const { create } = require('./utils/logger');

const log = create('config');

const DEFAULTS = {
    proxyPort: 25565,
    target: { host: 'mc.hypixel.net', port: 25565 },
    account: 'default',
    hypixelKey: null,
    urchinKey: null,
    theme: { primary: 'c', accent: '6' },
    commandPrefix: '/wrath',
    // off so we don't shadow hypixel's commands, use /wrath <cmd>
    interceptPluginCommands: false,
    logLevel: 'info',
    logFile: true,
    reconnect: true,
    reconnectAttempts: 5,
    motd: '§4Wrath §8| §7local proxy',
    plugins: {}
};

function merge(base, override) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [key, value] of Object.entries(override || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object' && base[key] !== null) {
            out[key] = merge(base[key], value);
        } else if (value !== undefined) {
            out[key] = value;
        }
    }
    return out;
}

class Config {
    constructor() {
        this.path = configFile();
        this.data = this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.path)) {
                const fresh = merge(DEFAULTS, {});
                writeJsonAtomic(this.path, fresh);
                return fresh;
            }
            const stored = readJsonSafe(this.path, null);
            if (stored === null) {
                // keep the broken file instead of overwriting it
                log.error(`${this.path} is not valid JSON. Using defaults; the file is left alone.`);
                return merge(DEFAULTS, {});
            }
            return merge(DEFAULTS, stored);
        } catch (err) {
            log.error(`Could not read ${this.path}, using defaults:`, err.message);
            return merge(DEFAULTS, {});
        }
    }

    save() {
        try {
            writeJsonAtomic(this.path, this.data);
            return true;
        } catch (err) {
            log.error('Could not write config:', err.message);
            return false;
        }
    }

    get(pathString, fallback) {
        const parts = pathString.split('.');
        let node = this.data;
        for (const part of parts) {
            if (node === null || typeof node !== 'object' || !(part in node)) return fallback;
            node = node[part];
        }
        return node === undefined ? fallback : node;
    }

    set(pathString, value) {
        const parts = pathString.split('.');
        const last = parts.pop();
        let node = this.data;
        for (const part of parts) {
            if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
            node = node[part];
        }
        node[last] = value;
        this.save();
        return value;
    }

    pluginEnabled(name) {
        const entry = this.data.plugins[name];
        return entry ? entry.enabled !== false : true;
    }

    setPluginEnabled(name, enabled) {
        if (!this.data.plugins[name]) this.data.plugins[name] = {};
        this.data.plugins[name].enabled = enabled;
        this.save();
    }
}

module.exports = { Config, DEFAULTS };
