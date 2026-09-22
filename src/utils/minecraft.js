'use strict';

const mcData = require('minecraft-data')('1.8.9');

/**
 * Game data for plugins, resolved in core since plugins can't require
 * packages (the plugins folder can be anywhere).
 */

const particleList = mcData.particlesArray || [];

const particles = {
    byName: new Map(particleList.map((entry) => [entry.name.toLowerCase(), entry.id])),
    byId: new Map(particleList.map((entry) => [entry.id, entry.name])),
    names: particleList.map((entry) => entry.name),

    /** Resolve a particle name to its 1.8 numeric id, or null. */
    id(name) {
        const found = particles.byName.get(String(name).toLowerCase());
        return found === undefined ? null : found;
    },

    /** Resolve a list of names to ids, dropping anything unknown. */
    ids(names) {
        return names.map((name) => particles.id(name)).filter((id) => id !== null);
    }
};

module.exports = { particles, version: '1.8.9', protocolVersion: 47 };
