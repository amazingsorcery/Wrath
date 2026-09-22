'use strict';

const chatUtil = require('../utils/chat');

const S = '§';

// mc only has 16 colors so gradients are hand picked
const RAMPS = {
    fire: ['4', '4', 'c', 'c', '6', '6', 'e'],
    blood: ['4', '4', '4', 'c', 'c'],
    ice: ['1', '9', '3', 'b', 'f'],
    toxic: ['2', 'a', 'e'],
    royal: ['5', 'd', 'f'],
    mono: ['8', '7', 'f', '7', '8'],
    // fades in at both ends
    edge: ['8', '8', '4', 'c', '6', 'e', '6', 'c', '4', '8', '8']
};

/** Build a divider ramp that fades in and out of the dark for any theme. */
function edgeRampFor(rampName) {
    const ramp = RAMPS[rampName];
    if (!ramp) return RAMPS.edge;
    const middle = ramp.slice(1);
    return ['8', '8', ...middle, ...[...middle].reverse(), '8', '8'];
}

/** Themes: ramp for the wordmark/dividers + two accent colors. */
const THEMES = {
    ember: { ramp: 'fire', primary: 'c', accent: '6', label: 'Ember' },
    blood: { ramp: 'blood', primary: '4', accent: 'c', label: 'Blood' },
    ice: { ramp: 'ice', primary: 'b', accent: '9', label: 'Ice' },
    toxic: { ramp: 'toxic', primary: 'a', accent: 'e', label: 'Toxic' },
    royal: { ramp: 'royal', primary: 'd', accent: '5', label: 'Royal' },
    mono: { ramp: 'mono', primary: 'f', accent: '7', label: 'Mono' }
};

/** Threat tiers used by the stat displays, worst first. */
const TIERS = [
    { min: 10, colour: '4', label: 'DANGER', tag: `${S}4${S}lDANGER` },
    { min: 5, colour: 'c', label: 'HIGH', tag: `${S}c${S}lHIGH  ` },
    { min: 3, colour: '6', label: 'MEDIUM', tag: `${S}6MEDIUM` },
    { min: 1, colour: 'e', label: 'LOW', tag: `${S}eLOW   ` },
    { min: 0, colour: 'a', label: 'SAFE', tag: `${S}aSAFE  ` }
];

const UNKNOWN_TIER = { min: -1, colour: '8', label: 'UNKNOWN', tag: `${S}8${S}oNICK? ` };

/** Hypixel rank badges. */
const RANKS = {
    'MVP++': { badge: `${S}6[MVP${S}c++${S}6]`, colour: '6' },
    'MVP+': { badge: `${S}b[MVP${S}c+${S}b]`, colour: 'b' },
    MVP: { badge: `${S}b[MVP]`, colour: 'b' },
    'VIP+': { badge: `${S}a[VIP${S}6+${S}a]`, colour: 'a' },
    VIP: { badge: `${S}a[VIP]`, colour: 'a' },
    YOUTUBER: { badge: `${S}c[${S}fYOUTUBE${S}c]`, colour: 'c' },
    ADMIN: { badge: `${S}c[ADMIN]`, colour: 'c' },
    MODERATOR: { badge: `${S}2[MOD]`, colour: '2' },
    HELPER: { badge: `${S}9[HELPER]`, colour: '9' },
    NONE: { badge: '', colour: '7' }
};

/** In-game drawing helpers, available to plugins as ctx.ui. */
class UI {
    constructor(ctx) {
        this.ctx = ctx;
    }

    /** Colorize text and fix command mentions (/scan vs /wrath scan) based on settings. */
    text(value) {
        const api = this.ctx && this.ctx._api;
        const commands = api && api.proxy && api.proxy.commands;
        return chatUtil.colourize(commands ? commands.qualify(value) : value);
    }

    /** The way a command has to be typed right now, for click actions. */
    command(value) {
        const api = this.ctx && this.ctx._api;
        const commands = api && api.proxy && api.proxy.commands;
        return commands ? commands.qualify(value) : value;
    }

    // --- primitives --------------------------------------------------------

