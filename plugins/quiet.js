'use strict';

/**
 * Mutes lobby noise: portal sounds, particles, chat spam.
 * Only cancels incoming sound/particle/chat packets.
 */

const SOUND_GROUPS = {
    portal: [/^portal\./, /^mob\.endermen\.portal/],
    fireworks: [/^fireworks\./],
    lobby: [/^note\./, /^random\.levelup/],
    endermen: [/^mob\.endermen\./]
};

// 1.8 particles use numeric ids, names get resolved through minecraft-data on load
const PARTICLE_NAMES = {
    glyphs: ['enchantmenttable', 'spell', 'mobSpell', 'mobSpellAmbient', 'witchMagic'],
    fireworks: ['fireworksSpark'],
    hearts: ['heart'],
    smoke: ['largesmoke', 'smoke'],
    portal: ['portal'],
    footsteps: ['footstep'],
    crits: ['crit', 'magicCrit']
};

const CHAT_PRESETS = {
    ads: [
        /^\s*█/,
        /HYPIXEL LEVELING|has just reached level/i,
        /Want to see this message\? Click here/i,
        /You can now claim your daily reward/i
    ],
    rewards: [/reward|daily reward|mystery box/i],
    connections: [/has joined \(\d+\/\d+\)!|has quit!/i],
    tips: [/tipped \d+ players|You tipped|Slow down! You can only use/i],
    guild: [/^Guild >/],
    shouts: [/^\s*\[.*\] .*: .*SHOUT/i]
};

const DEFAULTS = {
    sounds: [],
    particles: [],
    chatPresets: [],
    lobbyOnly: true
};

module.exports = {
    name: 'quiet',
    version: '1.0.0',
    author: 'wrath',
    description: 'Mute sounds, particles and chat spam',

    init(ctx) {
        const ui = ctx.ui;

        // through ctx, plugins can't require packages
        const PARTICLE_GROUPS = {};
        for (const [group, names] of Object.entries(PARTICLE_NAMES)) {
            PARTICLE_GROUPS[group] = ctx.minecraft.particles.ids(names);
        }

        const setting = (key) => {
            const value = ctx.store.get(key);
            return value === undefined ? DEFAULTS[key] : value;
        };

        const counters = { sounds: 0, particles: 0, chat: 0 };

        // rough check: lobbies have way more players than games
        const looksLikeLobby = () => ctx.players.list().length > 20;

        ctx.on('packet:named_sound_effect:clientbound', (event) => {
            const groups = setting('sounds');
            if (!groups.length) return;
            if (setting('lobbyOnly') && !looksLikeLobby()) return;

            const name = String(event.data.soundName || '');
            for (const group of groups) {
                const patterns = SOUND_GROUPS[group] || [];
                if (patterns.some((pattern) => pattern.test(name))) {
                    counters.sounds += 1;
                    event.cancel();
                    return;
                }
            }
        });

        ctx.on('packet:world_particles:clientbound', (event) => {
            const groups = setting('particles');
            if (!groups.length) return;

            const id = Number(event.data.particleId);
            if (!Number.isFinite(id)) return;
            for (const group of groups) {
                if ((PARTICLE_GROUPS[group] || []).includes(id)) {
                    counters.particles += 1;
                    event.cancel();
                    return;
                }
            }
        });

        ctx.on('chat', (event) => {
            const presets = setting('chatPresets');
            if (!presets.length || event.position === 2) return;

            const plain = event.plain;
            for (const preset of presets) {
                const patterns = CHAT_PRESETS[preset] || [];
                if (patterns.some((pattern) => pattern.test(plain))) {
                    counters.chat += 1;
                    event.cancel();
                    return;
                }
            }
        });

        const toggleList = (key, groups, name, value, command) => {
            if (!value) {
                return command.error(`Usage: /quiet ${name} <${Object.keys(groups).join('|')}>`);
            }
            if (!groups[value]) {
                return command.error(`Unknown group "${value}". Options: ${Object.keys(groups).join(', ')}`);
            }
            const current = setting(key);
            const next = current.includes(value) ? current.filter((g) => g !== value) : [...current, value];
            ctx.store.set(key, next);
            return command.reply(`&f${value}&7 is now &f${next.includes(value) ? 'muted' : 'audible'}&7.`);
        };

        ctx.commands.register('quiet', {
            description: 'Mute sounds, particles and chat spam',
            usage: '[sound <group>|particle <group>|chat <preset>|status]',
            handler: (args, command) => {
                const action = (args[0] || 'status').toLowerCase();
                const value = args[1] ? args[1].toLowerCase() : null;

                if (action === 'sound') return toggleList('sounds', SOUND_GROUPS, 'sound', value, command);
                if (action === 'particle') return toggleList('particles', PARTICLE_GROUPS, 'particle', value, command);
                if (action === 'chat') return toggleList('chatPresets', CHAT_PRESETS, 'chat', value, command);
                if (action === 'lobbyonly') {
                    const next = !setting('lobbyOnly');
                    ctx.store.set('lobbyOnly', next);
                    return command.reply(`Sound muting is now &f${next ? 'lobbies only' : 'everywhere'}&7.`);
                }
                if (action === 'status') {
                    const show = (list) => (list.length ? `&f${list.join(', ')}` : '&8none');
                    ui.box('&7Quiet', [
                        `&7Sounds     ${show(setting('sounds'))}`,
                        `&7Particles  ${show(setting('particles'))}`,
                        `&7Chat       ${show(setting('chatPresets'))}`,
                        `&7Scope      &f${setting('lobbyOnly') ? 'lobbies only' : 'everywhere'}`,
                        null,
                        `&8blocked this session: ${counters.sounds} sounds, ${counters.particles} particles, ${counters.chat} lines`,
                        `&8groups: ${Object.keys(SOUND_GROUPS).join(', ')}`,
                        `&8presets: ${Object.keys(CHAT_PRESETS).join(', ')}`
                    ]);
                    return undefined;
                }
                return command.error(`Unknown action "${action}".`);
            }
        });
    }
};
