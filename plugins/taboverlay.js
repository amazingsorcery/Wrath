'use strict';

/**
 * Turns the tab list into a stats table.
 *
 * Each row = prefix (left columns) + hypixel's name + suffix (right columns).
 * The name is measured so the columns line up.
 *
 *   /tab           toggle
 *   /tab columns   pick columns
 */

// column widths in px, sized for typical values
const TEAM_W = 16;
const STAR_W = 38;
const NAME_W = 116;
const GAP = 4;

// x where the server's name starts
const NAME_X = TEAM_W + GAP + STAR_W + GAP;

// team marker, grey for no team so every row has the same layout
const TEAM_BAR = '\u258c';
const OWN_TEAM_BAR = '\u2503';

// first column label per game
const BADGE_TITLE = {
    bedwars: 'Stars',
    skywars: 'Lvl',
    duels: 'Wins'
};

const DEFAULTS = {
    enabled: true,
    columns: ['ws', 'finals', 'fkdr', 'wl', 'beds', 'bblr', 'ping', 'tags'],
    showHeader: true,
    showTeams: true,
    nudge: 0
};

/**
 * Column: width (px), value() returns colored text, modes = games it applies to.
 * Everything is right aligned.
 */
function buildColumns(ui) {
    // ratio -> tier color
    const ratio = (value, tiers) => {
        // missing stat shows as blank, not "undefi…"
        if (value === undefined || value === null || value === '') return '§8-';
        const number = Number.parseFloat(value);
        if (!Number.isFinite(number)) return '§8-';
        for (const [limit, colour] of tiers) {
            if (number < limit) return `§${colour}${value}`;
        }
        return `§4${value}`;
    };

    const RATIO_TIERS = [[1, '7'], [2, 'a'], [4, 'e'], [8, 'c']];
    const COUNT_TIERS = [[500, '7'], [2000, 'a'], [6000, 'e'], [15000, 'c']];

    return {
        ws: {
            title: 'WS',
            width: 26,
            modes: ['bedwars'],
            value: (p) => {
                const streak = p.stats.bedwars.winstreak;
                // null = API setting off, not the same as 0
                if (streak === null) return '§8-';
                if (streak >= 20) return `§6${streak}`;
                if (streak >= 5) return `§e${streak}`;
                return `§7${streak}`;
            }
        },
        finals: {
            title: 'Finals',
            width: 38,
            modes: ['bedwars'],
            value: (p) => ratio(p.stats.bedwars.finalKills, COUNT_TIERS)
        },
        fkdr: {
            title: 'FKDR',
            width: 32,
            modes: ['bedwars'],
            value: (p) => ratio(p.stats.bedwars.fkdr, RATIO_TIERS)
        },
        wl: {
            title: 'W/L',
            width: 30,
            modes: ['bedwars'],
            value: (p) => ratio(p.stats.bedwars.wlr, RATIO_TIERS)
        },
        wins: {
            title: 'Wins',
            width: 36,
            modes: ['bedwars'],
            value: (p) => ratio(p.stats.bedwars.wins, COUNT_TIERS)
        },
        beds: {
            title: 'Beds',
            width: 34,
            modes: ['bedwars'],
            value: (p) => ratio(p.stats.bedwars.bedsBroken, COUNT_TIERS)
        },
        bblr: {
            title: 'BBLR',
            width: 30,
            modes: ['bedwars'],
            value: (p) => ratio(p.stats.bedwars.bblr, RATIO_TIERS)
        },
        kd: {
            title: 'K/D',
            width: 30,
            modes: ['bedwars'],
            value: (p) => ratio(p.stats.bedwars.kdr, RATIO_TIERS)
        },
        level: {
            title: 'Lvl',
            width: 28,
            modes: ['skywars'],
            value: (p) => `§b${p.stats.skywars.level || '-'}`
        },
        kdr: {
            title: 'KDR',
            width: 30,
            modes: ['skywars'],
            value: (p) => ratio(p.stats.skywars.kdr, RATIO_TIERS)
        },
        swwins: {
            title: 'Wins',
            width: 36,
            modes: ['skywars'],
            value: (p) => ratio(p.stats.skywars.wins, COUNT_TIERS)
        },
        wlr: {
            title: 'WLR',
            width: 30,
            modes: ['duels'],
            value: (p) => ratio(p.stats.duels.wlr, RATIO_TIERS)
        },
        duelwins: {
            title: 'Wins',
            width: 38,
            modes: ['duels'],
            value: (p) => ratio(p.stats.duels.wins, COUNT_TIERS)
        },

        // shared columns
        ping: {
            title: 'Ping',
            width: 28,
            value: (p) => {
                if (p.ping === null || p.ping === undefined) return '§8-';
                if (p.ping < 0) return '§8-';
                if (p.ping < 80) return `§a${p.ping}`;
                if (p.ping < 200) return `§e${p.ping}`;
                return `§c${p.ping}`;
            }
        },
        tags: {
            title: 'Tags',
            width: 32,
            value: (p) => p.mark || ''
        }
    };
}