    /** Horizontal rule. Strikethrough spaces colored in runs for a gradient. */
    rule(width = 52, ramp = 'edge') {
        if (typeof ramp === 'string' && !RAMPS[ramp] && ramp !== 'edge') {
            return `${S}${ramp}${S}m${' '.repeat(width)}`;
        }
        // "edge" means the divider for whichever theme is in use.
        const codes = ramp === 'edge' ? edgeRampFor(this.theme().ramp) : (RAMPS[ramp] || RAMPS.edge);
        const base = Math.floor(width / codes.length);
        let remainder = width % codes.length;
        let out = '';
        for (const code of codes) {
            const length = base + (remainder > 0 ? 1 : 0);
            if (remainder > 0) remainder -= 1;
            if (length <= 0) continue;
            out += `${S}${code}${S}m${' '.repeat(length)}`;
        }
        return out;
    }

    /** Spread a ramp of colour codes across the characters of a string. */
    gradient(text, rampName = null, offset = 0) {
        const ramp = RAMPS[rampName || this.theme().ramp] || RAMPS.fire;
        const chars = [...String(text)];
        return chars
            .map((char, index) => {
                if (char === ' ') return char;
                const position = chars.length <= 1 ? 0 : index / (chars.length - 1);
                // otherwise position 1 wraps back to the first color
                const shifted = offset === 0 ? position : (position + offset) % 1;
                const colour = ramp[Math.min(ramp.length - 1, Math.round(shifted * (ramp.length - 1)))];
                return `${S}${colour}${char}`;
            })
            .join('');
    }

    /** Wrath wordmark. */
    brand(bold = true, offset = 0) {
        const ramp = RAMPS[this.theme().ramp] || RAMPS.fire;
        const text = 'WRATH';
        return [...text]
            .map((char, index) => {
                const raw = index / (text.length - 1) + offset;
                const position = offset === 0 ? raw : raw % 1;
                const colour = ramp[Math.min(ramp.length - 1, Math.round(position * (ramp.length - 1)))];
                return `${S}${colour}${bold ? `${S}l` : ''}${char}`;
            })
            .join('');
    }

    /** The user's chosen colours, falling back to the Wrath defaults. */
    theme() {
        const api = this.ctx && this.ctx._api;
        const config = api && api.proxy && api.proxy.config;
        const stored = config ? config.get('theme', null) : null;
        const preset = THEMES[(stored && stored.name) || 'ember'] || THEMES.ember;
        return { ...preset, ...(stored || {}) };
    }

    primary() {
        return this.theme().primary;
    }

    accent() {
        return this.theme().accent;
    }

    /** Alert via chat / title / sound depending on config. */
    alert(channels, { chat = null, title = null, subtitle = null, sound = 'note.pling', pitch = 150, volume = 0.7 } = {}) {
        const wanted = new Set((channels || []).map((c) => String(c).toLowerCase()));
        if (wanted.has('chat') && chat) this.say(chat);
        if (wanted.has('title') && title) this.ctx.title(chat && !title ? chat : title, subtitle, { fadeIn: 2, stay: 30, fadeOut: 8 });
        if (wanted.has('sound') && sound) this.ctx.sound.play(sound, { pitch, volume });
    }

    /** Standard message prefix. */
    prefix() {
        return `${this.brand()} ${S}8» ${S}r`;
    }

    /** A bar made of filled and empty blocks. */
    bar(value, max, width = 10, colour = 'c') {
        const filled = Math.max(0, Math.min(width, Math.round((value / (max || 1)) * width)));
        return `${S}${colour}${'█'.repeat(filled)}${S}8${'█'.repeat(width - filled)}`;
    }

    /** Wrap text in a hover tooltip component. */
    hover(text, tooltip) {
        return {
            text: this.text(text),
            hoverEvent: {
                action: 'show_text',
                value: this.text(Array.isArray(tooltip) ? tooltip.join('\n') : tooltip)
            }
        };
    }

    /** Clickable command line. Handled locally, never reaches the server. */
    action(text, command, tooltip = null) {
        const node = {
            text: this.text(text),
            clickEvent: { action: 'run_command', value: this.command(command) }
        };
        if (tooltip) {
            node.hoverEvent = {
                action: 'show_text',
                value: this.text(Array.isArray(tooltip) ? tooltip.join('\n') : tooltip)
            };
        }
        return node;
    }

    /** Join components and strings into one chat line. */
    line(...parts) {
        return {
            text: '',
            extra: parts.map((part) => (typeof part === 'string' ? { text: this.text(part) } : part))
        };
    }

    // --- composites --------------------------------------------------------

