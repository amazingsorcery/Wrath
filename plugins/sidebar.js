'use strict';

/**
 * Custom scoreboard sidebar.
 *
 * Off by default since Hypixel uses the same slot. While it's on, the server's
 * attempts to take the slot are cancelled.
 *
 *   /sidebar        toggle
 *   /sidebar auto   only in waiting lobbies
 */

// max 15 lines, each one must be unique
const MAX_LINES = 15;
const OBJECTIVE = 'wrath';

// invisible padding to make duplicate lines unique
const UNIQUE = ['', '§r', '§0§r', '§1§r', '§2§r', '§3§r', '§4§r', '§5§r',
    '§6§r', '§7§r', '§8§r', '§9§r', '§a§r', '§b§r', '§c§r'];

const DEFAULTS = {
    enabled: false,
    autoInLobby: true,
    maxRows: 10
};

module.exports = {
    name: 'sidebar',
    version: '1.0.0',
    author: 'wrath',
    description: 'Live threat panel on the right',

    init(ctx) {
        const ui = ctx.ui;
        const setting = (key) => {
            const value = ctx.store.get(key);
            return value === undefined ? DEFAULTS[key] : value;
        };

        let showing = false;
        let lines = [];
        let lastScan = null;

        // --- drawing ---------------------------------------------------------

        /** Lines are ranked by score, so count downwards to keep our order. */
        function draw(newLines) {
            const wanted = newLines.slice(0, MAX_LINES).map((line, index) => {
                const unique = UNIQUE[index] || '';
                // score entries max 40 chars in 1.8
                return `${line}${unique}`.slice(0, 40);
            });

            if (!showing) {
                ctx.write('clientbound', 'scoreboard_objective', {
                    name: OBJECTIVE,
                    action: 0,
                    displayText: `${ui.brand()} §8»`,
                    type: 'integer'
                });
                ctx.write('clientbound', 'scoreboard_display_objective', { position: 1, name: OBJECTIVE });
                showing = true;
            } else {
                ctx.write('clientbound', 'scoreboard_objective', {
                    name: OBJECTIVE,
                    action: 2,
                    displayText: `${ui.brand()} §8»`,
                    type: 'integer'
                });
            }

            // Remove lines that are gone, then write the current ones.
            for (const old of lines) {
                if (!wanted.includes(old)) {
                    // itemName is the visible line; scoreName is the objective.
                    ctx.write('clientbound', 'scoreboard_score', { itemName: old, action: 1, scoreName: OBJECTIVE });
                }
            }
            wanted.forEach((line, index) => {
                ctx.write('clientbound', 'scoreboard_score', {
                    itemName: line,
                    action: 0,
                    scoreName: OBJECTIVE,
                    value: wanted.length - index
                });
            });

            lines = wanted;
        }

        function hide() {
            if (!showing) return;
            ctx.write('clientbound', 'scoreboard_objective', { name: OBJECTIVE, action: 1 });
            showing = false;
            lines = [];
            // give the slot back to the server
            const restore = ctx.shared.get('serverSidebar');
            ctx.write('clientbound', 'scoreboard_display_objective', { position: 1, name: restore || '' });
        }

        // don't let the server take the slot back
        ctx.on('packet:scoreboard_display_objective:clientbound', (event) => {
            if (event.data.position !== 1) return;
            if (event.data.name !== OBJECTIVE) ctx.shared.set('serverSidebar', event.data.name);
            if (showing && event.data.name !== OBJECTIVE) event.cancel();
        });

        // --- content ---------------------------------------------------------

        function build(scan) {
            const out = [];
            const mode = scan.mode;

            out.push(`§8${mode.label} §f${scan.counts.found}§8 players`);
            out.push('§8§m                    ');

            const rows = [...scan.players]
                .filter((player) => !player.teammate)
                .slice(0, setting('maxRows'));

            for (const player of rows) {
                const colour = player.highlight || player.tier.colour;
                const team = player.team ? `§${player.team.colour}▌ ` : '';
                const name = player.name.length > 13 ? `${player.name.slice(0, 12)}…` : player.name;
                out.push(`${team}§f${name} §${colour}${player.rating}`);
            }

            for (const nick of scan.nicked.slice(0, 3)) {
                out.push(`§d⬛ §d${nick.name.slice(0, 13)}`);
            }

            out.push('§8§m                    ');
            out.push(`§8avg §7${scan.average} §8worst §7${scan.worst}`);
            return out;
        }

        ctx.on('autostats:scan', (event) => {
            lastScan = event;
            if (!active()) return;
            draw(build(event));
        });

        const active = () => {
            if (setting('enabled')) return true;
            // auto = waiting lobbies only
            if (!setting('autoInLobby')) return false;
            return ctx.players.list().length > 0 && ctx.players.list().length <= 20;
        };

        ctx.on('world_change', () => {
            showing = false;
            lines = [];
            lastScan = null;
        });

        // --- command ---------------------------------------------------------

        ctx.commands.register('sidebar', {
            description: 'Wrath panel in the scoreboard slot',
            usage: '[on|off|auto|rows <n>|status]',
            handler: (args, command) => {
                const action = (args[0] || 'toggle').toLowerCase();

                if (action === 'toggle' || action === 'on' || action === 'off') {
                    const next = action === 'toggle' ? !setting('enabled') : action === 'on';
                    ctx.store.set('enabled', next);
                    if (next) {
                        if (lastScan) draw(build(lastScan));
                        else draw(['§7Waiting for a scan…', '§8/scan to force one']);
                        return command.reply('Sidebar on. The server scoreboard is hidden while it shows.');
                    }
                    hide();
                    return command.reply('Sidebar off. The server scoreboard is back.');
                }
                if (action === 'auto') {
                    const next = !setting('autoInLobby');
                    ctx.store.set('autoInLobby', next);
                    if (!next && !setting('enabled')) hide();
                    return command.reply(`Automatic lobby sidebar &f${next ? 'on' : 'off'}&7.`);
                }
                if (action === 'rows') {
                    const value = Number.parseInt(args[1], 10);
                    if (Number.isNaN(value)) return command.error('Usage: /sidebar rows <number>');
                    ctx.store.set('maxRows', Math.max(1, Math.min(MAX_LINES - 4, value)));
                    return command.reply(`Sidebar shows up to &f${setting('maxRows')}&7 players.`);
                }
                ui.box('&7Sidebar', [
                    `&7Always on   ${setting('enabled') ? '&aon' : '&coff'}`,
                    `&7In lobbies  ${setting('autoInLobby') ? '&aon' : '&coff'}`,
                    `&7Rows        &f${setting('maxRows')}`,
                    `&7Showing now &f${showing ? 'yes' : 'no'}`,
                    null,
                    '&8It borrows the slot Hypixel uses for bed status,',
                    '&8so it hands the slot back the moment you turn it off.'
                ]);
                return undefined;
            }
        });

        ctx.on('session_end', hide);
    }
};
