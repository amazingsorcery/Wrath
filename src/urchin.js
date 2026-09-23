'use strict';

const { create } = require('./utils/logger');

const log = create('urchin');

// urchin.ws is dead, it's the Coral API now. see https://api.urchin.gg/openapi.json
const API_BASE = 'https://api.urchin.gg/v3';
const BATCH_LIMIT = 100;
const TTL = 5 * 60 * 1000;

/** Tag types by severity. */
const TAG_TYPES = {
    confirmed_cheater: { icon: 'CCC', colour: '5', label: 'Confirmed cheater', severity: 100 },
    blatant_cheater: { icon: 'BC', colour: '6', label: 'Blatant cheater', severity: 90 },
    closet_cheater: { icon: 'CC', colour: '6', label: 'Closet cheater', severity: 80 },
    sniper: { icon: 'S', colour: '4', label: 'Sniper', severity: 70 },
    legit_sniper: { icon: 'LS', colour: 'c', label: 'Legit sniper', severity: 60 },
    caution: { icon: 'C', colour: '6', label: 'Caution', severity: 50 },
    account: { icon: 'A', colour: '6', label: 'Account note', severity: 20 },
    info: { icon: 'I', colour: '7', label: 'Info', severity: 10 }
};

const UNKNOWN_TAG = { icon: '?', colour: 'f', label: 'Unknown', severity: 0 };

/** Short forms accepted when submitting a tag. */
const SHORT_FORMS = {
    i: 'info',
    c: 'caution',
    cc: 'closet_cheater',
    bc: 'blatant_cheater',
    ccc: 'confirmed_cheater',
    a: 'account',
    s: 'sniper',
    ls: 'legit_sniper'
};

const describeTag = (type) => TAG_TYPES[String(type || '').toLowerCase()] || UNKNOWN_TAG;

const bare = (uuid) => String(uuid || '').replace(/-/g, '').toLowerCase();

class UrchinError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'UrchinError';
        this.status = status;
    }
}

/** Normalise a tag from the API into the shape the rest of Wrath uses. */
function normaliseTag(tag) {
    if (!tag || typeof tag !== 'object') return { type: 'info', reason: String(tag), addedOn: null };
    const type = String(tag.tag_type || tag.type || 'info').toLowerCase();
    return {
        type,
        reason: tag.reason || '',
        addedOn: tag.added_on || null,
        addedBy: tag.added_by_username || null,
        expiresAt: tag.expires_at || null,
        hidden: Boolean(tag.hide_username),
        meta: describeTag(type)
    };
}

/** Pick the useful fields out of a session diff (the rest is noise). */
function summariseDelta(delta) {
    const at = (...keys) => {
        let node = delta;
        for (const key of keys) {
            if (!node || typeof node !== 'object') return 0;
            node = node[key];
        }
        return typeof node === 'number' ? node : 0;
    };

    const bedwars = {
        stars: at('achievements', 'bedwars_level'),
        finalKills: at('stats', 'Bedwars', 'final_kills_bedwars'),
        finalDeaths: at('stats', 'Bedwars', 'final_deaths_bedwars'),
        wins: at('stats', 'Bedwars', 'wins_bedwars'),
        losses: at('stats', 'Bedwars', 'losses_bedwars'),
        bedsBroken: at('stats', 'Bedwars', 'beds_broken_bedwars')
    };
    const skywars = {
        wins: at('stats', 'SkyWars', 'wins'),
        kills: at('stats', 'SkyWars', 'kills')
    };

    const played = bedwars.wins + bedwars.losses;
    return {
        bedwars,
        skywars,
        networkExp: at('networkExp'),
        gamesPlayed: played,
        // need a few games before the ratio means anything
        sessionFkdr: bedwars.finalDeaths > 0
            ? Math.round((bedwars.finalKills / bedwars.finalDeaths) * 100) / 100
            : bedwars.finalKills,
        active: played > 0 || bedwars.stars > 0 || skywars.wins > 0
    };
}

