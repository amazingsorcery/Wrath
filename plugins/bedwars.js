'use strict';

/**
 * Bedwars QoL, all based on chat.
 *
 *   Auto GG          gg at game end
 *   Trap reminder    rebuy reminder 30s after a trap
 *   Milk timer       magic milk countdown
 *   Effect alerts    jump boost / mining fatigue
 *
 * /who at game start is handled by autostats.
 */

const DEFAULTS = {
    autoGg: true,
    trapReminder: true,
    milkTimer: true,
    effectAlerts: true,
    ggDelayMs: 900,
    trapSeconds: 30,
    milkSeconds: 30,
    alertChannels: ['chat', 'sound']
};

const GG_FORMS = ['gg', 'GG', 'Gg', 'gG', 'gg!', 'GG!', 'good game'];

/**
 * Hypixel messages, matched loosely. Not all checked against live games yet,
 * so they can be overridden and /bw patterns shows which never matched.
 */
const DEFAULT_PATTERNS = {
    gameStart: 'Protect your bed and destroy the enemy beds',
    victory: '^\\s*(?:VICTORY|GAME OVER|WINNER)',
    trap: 'Trap (?:was )?(?:set off|triggered)|TRAP TRIGGERED',
    milk: '(?:bought|purchased).*Magic Milk',
    jumpBoost: 'Jump Boost.*(?:ran out|expired|wore off)',
    fatigue: 'Mining Fatigue'
};