    /** Send a titled block framed by rules. */
    box(title, lines, { width = 52, footer = null, ramp = 'edge' } = {}) {
        this.ctx.send(this.rule(width, ramp));
        if (title) {
            if (typeof title === 'string') this.ctx.send(` ${this.prefix()}${this.text(title)}`);
            else this.ctx.send(this.line(` ${this.prefix()}`, title));
        }
        for (const entry of lines) {
            if (entry === null) {
                this.ctx.send(this.rule(width, ramp));
                continue;
            }
            if (typeof entry === 'string') this.ctx.send(` ${S}8┃ ${this.text(entry)}`);
            else this.ctx.send(this.line(` ${S}8┃ `, entry));
        }
        if (footer) this.ctx.send(` ${S}8┃ ${this.text(footer)}`);
        this.ctx.send(this.rule(width, ramp));
    }

    /** One-line status message with the Wrath prefix. */
    say(text) {
        return this.ctx.send(` ${this.prefix()}${this.text(text)}`);
    }

    /** Error-styled one-liner. */
    warn(text) {
        return this.ctx.send(` ${this.prefix()}${S}c${this.text(text)}`);
    }

    /** Shimmer animation on a title. */
    sweep(text, subtitle = null, { frames = 8, interval = 70, ramp = 'fire' } = {}) {
        for (let frame = 0; frame < frames; frame += 1) {
            this.ctx.schedule(() => {
                const last = frame === frames - 1;
                this.ctx.title(
                    this.gradient(text, ramp, frame / frames),
                    frame === 0 || last ? subtitle : undefined,
                    last ? { fadeIn: 0, stay: 40, fadeOut: 12 } : { fadeIn: 0, stay: 20, fadeOut: 0 }
                );
            }, frame * interval);
        }
    }

    // --- stat helpers ------------------------------------------------------

    /** Pick the threat tier for a final kill/death ratio. */
    tier(fkdr) {
        if (fkdr === null || fkdr === undefined) return UNKNOWN_TIER;
        return TIERS.find((t) => fkdr >= t.min) || TIERS[TIERS.length - 1];
    }

    /** Colour a Bedwars star by prestige band, the way Hypixel does. */
    starColour(star) {
        if (star >= 1000) return '4';
        if (star >= 900) return 'd';
        if (star >= 800) return '9';
        if (star >= 700) return '5';
        if (star >= 600) return '3';
        if (star >= 500) return 'b';
        if (star >= 400) return '2';
        if (star >= 300) return '1';
        if (star >= 200) return '6';
        if (star >= 100) return 'f';
        return '7';
    }

    rank(name) {
        return RANKS[name] || RANKS.NONE;
    }

    /** Colour for a rank string. */
    rankColour(rankName) {
        return this.rank(rankName).colour;
    }

    /** "[MVP+] Name", coloured the way the game draws it. */
    rankName(rankName, playerName) {
        const rank = this.rank(rankName);
        return rank.badge ? `${rank.badge} ${S}${rank.colour}${playerName}` : `${S}7${playerName}`;
    }

    /** Compact number: 12400 becomes 12.4k. */
    short(n) {
        const value = Number(n) || 0;
        if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
        if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
        return String(value);
    }

    /** The tooltip shown when hovering a player in a stat list. */
    tooltip(stats, { clickHint = null } = {}) {
        const bw = stats.bedwars;
        const sw = stats.skywars;
        const tier = this.tier(bw.fkdr);
        const lines = [
            `${this.rankName(stats.rank, stats.name)}`,
            `&8Network level &f${stats.networkLevel}`,
            '',
            '&b&lBedwars',
            `&7Star     &${this.starColour(bw.star)}${bw.star}✫`,
            `&7FKDR     &${tier.colour}${bw.fkdr}  &8(${this.short(bw.finalKills)} / ${this.short(bw.finalDeaths)})`,
            `&7Wins     &f${this.short(bw.wins)}  &8W/L ${bw.wlr}`,
            bw.winstreak === null ? '&7Streak   &8hidden' : `&7Streak   &f${bw.winstreak}`,
            `&7Threat   &${tier.colour}&l${tier.label} &8${this.bar(Math.min(bw.fkdr, 10), 10, 10, tier.colour)}`,
            '',
            '&b&lSkyWars',
            `&7Level    &f${sw.level || 'n/a'}`,
            `&7KDR      &f${sw.kdr}  &8(${this.short(sw.kills)} / ${this.short(sw.deaths)})`,
            `&7Wins     &f${this.short(sw.wins)}`
        ];
        if (clickHint) lines.push('', `&8${clickHint}`);
        return lines.join('\n');
    }
}

module.exports = { UI, RAMPS, TIERS, UNKNOWN_TIER, RANKS, THEMES, edgeRampFor };
