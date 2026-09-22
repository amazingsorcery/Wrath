'use strict';

const { create } = require('./utils/logger');

const log = create('hypixel');

const API_BASE = 'https://api.hypixel.net/v2';
const MOJANG_BASE = 'https://api.mojang.com/users/profiles/minecraft';

const TTL = {
    player: 120_000,
    status: 30_000,
    guild: 300_000,
    recentgames: 60_000,
    uuid: 86_400_000
};

class HypixelError extends Error {
    /**
     * @param {string} message
     * @param {number} status HTTP-ish, 404 = no such player
     * @param {string|null} reason which service came up empty
     */
    constructor(message, status, reason = null) {
        super(message);
        this.name = 'HypixelError';
        this.status = status;
        this.reason = reason;
    }
}

/** Compute the network level Hypixel shows next to your name. */
function networkLevel(exp = 0) {
    return Math.floor((Math.sqrt(exp + 15312.5) - 125 / Math.sqrt(2)) / (25 * Math.sqrt(2))) + 1;
}

function ratio(numerator, denominator) {
    if (!denominator) return Number(numerator || 0);
    return Math.round(((numerator || 0) / denominator) * 100) / 100;
}

/** Work out a player's rank from the several fields Hypixel uses for it. */
function rankOf(player) {
    if (!player) return 'NONE';
    if (player.rank && player.rank !== 'NORMAL') return player.rank;
    if (player.monthlyPackageRank === 'SUPERSTAR') return 'MVP++';
    const pkg = player.newPackageRank || player.packageRank;
    if (pkg === 'MVP_PLUS') return 'MVP+';
    if (pkg === 'MVP') return 'MVP';
    if (pkg === 'VIP_PLUS') return 'VIP+';
    if (pkg === 'VIP') return 'VIP';
    return 'NONE';
}

/** Flatten the player object into the stats we show. */
function summarize(player) {
    if (!player) return null;
    const stats = player.stats || {};
    const bw = stats.Bedwars || {};
    const sw = stats.SkyWars || {};
    const duels = stats.Duels || {};

    const bwFinalKills = bw.final_kills_bedwars || 0;
    const bwFinalDeaths = bw.final_deaths_bedwars || 0;
    const bwWins = bw.wins_bedwars || 0;
    const bwLosses = bw.losses_bedwars || 0;
    const bwBedsBroken = bw.beds_broken_bedwars || 0;
    const bwBedsLost = bw.beds_lost_bedwars || 0;
    const bwKills = bw.kills_bedwars || 0;
    const bwDeaths = bw.deaths_bedwars || 0;

    return {
        name: player.displayname || player.playername || null,
        uuid: player.uuid,
        rank: rankOf(player),
        networkLevel: networkLevel(player.networkExp || 0),
        karma: player.karma || 0,
        firstLogin: player.firstLogin || null,
        lastLogin: player.lastLogin || null,
        bedwars: {
            star: (player.achievements && player.achievements.bedwars_level) || 0,
            finalKills: bwFinalKills,
            finalDeaths: bwFinalDeaths,
            fkdr: ratio(bwFinalKills, bwFinalDeaths),
            wins: bwWins,
            losses: bwLosses,
            wlr: ratio(bwWins, bwLosses),
            bedsBroken: bwBedsBroken,
            bedsLost: bwBedsLost,
            bblr: ratio(bwBedsBroken, bwBedsLost),
            kills: bwKills,
            deaths: bwDeaths,
            kdr: ratio(bwKills, bwDeaths),
            // hidden winstreak (API setting off), not the same as 0
            winstreak: bw.winstreak === undefined ? null : bw.winstreak
        },
        skywars: {
            level: (sw.levelFormatted || '').replace(/§[0-9a-fk-or]/gi, '') || null,
            kills: sw.kills || 0,
            deaths: sw.deaths || 0,
            kdr: ratio(sw.kills, sw.deaths),
            wins: sw.wins || 0,
            losses: sw.losses || 0
        },
        duels: {
            wins: duels.wins || 0,
            losses: duels.losses || 0,
            wlr: ratio(duels.wins, duels.losses)
        }
    };
}