module.exports = {
    name: 'bedwars',
    version: '1.1.0',
    author: 'wrath',
    description: 'Auto GG, trap and milk timers',

    init(ctx) {
        const ui = ctx.ui;
        const setting = (key) => {
            const value = ctx.store.get(key);
            return value === undefined ? DEFAULTS[key] : value;
        };

        // match count per pattern. 0 after a few games = pattern is probably wrong
        const matches = {};
        for (const key of Object.keys(DEFAULT_PATTERNS)) matches[key] = 0;

        let compiled = null;
        let compiledFrom = null;

        /** Compile the patterns once, falling back for anything invalid. */
        function patterns() {
            const overrides = ctx.store.get('patterns', {});
            const source = JSON.stringify(overrides);
            if (source === compiledFrom && compiled) return compiled;

            compiledFrom = source;
            compiled = {};
            for (const [key, fallback] of Object.entries(DEFAULT_PATTERNS)) {
                const wanted = overrides[key] || fallback;
                try {
                    compiled[key] = new RegExp(wanted, 'i');
                } catch (err) {
                    ctx.log.warn(`Pattern "${key}" is not valid, using the default: ${err.message}`);
                    compiled[key] = new RegExp(fallback, 'i');
                }
            }
            return compiled;
        }

        /** Test a line and count the match. */
        function hits(key, line) {
            const pattern = patterns()[key];
            if (!pattern || !pattern.test(line)) return false;
            matches[key] += 1;
            return true;
        }

        // for capture.js labels
        ctx.shared.set('bedwarsPatterns', () => patterns());

        let inGame = false;
        let ggSent = false;
        let trapTimer = null;
        let milkTimer = null;

        const channels = () => setting('alertChannels');

        ctx.on('world_change', () => {
            inGame = false;
            ggSent = false;
            clearTimers();
        });

        function clearTimers() {
            if (trapTimer) ctx.clear(trapTimer);
            if (milkTimer) ctx.clear(milkTimer);
            trapTimer = null;
            milkTimer = null;
        }

        ctx.on('chat', (event) => {
            const line = event.plain.trim();
            if (!line) return;

            // game start (bed protection message)
            if (!inGame && hits('gameStart', line)) {
                inGame = true;
                ggSent = false;
                return;
            }

            if (inGame && !ggSent && hits('victory', line)) {
                ggSent = true;
                inGame = false;
                if (setting('autoGg')) {
                    const form = GG_FORMS[Math.floor(Math.random() * GG_FORMS.length)];
                    ctx.schedule(() => ctx.sendToServer(form), setting('ggDelayMs'));
                }
                return;
            }

            if (setting('trapReminder') && hits('trap', line)) {
                if (trapTimer) ctx.clear(trapTimer);
                const seconds = setting('trapSeconds');
                trapTimer = ctx.schedule(() => {
                    trapTimer = null;
                    ui.alert(channels(), {
                        chat: `&cTrap went off &8· &7buy a replacement.`,
                        title: '&c&lREBUY TRAP',
                        sound: 'note.bass',
                        pitch: 80
                    });
                }, seconds * 1000);
                ui.say(`&7Trap triggered. Reminder in &f${seconds}s&7.`);
                return;
            }

            if (setting('milkTimer') && hits('milk', line)) {
                startMilkTimer();
                return;
            }

            if (setting('effectAlerts') && hits('jumpBoost', line)) {
                ui.alert(channels(), {
                    chat: '&aJump Boost has run out.',
                    title: '&a&lJUMP BOOST',
                    subtitle: '&7expired',
                    sound: 'note.pling',
                    pitch: 90
                });
                return;
            }

            if (setting('effectAlerts') && hits('fatigue', line)) {
                ui.alert(channels(), {
                    chat: '&cMining Fatigue applied.',
                    sound: 'note.bass',
                    pitch: 60
                });
            }
        });

        function startMilkTimer() {
            if (milkTimer) ctx.clear(milkTimer);
            const total = setting('milkSeconds');
            let left = total;

            ui.say(`&fMagic Milk &7active for &f${total}s&7.`);
            milkTimer = ctx.interval(() => {
                left -= 1;
                if (left > 0) {
                    ctx.actionBar(`&fMilk &8[${ui.bar(left, total, 10, left > 10 ? 'a' : 'c')}&8] &f${left}s`);
                    return;
                }
                ctx.clear(milkTimer);
                milkTimer = null;
                ui.alert(channels(), {
                    chat: '&cMagic Milk has run out.',
                    title: '&c&lMILK',
                    subtitle: '&7expired',
                    sound: 'note.bass',
                    pitch: 70
                });
            }, 1000);
        }

        ctx.commands.register('patterns', {
            description: 'Show and fix Bedwars patterns',
            usage: '[<name> <regex>|<name> reset]',
            aliases: ['bwpatterns'],
            handler: (args, command) => {
                const overrides = ctx.store.get('patterns', {});
                const key = args[0];

                if (!key) {
                    const rows = Object.keys(DEFAULT_PATTERNS).map((name) => {
                        const custom = Boolean(overrides[name]);
                        const count = matches[name];
                        const state = count > 0
                            ? `&a${count} match${count === 1 ? '' : 'es'}`
                            : '&8never matched';
                        return ui.hover(
                            `&7${name.padEnd(10)} ${state}${custom ? ' &8(custom)' : ''}`,
                            [
                                `&f&l${name}`,
                                `&7${overrides[name] || DEFAULT_PATTERNS[name]}`,
                                '',
                                count > 0
                                    ? '&8This one is working.'
                                    : '&8Never seen. Either it has not happened yet,',
                                count > 0 ? '' : '&8or the wording is wrong. /capture to find out.'
                            ].filter(Boolean).join('\n')
                        );
                    });
                    ui.box('&7Chat patterns', rows, {
                        footer: '&8Fix one with &7/patterns <name> <regex>'
                    });
                    return undefined;
                }

                if (!DEFAULT_PATTERNS[key]) {
                    return command.error(`No pattern called "${key}". Try: ${Object.keys(DEFAULT_PATTERNS).join(', ')}`);
                }

                const value = args.slice(1).join(' ');
                if (!value) return command.error(`Usage: /patterns ${key} <regex>   or   /patterns ${key} reset`);

                if (value.toLowerCase() === 'reset') {
                    const next = { ...overrides };
                    delete next[key];
                    ctx.store.set('patterns', next);
                    return command.reply(`&7${key} is back to the default.`);
                }

                try {
                    new RegExp(value, 'i');
                } catch (err) {
                    return command.error(`Not a valid pattern: ${err.message}`);
                }
                ctx.store.set('patterns', { ...overrides, [key]: value });
                matches[key] = 0;
                return command.reply(`&7${key} now matches &f${value}&7.`);
            }
        });

        ctx.commands.register('bw', {
            description: 'Bedwars utility settings',
            usage: '[gg|trap|milk|effects|alerts <channels>|status]',
            handler: (args, command) => {
                const action = (args[0] || 'status').toLowerCase();
                const toggles = {
                    gg: 'autoGg',
                    trap: 'trapReminder',
                    milk: 'milkTimer',
                    effects: 'effectAlerts'
                };

                if (toggles[action]) {
                    const next = !setting(toggles[action]);
                    ctx.store.set(toggles[action], next);
                    return command.reply(`&f${action}&7 is now &f${next ? 'on' : 'off'}&7.`);
                }
                if (action === 'alerts') {
                    const wanted = args.slice(1).map((c) => c.toLowerCase()).filter((c) => ['chat', 'title', 'sound'].includes(c));
                    if (!wanted.length) return command.error('Usage: /bw alerts <chat|title|sound ...>');
                    ctx.store.set('alertChannels', wanted);
                    return command.reply(`Alert channels set to &f${wanted.join(', ')}&7.`);
                }
                if (action === 'test') {
                    ui.alert(channels(), { chat: '&7This is a test alert.', title: '&c&lTEST', sound: 'note.pling' });
                    return undefined;
                }
                if (action === 'status') {
                    ui.box('&7Bedwars utilities', [
                        `&7Auto GG        ${setting('autoGg') ? '&aon' : '&coff'}`,
                        `&7Trap reminder  ${setting('trapReminder') ? `&aon &8(${setting('trapSeconds')}s)` : '&coff'}`,
                        `&7Milk timer     ${setting('milkTimer') ? `&aon &8(${setting('milkSeconds')}s)` : '&coff'}`,
                        `&7Effect alerts  ${setting('effectAlerts') ? '&aon' : '&coff'}`,
                        null,
                        `&7Alert channels &f${channels().join(', ')}`,
                        null,
                        `&8patterns matched: ${Object.entries(matches).filter(([, n]) => n > 0).length}/${Object.keys(matches).length} &8\u00b7 /patterns`
                    ]);
                    return undefined;
                }
                return command.error(`Unknown action "${action}".`);
            }
        });
    }
};