/**
 * Urchin blacklist client. The batch endpoint takes up to 100 uuids.
 * Short cache + shared in-flight requests.
 */
class UrchinAPI {
    constructor(config) {
        this.config = config;
        this.cache = new Map(); // bare uuid -> { tags, expires }
        this.inflight = new Map();
    }

    get key() {
        return this.config.get('urchinKey', null);
    }

    get enabled() {
        return Boolean(this.key);
    }

    // --- plumbing ----------------------------------------------------------

    async request(path, { method = 'GET', body = null, query = null } = {}) {
        if (!this.enabled) {
            throw new UrchinError('No Urchin API key is set. Run: node src/index.js urchin <your-key>', 401);
        }

        const url = new URL(`${API_BASE}${path}`);
        for (const [name, value] of Object.entries(query || {})) {
            if (value !== undefined && value !== null) url.searchParams.set(name, value);
        }

        let response;
        try {
            response = await fetch(url, {
                method,
                headers: {
                    'X-API-Key': this.key,
                    Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                body: body ? JSON.stringify(body) : undefined
            });
        } catch (err) {
            throw new UrchinError(`Could not reach Urchin: ${err.message}`, 0);
        }

        const text = await response.text();

        if (response.status === 401) {
            throw new UrchinError('Urchin rejected the API key. Get a new one from the Urchin Discord.', 401);
        }
        if (response.status === 403) {
            // 403 = key works but doesn't have access to this endpoint
            throw new UrchinError(
                `Your Urchin key is not permitted to use ${path}. Ask in the Urchin Discord for the permission.`,
                403
            );
        }
        if (response.status === 404) {
            throw new UrchinError('Urchin has no record of that player.', 404);
        }
        if (response.status === 429) {
            throw new UrchinError('Rate limited by Urchin. Slow down.', 429);
        }
        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try {
                const parsed = JSON.parse(text);
                if (parsed && (parsed.message || parsed.error)) detail = parsed.message || parsed.error;
            } catch { /* keep the status code */ }
            throw new UrchinError(`Urchin error: ${detail}`, response.status);
        }

        try {
            return text ? JSON.parse(text) : {};
        } catch {
            throw new UrchinError('Urchin returned a response that was not JSON.', response.status);
        }
    }

    cached(uuid) {
        const entry = this.cache.get(bare(uuid));
        if (!entry) return undefined;
        if (Date.now() > entry.expires) {
            this.cache.delete(bare(uuid));
            return undefined;
        }
        return entry.tags;
    }

    store(uuid, tags) {
        this.cache.set(bare(uuid), { tags, expires: Date.now() + TTL });
    }

    clearCache() {
        this.cache.clear();
        log.debug('Tag cache cleared.');
    }

    // --- lookups -----------------------------------------------------------

    /**
     * Look up tags for many players at once. UUIDs only, which is what the
     * tab list already gives us.
     * @returns {Promise<Map<string, object[]>>} bare uuid -> tags
     */
    async lookup(uuids, { fresh = false } = {}) {
        const wanted = [...new Set(uuids.filter(Boolean).map(bare))];
        const malformed = wanted.filter((u) => u.length !== 32);
        if (malformed.length) {
            // don't drop these, they'd show up as clean
            throw new UrchinError(
                `lookup() takes UUIDs, not usernames. Use player() for: ${malformed.slice(0, 3).join(', ')}`,
                400
            );
        }
        const results = new Map();
        const missing = [];

        for (const uuid of wanted) {
            const hit = fresh ? undefined : this.cached(uuid);
            if (hit !== undefined) results.set(uuid, hit);
            else missing.push(uuid);
        }

        for (let i = 0; i < missing.length; i += BATCH_LIMIT) {
            const chunk = missing.slice(i, i + BATCH_LIMIT);
            const cacheKey = chunk.slice().sort().join(',');

            const request = this.inflight.get(cacheKey)
                || this.request('/players', { method: 'POST', body: { uuids: chunk } })
                    .finally(() => this.inflight.delete(cacheKey));
            this.inflight.set(cacheKey, request);

            const body = await request;
            const players = (body && body.players) || {};

            // cache clean results too
            for (const uuid of chunk) {
                const raw = players[uuid] || players[uuid.toUpperCase()] || [];
                const tags = (Array.isArray(raw) ? raw : []).map(normaliseTag);
                this.store(uuid, tags);
                results.set(uuid, tags);
            }
        }

        return results;
    }