/**
 * Hypixel API client. Caches responses, dedupes concurrent requests and
 * tracks the rate limit headers.
 */
class HypixelAPI {
    constructor(config) {
        this.config = config;
        this.cache = new Map();
        this.inflight = new Map();
        this.rate = { remaining: null, limit: null, resetAt: null };
    }

    get key() {
        return this.config.get('hypixelKey', null);
    }

    get enabled() {
        return Boolean(this.key);
    }

    // --- plumbing ----------------------------------------------------------

    cached(cacheKey) {
        const entry = this.cache.get(cacheKey);
        if (!entry) return undefined;
        if (Date.now() > entry.expires) {
            this.cache.delete(cacheKey);
            return undefined;
        }
        return entry.value;
    }

    store(cacheKey, value, ttl) {
        this.cache.set(cacheKey, { value, expires: Date.now() + ttl });
        return value;
    }

    /** Share one in-flight promise between callers asking for the same thing. */
    dedupe(cacheKey, factory) {
        if (this.inflight.has(cacheKey)) return this.inflight.get(cacheKey);
        const promise = factory().finally(() => this.inflight.delete(cacheKey));
        this.inflight.set(cacheKey, promise);
        return promise;
    }

    /**
     * Wait out rate limits instead of failing (300 req / 5 min). Uses the reset
     * header when there is one, otherwise backs off.
     */
    async withRetry(work, { attempts = 3 } = {}) {
        let lastError = null;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                return await work();
            } catch (err) {
                lastError = err;
                const retryable = err instanceof HypixelError && (err.status === 429 || err.status === 0);
                if (!retryable || attempt === attempts) throw err;

                const reset = this.rate.resetAt ? this.rate.resetAt - Date.now() : 0;
                const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
                const wait = Math.max(250, Math.min(reset > 0 ? reset : backoff, 30_000));
                log.warn(`${err.message} Retrying in ${Math.round(wait / 1000)}s (${attempt}/${attempts - 1}).`);
                await new Promise((resolve) => setTimeout(resolve, wait));
            }
        }
        throw lastError;
    }

    async request(endpoint, params = {}, ttl = 60_000) {
        if (!this.enabled) {
            throw new HypixelError('No Hypixel API key is set. Run: node src/index.js key <your-key>', 401);
        }

        const url = new URL(`${API_BASE}/${endpoint.replace(/^\//, '')}`);
        for (const [name, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(name, value);
        }

        const cacheKey = url.toString();
        const hit = this.cached(cacheKey);
        if (hit !== undefined) return hit;

        return this.dedupe(cacheKey, () => this.withRetry(async () => {
            if (this.rate.remaining === 0 && this.rate.resetAt && Date.now() < this.rate.resetAt) {
                const seconds = Math.ceil((this.rate.resetAt - Date.now()) / 1000);
                throw new HypixelError(`Rate limit reached. Try again in ${seconds}s.`, 429);
            }

            let response;
            try {
                response = await fetch(cacheKey, {
                    headers: { 'API-Key': this.key, Accept: 'application/json' }
                });
            } catch (err) {
                throw new HypixelError(`Could not reach the Hypixel API: ${err.message}`, 0);
            }

            this.readRateLimit(response.headers);

            let body = null;
            try {
                body = await response.json();
            } catch {
                throw new HypixelError(`Hypixel returned a non-JSON response (HTTP ${response.status}).`, response.status);
            }

            if (response.status === 403) {
                throw new HypixelError('Hypixel rejected the API key. Generate a new one at developer.hypixel.net.', 403);
            }
            if (response.status === 429) {
                throw new HypixelError('Rate limited by Hypixel. Slow down.', 429);
            }
            if (!response.ok || body.success === false) {
                throw new HypixelError(body.cause || `Hypixel API error (HTTP ${response.status}).`, response.status);
            }

            return this.store(cacheKey, body, ttl);
        }));
    }

    readRateLimit(headers) {
        const remaining = headers.get('ratelimit-remaining');
        const limit = headers.get('ratelimit-limit');
        const reset = headers.get('ratelimit-reset');
        if (remaining !== null) this.rate.remaining = Number.parseInt(remaining, 10);
        if (limit !== null) this.rate.limit = Number.parseInt(limit, 10);
        if (reset !== null) this.rate.resetAt = Date.now() + Number.parseInt(reset, 10) * 1000;
    }

    // --- lookups -----------------------------------------------------------

    static isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value);
    }

    /** Resolve a username to a UUID through Mojang, cached for a day. */
    async uuidOf(name) {
        if (HypixelAPI.isUuid(name)) return name.replace(/-/g, '');
        const cacheKey = `mojang:${String(name).toLowerCase()}`;
        const hit = this.cached(cacheKey);
        if (hit !== undefined) return hit;

        return this.dedupe(cacheKey, async () => {
            let response;
            try {
                response = await fetch(`${MOJANG_BASE}/${encodeURIComponent(name)}`);
            } catch (err) {
                throw new HypixelError(`Could not reach Mojang: ${err.message}`, 0);
            }
            if (response.status === 404 || response.status === 204) {
                throw new HypixelError(`No Minecraft account named "${name}".`, 404, 'no-mojang-account');
            }
            if (!response.ok) {
                throw new HypixelError(`Mojang lookup failed (HTTP ${response.status}).`, response.status);
            }
            const body = await response.json();
            return this.store(cacheKey, body.id, TTL.uuid);
        });
    }

    /** Raw player object. */
    async playerRaw(target) {
        const uuid = await this.uuidOf(target);
        const body = await this.request('player', { uuid }, TTL.player);
        // hypixel decides if it's a nick, not mojang
        if (!body.player) {
            // target is usually a uuid by now, show the name instead
            const named = /^[0-9a-f]{32}$/i.test(String(target).replace(/-/g, ''))
                ? 'That account has no Hypixel record.'
                : `${target} has no Hypixel record.`;
            throw new HypixelError(named, 404, 'no-hypixel-record');
        }
        return body.player;
    }

    /** Flattened, ready-to-print stats. */
    async player(target) {
        return summarize(await this.playerRaw(target));
    }

    /** Whether someone is online, and what they are playing. */
    async status(target) {
        const uuid = await this.uuidOf(target);
        const body = await this.request('status', { uuid }, TTL.status);
        return body.session || { online: false };
    }

    async guild(target) {
        const uuid = await this.uuidOf(target);
        const body = await this.request('guild', { player: uuid }, TTL.guild);
        return body.guild || null;
    }

    async recentGames(target) {
        const uuid = await this.uuidOf(target);
        const body = await this.request('recentgames', { uuid }, TTL.recentgames);
        return body.games || [];
    }

    /** Look up many players with a concurrency cap. Errors are returned, not thrown. */
    async batch(targets, { concurrency = 3, onResult = null } = {}) {
        const queue = [...targets];
        const results = [];
        const workerCount = Math.max(1, Math.min(concurrency, queue.length));

        const worker = async () => {
            while (queue.length) {
                const target = queue.shift();
                let entry;
                try {
                    entry = { target, stats: await this.player(target), error: null };
                } catch (err) {
                    entry = { target, stats: null, error: err };
                }
                results.push(entry);
                if (onResult) {
                    try {
                        onResult(entry);
                    } catch { /* a reporting callback must not stop the batch */ }
                }
            }
        };

        await Promise.all(Array.from({ length: workerCount }, worker));
        return results;
    }

    /** Cheap call used to confirm a key works. */
    async verify() {
        const body = await this.request('punishmentstats', {}, 0);
        return {
            ok: true,
            remaining: this.rate.remaining,
            limit: this.rate.limit,
            sample: body.staff_rollingDaily
        };
    }

    clearCache() {
        this.cache.clear();
        log.debug('Cache cleared.');
    }
}

module.exports = { HypixelAPI, HypixelError, summarize, networkLevel, rankOf };