module.exports = {
    name: 'taboverlay',
    version: '1.0.0',
    author: 'wrath',
    description: 'Tab list as an aligned stats table',

    init(ctx) {
        const ui = ctx.ui;
        const font = ctx.font;
        const COLUMNS = buildColumns(ui);

        const setting = (key) => {
            const value = ctx.store.get(key);
            return value === undefined ? DEFAULTS[key] : value;
        };

        let lastHeader = null;
        let lastFooter = null;
        let lastScan = null;
        let headerRow = null;
        const rendered = new Set();

        /** The columns that apply to the game currently being played. */
        function activeColumns(modeKey) {
            return setting('columns')
                .map((key) => (COLUMNS[key] ? { key, ...COLUMNS[key] } : null))
                .filter(Boolean)
                .filter((column) => !column.modes || column.modes.includes(modeKey));
        }

        /** Right edge x of each column. */
        function offsets(columns) {
            let x = NAME_X + NAME_W;
            return columns.map((column) => {
                x += GAP + column.width;
                return { ...column, at: x };
            });
        }

        /** Blacklist cell: worst tag icon + count of the others. */
        function markFor(tags) {
            const list = tags || [];
            const worst = ctx.urchin.highest(list);
            if (!worst) return '';
            const meta = ctx.urchin.describe(worst.type);
            const extra = list.length > 1 ? `§8+${list.length - 1}` : '';
            return `§${meta.colour}${meta.icon}${extra}`;
        }

        /** Team bar + letter. Thicker bar for your own team. */
        function teamCell(playerName) {
            if (!setting('showTeams')) return '';
            const team = ctx.teams.of(playerName);
            if (!team) return `§8${TEAM_BAR}`;
            const mine = ctx.teams.isTeammate(playerName);
            const letter = String(team.label || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase();
            return `§${team.colour}${mine ? OWN_TEAM_BAR : TEAM_BAR}${letter}`;
        }

        // --- rendering -------------------------------------------------------

        function render(scan) {
            if (!setting('enabled') || !scan) return;

            const modeKey = scan.mode.key;
            const columns = offsets(activeColumns(modeKey));
            const registry = new Map(ctx.players.list().map((p) => [p.uuid, p]));

            for (const player of scan.players) {
                if (!player.uuid) continue;
                const live = registry.get(player.uuid);

                // measure hypixel's name so the later columns line up
                const base = live && live.displayName
                    ? ctx.util.toLegacy(live.displayName)
                    : (player.name || '');

                const row = {
                    ...player,
                    ping: live ? live.ping : null,
                    mark: markFor(player.tags)
                };

                const prefix = font.padRight(
                    font.layout([
                        // left aligned so the bar is in the same spot on every row
                        { text: teamCell(player.name), at: 0 },
                        { text: badgeCell(scan, player), at: TEAM_W + GAP + STAR_W, align: 'right' }
                    ]),
                    NAME_X
                );

                // suffix starts after the team bar, badge and name
                const drawn = NAME_X + font.width(base);
                const suffix = font.layout(
                    columns.map((column) => ({
                        text: safeValue(column, row),
                        at: column.at,
                        align: 'right'
                    })),
                    drawn
                );

                // pad to table width so the header stays centered
                const padded = suffix + font.spacer(total(columns) - (drawn + font.width(suffix)));
                ctx.display.set(player.uuid, { prefix, suffix: `§r${padded}` });
                rendered.add(player.uuid);
            }

            // unknown players still get a marker
            const unknown = [
                ...(scan.nicked || []).map((item) => ({ ...item, label: '§d[NICK]' })),
                ...(scan.failed || []).map((item) => ({ ...item, label: '§8[§o?§8]' }))
            ];
            for (const item of unknown) {
                if (!item.uuid) continue;
                ctx.display.set(item.uuid, {
                    prefix: font.padRight(`${teamCell(item.name)} ${item.label}`, NAME_X),
                    suffix: `§r ${markFor(item.tags)}`
                });
                rendered.add(item.uuid);
            }

            headerRow = setting('showHeader') ? buildHeader(scan, columns) : null;
            pushHeader();
        }

        /** Don't let one bad column break the whole tab list. */
        function safeValue(column, row) {
            try {
                const text = column.value(row);
                return text === undefined || text === null ? '' : font.truncate(String(text), column.width);
            } catch {
                return '§8-';
            }
        }

        /** The leftmost cell: Bedwars stars, SkyWars level, Duels wins. */
        function badgeCell(scan, player) {
            const badge = player.badge;
            if (!badge) return `§7${player.rating}`;
            const colour = badge.colour || '7';
            return font.truncate(`§${colour}${badge.value}${badge.suffix}`, STAR_W);
        }

        /** The pixel width every row and the header are padded out to. */
        function total(columns) {
            return columns.length ? columns[columns.length - 1].at : NAME_X + NAME_W;
        }

        function buildHeader(scan, columns) {
            const cells = [
                { text: `§8${BADGE_TITLE[scan.mode.key] || 'Lvl'}`, at: TEAM_W + GAP + STAR_W, align: 'right' },
                { text: '§8Player', at: NAME_X }
            ];
            for (const column of columns) {
                cells.push({ text: `§8${column.title}`, at: column.at, align: 'right' });
            }
            // header is centered on screen but the rows aren't, so they can be a few px off.
            // nudge fixes it by eye. padding one side by 2n moves it n px (positive = right)
            const line = font.padRight(font.layout(cells), total(columns));
            const nudge = Number(setting('nudge')) || 0;
            if (nudge > 0) return font.spacer(nudge * 2) + line;
            if (nudge < 0) return line + font.spacer(-nudge * 2);
            return line;
        }

        // --- the header packet -----------------------------------------------

        function decorateHeader(original) {
            const base = original ? ctx.util.toLegacy(original) : '';
            if (!headerRow || !setting('enabled')) return original;
            const block = base ? `${base}\n${headerRow}` : headerRow;
            return ctx.util.serialize(block);
        }

        function pushHeader() {
            if (!setting('enabled') || !headerRow) return;
            ctx.write('clientbound', 'playerlist_header', {
                header: decorateHeader(lastHeader),
                footer: lastFooter || ctx.util.serialize('')
            });
        }

        ctx.on('packet:playerlist_header:clientbound', (event) => {
            lastHeader = event.data.header;
            lastFooter = event.data.footer;
            if (!setting('enabled') || !headerRow) return;
            event.data.header = decorateHeader(lastHeader);
            event.markModified();
        });

        // autostats rewrites the footer packet, let it restore our header
        ctx.shared.set('tabHeader', {
            decorate: (original) => decorateHeader(original)
        });

        // stop autostats from writing tab entries too
        ctx.shared.set('tabOverlay', {
            active: () => setting('enabled')
        });

        // --- wiring ----------------------------------------------------------

        ctx.on('autostats:scan', (event) => {
            lastScan = event;
            render(event);
        });

        ctx.on('world_change', () => {
            headerRow = null;
            lastScan = null;
            rendered.clear();
        });

        ctx.on('session_end', () => {
            headerRow = null;
            lastScan = null;
            rendered.clear();
        });

        function clearAll() {
            for (const uuid of rendered) ctx.display.clear(uuid);
            rendered.clear();
            headerRow = null;
            if (lastHeader) {
                ctx.write('clientbound', 'playerlist_header', {
                    header: lastHeader,
                    footer: lastFooter || ctx.util.serialize('')
                });
            }
        }

        // --- command ---------------------------------------------------------

        ctx.commands.register('tab', {
            description: 'Stats table in the tab list',
            usage: '[on|off|columns|teams|add <col>|remove <col>|nudge <px>|reset|status]',
            handler: (args, command) => {
                const action = (args[0] || 'status').toLowerCase();
                const key = args[1] ? args[1].toLowerCase() : null;

                if (action === 'on' || action === 'off' || action === 'toggle') {
                    const next = action === 'toggle' ? !setting('enabled') : action === 'on';
                    ctx.store.set('enabled', next);
                    if (!next) clearAll();
                    else if (lastScan) render(lastScan);
                    return command.reply(`Tab table &f${next ? 'on' : 'off'}&7.`);
                }

                if (action === 'columns') {
                    const chosen = setting('columns');
                    return ui.box('&7Tab columns', [
                        ...Object.entries(COLUMNS).map(([name, column]) => {
                            const on = chosen.includes(name);
                            const scope = column.modes ? column.modes.join('/') : 'any game';
                            return ui.action(
                                `${on ? '&a●' : '&8○'} &f${name.padEnd(9)}&7${column.title.padEnd(7)}&8${scope}`,
                                `/tab ${on ? 'remove' : 'add'} ${name}`,
                                on ? '&7Click to remove this column' : '&7Click to add this column'
                            );
                        }),
                        null,
                        '&8Order follows the list above, left to right.'
                    ], { footer: '&8/tab reset puts the defaults back' });
                }

                if (action === 'add' || action === 'remove') {
                    if (!key) return command.error(`Usage: /tab ${action} <column>`);
                    if (!COLUMNS[key]) return command.error(`No column called "${key}". Try /tab columns.`);
                    const chosen = setting('columns');
                    if (action === 'add') {
                        if (chosen.includes(key)) return command.error(`${key} is already shown.`);
                        ctx.store.set('columns', [...chosen, key]);
                    } else {
                        if (!chosen.includes(key)) return command.error(`${key} is not shown.`);
                        ctx.store.set('columns', chosen.filter((c) => c !== key));
                    }
                    if (lastScan) render(lastScan);
                    return command.reply(`Column &f${key}&7 ${action === 'add' ? 'added' : 'removed'}.`);
                }

                if (action === 'teams') {
                    const next = !setting('showTeams');
                    ctx.store.set('showTeams', next);
                    if (lastScan) render(lastScan);
                    return command.reply(`Team markers &f${next ? 'on' : 'off'}&7.`);
                }

                if (action === 'nudge') {
                    if (key === null) return command.error('Usage: /tab nudge <pixels>, negative to go left');
                    const pixels = Number.parseInt(key, 10);
                    if (!Number.isFinite(pixels) || pixels < -40 || pixels > 40) {
                        return command.error('Give a number of pixels between -40 and 40.');
                    }
                    ctx.store.set('nudge', pixels);
                    if (lastScan) render(lastScan);
                    if (pixels === 0) return command.reply('Header left where it falls.');
                    return command.reply(`Header nudged &f${Math.abs(pixels)}px ${pixels > 0 ? 'right' : 'left'}&7. Hold Tab and check.`);
                }

                if (action === 'reset') {
                    ctx.store.set('columns', [...DEFAULTS.columns]);
                    if (lastScan) render(lastScan);
                    return command.reply('Columns back to the defaults.');
                }

                const chosen = setting('columns');
                return ui.box('&7Tab table', [
                    `&7Showing    ${setting('enabled') ? '&aon' : '&coff'}`,
                    `&7Header     &f${setting('showHeader') ? 'yes' : 'no'}`,
                    `&7Teams      &f${setting('showTeams') ? 'shown' : 'hidden'}`,
                    `&7Columns    &f${chosen.length ? chosen.join(', ') : 'none'}`,
                    `&7Rows drawn &f${rendered.size}`,
                    `&7Nudge      &f${setting('nudge')}px`,
                    null,
                    ui.action('&7Pick columns  &8→ &f/tab columns', '/tab columns', '&7Click to choose columns'),
                    '&8If the header titles sit slightly off the columns,',
                    '&8line them up with &7/tab nudge <pixels>&8. Negative',
                    '&8moves it left, positive moves it right.'
                ], { footer: '&8Hold Tab in game to see it' });
            }
        });
    }
};
