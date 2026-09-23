'use strict';

const chatUtil = require('../utils/chat');

/**
 * Tracks scoreboard teams. Hypixel uses them for nametag colors, so they
 * also tell you who's on which team.
 *
 * Modes: 0 create, 1 remove, 2 update, 3 add players, 4 remove players
 */

const MODE = { CREATE: 0, REMOVE: 1, UPDATE: 2, ADD_PLAYERS: 3, REMOVE_PLAYERS: 4 };

// The team `color` field is an index into the chat formatting codes.
const COLOUR_CODES = '0123456789abcdef';

/** Pull the first colour code out of a prefix, which is where Hypixel puts it. */
function colourFromPrefix(prefix) {
    if (!prefix) return null;
    const match = /§([0-9a-f])/i.exec(String(prefix));
    return match ? match[1].toLowerCase() : null;
}

function colourFromIndex(index) {
    if (typeof index !== 'number' || index < 0 || index > 15) return null;
    return COLOUR_CODES[index];
}

/**
 * Short team label like "R" for Red. Strips formatting from the prefix
 * ("§c§l[R] "), falls back to the team name.
 */
function labelFor(prefix, teamKey) {
    const stripped = chatUtil.strip(String(prefix || '')).replace(/[^A-Za-z0-9]/g, '');
    if (stripped) return stripped.slice(0, 2).toUpperCase();
    const key = String(teamKey || '').replace(/[^A-Za-z0-9]/g, '');
    return key ? key.slice(0, 2).toUpperCase() : '?';
}

class TeamRegistry {
    constructor() {
        this.teams = new Map(); // team key -> team
        this.membership = new Map(); // lowercase player name -> team key
    }

    clear() {
        this.teams.clear();
        this.membership.clear();
    }

    /**
     * Apply one scoreboard_team packet.
     * @returns {boolean} whether anything changed
     */
    apply(packet) {
        const key = packet.team;
        if (!key) return false;

        if (packet.mode === MODE.REMOVE) {
            const team = this.teams.get(key);
            if (!team) return false;
            for (const member of team.members) this.membership.delete(member);
            this.teams.delete(key);
            return true;
        }

        if (packet.mode === MODE.CREATE || packet.mode === MODE.UPDATE) {
            const existing = this.teams.get(key);
            const team = existing || { key, members: new Set() };
            team.displayName = packet.name === undefined ? team.displayName : packet.name;
            team.prefix = packet.prefix === undefined ? team.prefix : packet.prefix;
            team.suffix = packet.suffix === undefined ? team.suffix : packet.suffix;
            team.colour = colourFromPrefix(team.prefix) || colourFromIndex(packet.color) || '7';
            team.label = labelFor(team.prefix, key);
            this.teams.set(key, team);
        }

        const team = this.teams.get(key);
        if (!team) return false;

        if (packet.mode === MODE.CREATE || packet.mode === MODE.ADD_PLAYERS) {
            for (const raw of packet.players || []) {
                const name = String(raw).toLowerCase();
                // players can only be on one team
                const previous = this.membership.get(name);
                if (previous && previous !== key) {
                    const old = this.teams.get(previous);
                    if (old) old.members.delete(name);
                }
                team.members.add(name);
                this.membership.set(name, key);
            }
            return true;
        }

        if (packet.mode === MODE.REMOVE_PLAYERS) {
            for (const raw of packet.players || []) {
                const name = String(raw).toLowerCase();
                team.members.delete(name);
                if (this.membership.get(name) === key) this.membership.delete(name);
            }
            return true;
        }

        return true;
    }

    /** The team a player is on, or null. */
    of(playerName) {
        if (!playerName) return null;
        const key = this.membership.get(String(playerName).toLowerCase());
        return key ? this.teams.get(key) || null : null;
    }

    /** Are these two players on the same team? */
    sameTeam(a, b) {
        const first = this.of(a);
        const second = this.of(b);
        return Boolean(first && second && first.key === second.key);
    }

    /** Every team that currently has members, largest first. */
    list() {
        return [...this.teams.values()]
            .filter((team) => team.members.size > 0)
            .sort((a, b) => b.members.size - a.members.size);
    }

    get size() {
        return this.list().length;
    }
}

module.exports = { TeamRegistry, MODE, labelFor, colourFromPrefix };
