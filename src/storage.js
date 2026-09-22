'use strict';

const fs = require('fs');
const path = require('path');
const { pluginDataDir } = require('./utils/paths');
const { writeJsonAtomic, readJsonSafe } = require('./utils/atomic');
const { create } = require('./utils/logger');

const log = create('storage');

/**
 * A small JSON-backed key/value store handed to each plugin. Writes are
 * debounced so a plugin that saves on every packet does not thrash the disk.
 */
class Store {
    constructor(file, defaults = {}) {
        this.file = file;
        this.defaults = defaults;
        this.dirty = false;
        this.timer = null;
        this.data = this.read();
    }

    read() {
        const stored = readJsonSafe(this.file, null);
        if (stored === null && fs.existsSync(this.file)) {
            log.warn(`Corrupt store ${path.basename(this.file)}, starting empty.`);
        }
        return { ...this.defaults, ...(stored || {}) };
    }

    get(key, fallback) {
        return key === undefined ? this.data : this.data[key] !== undefined ? this.data[key] : fallback;
    }

    set(key, value) {
        this.data[key] = value;
        this.queueSave();
        return value;
    }

    delete(key) {
        delete this.data[key];
        this.queueSave();
    }

    all() {
        return this.data;
    }

    queueSave() {
        this.dirty = true;
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, 500);
        if (this.timer.unref) this.timer.unref();
    }

    flush() {
        if (!this.dirty) return;
        try {
            writeJsonAtomic(this.file, this.data);
            this.dirty = false;
        } catch (err) {
            log.error(`Could not save ${path.basename(this.file)}:`, err.message);
        }
    }
}

class Storage {
    constructor() {
        this.stores = new Map();
    }

    forPlugin(name, defaults) {
        if (!this.stores.has(name)) {
            this.stores.set(name, new Store(path.join(pluginDataDir(), `${name}.json`), defaults));
        }
        return this.stores.get(name);
    }

    flushAll() {
        for (const store of this.stores.values()) store.flush();
    }
}

module.exports = { Storage, Store };