    /**
     * Tags for one player, by username or UUID. Also returns the formatted
     * Hypixel display name the service keeps on file.
     */
    async player(identifier) {
        const body = await this.request('/player/tags', { query: { player: identifier } });
        const tags = (body.tags || []).map(normaliseTag);
        if (body.uuid) this.store(body.uuid, tags);
        return { uuid: body.uuid || null, displayName: body.displayname || null, tags };
    }

    /**
     * Bedwars winstreaks per mode, rebuilt by urchin from snapshots since hypixel
     * hides them. Approximate ones span a gap in the history.
     */
    async winstreaks(identifier) {
        const body = await this.request('/player/winstreaks', { query: { player: identifier } });
        const modes = {};
        for (const [mode, entries] of Object.entries((body && body.modes) || {})) {
            if (!Array.isArray(entries) || !entries.length) continue;
            // The newest entry is the current streak.
            const latest = [...entries].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
            modes[mode] = {
                value: latest.value,
                approximate: Boolean(latest.approximate),
                readable: latest.readable || null,
                at: latest.timestamp || null,
                history: entries.length
            };
        }
        return {
            uuid: body.uuid || null,
            displayName: body.displayname || null,
            modes,
            any: Object.keys(modes).length > 0
        };
    }

    /** Gains since the start of a period. */
    async session(identifier, period = 'daily') {
        const allowed = ['daily', 'weekly', 'monthly'];
        const wanted = allowed.includes(String(period).toLowerCase()) ? String(period).toLowerCase() : 'daily';
        const body = await this.request(`/player/sessions/${wanted}`, { query: { player: identifier } });
        return {
            uuid: body.uuid || null,
            displayName: body.displayname || null,
            period: wanted,
            from: body.from || null,
            fromReadable: body.from_readable || null,
            delta: body.delta || {},
            summary: summariseDelta(body.delta || {}),
            changed: Object.keys(body.delta || {}).length > 0
        };
    }

    /** Resolve a username to the service's player record. */
    async resolve(identifier) {
        return this.request(`/resolve/${encodeURIComponent(identifier)}`);
    }

    /** Submit a tag. The key must have tagging rights. */
    async addTag(identifier, tagType, reason, { hideUsername = false, silent = false } = {}) {
        const type = SHORT_FORMS[String(tagType).toLowerCase()] || String(tagType).toLowerCase();
        if (!TAG_TYPES[type]) {
            throw new UrchinError(`Unknown tag type "${tagType}". Valid: ${Object.keys(TAG_TYPES).join(', ')}`, 400);
        }
        if (!reason || !String(reason).trim()) {
            throw new UrchinError('A reason is required.', 400);
        }
        const result = await this.request('/tags', {
            method: 'POST',
            query: { player: identifier },
            body: { type, reason: String(reason), hide_username: hideUsername, silent }
        });
        this.clearCache();
        return result;
    }

    /** Cheap call used to confirm a key works. */
    async verify() {
        const result = await this.player('Technoblade');
        return { ok: true, uuid: result.uuid };
    }

    /** Most severe tag. */
    static highest(tags) {
        if (!tags || !tags.length) return null;
        return [...tags].sort((a, b) => describeTag(b.type).severity - describeTag(a.type).severity)[0];
    }
}

module.exports = { UrchinAPI, UrchinError, TAG_TYPES, SHORT_FORMS, describeTag, normaliseTag, summariseDelta, API_BASE };
