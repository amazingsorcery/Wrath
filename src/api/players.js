'use strict';

const chatUtil = require('../utils/chat');

const ACTION = {
    ADD: 0,
    GAMEMODE: 1,
    LATENCY: 2,
    DISPLAY_NAME: 3,
    REMOVE: 4
};

/**
 * Tracks everyone the client can currently see: the tab list from
 * `player_info`, plus the entity ids from `named_entity_spawn` so plugins can
 * turn an entity id from another packet back into a player.
 */
class PlayerRegistry {
    constructor() {
        this.byUuid = new Map();
        this.byName = new Map();
        this.entityToUuid = new Map();
        this.overrides = new Map(); // uuid -> { prefix, suffix }
    }

    clear() {
        this.byUuid.clear();
        this.byName.clear();
        this.entityToUuid.clear();
    }

    /**
     * Apply an incoming player_info packet to the registry.
     * @returns {{added: object[], removed: object[]}}
     */
    applyPlayerInfo(packet) {
        const added = [];
        const removed = [];
        for (const entry of packet.data || []) {
            const uuid = entry.UUID;
            if (!uuid) continue;

            switch (packet.action) {
                case ACTION.ADD: {
                    const player = {
                        uuid,
                        name: entry.name,
                        properties: entry.properties || [],
                        gamemode: entry.gamemode,
                        ping: entry.ping,
                        displayName: entry.displayName || null,
                        entityId: null
                    };
                    this.byUuid.set(uuid, player);
                    if (player.name) this.byName.set(player.name.toLowerCase(), player);
                    added.push(player);
                    break;
                }
                case ACTION.GAMEMODE: {
                    const player = this.byUuid.get(uuid);
                    if (player) player.gamemode = entry.gamemode;
                    break;
                }
                case ACTION.LATENCY: {
                    const player = this.byUuid.get(uuid);
                    if (player) player.ping = entry.ping;
                    break;
                }
                case ACTION.DISPLAY_NAME: {
                    const player = this.byUuid.get(uuid);
                    if (player) player.displayName = entry.displayName || null;
                    break;
                }
                case ACTION.REMOVE: {
                    const player = this.byUuid.get(uuid);
                    if (player) {
                        this.byUuid.delete(uuid);
                        if (player.name) this.byName.delete(player.name.toLowerCase());
                        if (player.entityId !== null) this.entityToUuid.delete(player.entityId);
                        removed.push(player);
                    }
                    break;
                }
                default:
                    break;
            }
        }
        return { added, removed };
    }

    linkEntity(entityId, uuid) {
        this.entityToUuid.set(entityId, uuid);
        const player = this.byUuid.get(uuid);
        if (player) player.entityId = entityId;
    }

    unlinkEntity(entityId) {
        const uuid = this.entityToUuid.get(entityId);
        this.entityToUuid.delete(entityId);
        if (uuid) {
            const player = this.byUuid.get(uuid);
            if (player && player.entityId === entityId) player.entityId = null;
        }
    }

    get(nameOrUuid) {
        if (!nameOrUuid) return null;
        return this.byUuid.get(nameOrUuid) || this.byName.get(String(nameOrUuid).toLowerCase()) || null;
    }

    byEntityId(entityId) {
        const uuid = this.entityToUuid.get(entityId);
        return uuid ? this.byUuid.get(uuid) || null : null;
    }

    list() {
        return [...this.byUuid.values()];
    }

    // --- display name overrides -------------------------------------------

    setOverride(uuid, { prefix = '', suffix = '' } = {}) {
        if (!prefix && !suffix) this.overrides.delete(uuid);
        else this.overrides.set(uuid, { prefix, suffix });
    }

    getOverride(uuid) {
        return this.overrides.get(uuid) || null;
    }

    clearOverrides() {
        this.overrides.clear();
    }

    /** Build the display name JSON for a player, honouring any override. */
    renderDisplayName(uuid) {
        const player = this.byUuid.get(uuid);
        if (!player) return null;
        const override = this.overrides.get(uuid);
        const base = player.displayName ? chatUtil.toLegacy(player.displayName) : player.name;
        if (!override) return player.displayName || null;
        return chatUtil.serialize(`${override.prefix}${base}${override.suffix}`);
    }

    /**
     * Rewrite a player_info packet in place so overridden players show their
     * prefix and suffix in the tab list.
     */
    decorate(packet) {
        if (packet.action !== ACTION.ADD && packet.action !== ACTION.DISPLAY_NAME) return false;
        let changed = false;
        for (const entry of packet.data || []) {
            const override = this.overrides.get(entry.UUID);
            if (!override) continue;
            const player = this.byUuid.get(entry.UUID);
            const raw = entry.displayName || (player && player.displayName) || null;
            const base = raw ? chatUtil.toLegacy(raw) : entry.name || (player && player.name) || '';
            entry.displayName = chatUtil.serialize(`${override.prefix}${base}${override.suffix}`);
            changed = true;
        }
        return changed;
    }
}

module.exports = { PlayerRegistry, ACTION };
