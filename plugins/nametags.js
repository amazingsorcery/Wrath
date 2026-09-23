'use strict';

/**
 * Shows a player's rating on their nametag.
 *
 * Nametag = team prefix + name + team suffix, and suffixes are per team, so each
 * tagged player gets moved onto their own team that copies hypixel's prefix.
 *
 * The 1.8 tab list sorts by team name, so new teams are named after the original
 * team + a padded counter to keep the order.
 *
 *   /nametags   toggle
 */

// team names max 16 chars in 1.8, must start with the original name
const TEAM_NAME_MAX = 16;
const COUNTER_DIGITS = 3;

// players with no team (empty name sorts first)
const NO_TEAM = '0';

// prefix/suffix max 16 chars, color codes included
const MAX_SUFFIX = 16;

const DEFAULTS = {
    enabled: true,
    showBadge: false,
    hideTeammates: true
};

module.exports = {
    name: 'nametags',
    version: '1.0.0',
    author: 'wrath',
    description: 'Ratings above players heads',

    init(ctx) {
        const ui = ctx.ui;
        const setting = (key) => {
            const value = ctx.store.get(key);
            return value === undefined ? DEFAULTS[key] : value;
        };

        // uuid -> { team, name, suffix }
        const tagged = new Map();
        // our team names, to tell our packets apart from the server's
        const ours = new Set();
        let counter = 0;
        let reapplyTimer = null;

        /**
         * Team name that sorts where the player already was. Zero padded because
         * the sort is lexicographic.
         */
        const teamNameFor = (playerName) => {
            counter = (counter + 1) % 1000;
            const original = ctx.teams.of(playerName);
            const base = (original && original.key) ? String(original.key) : NO_TEAM;
            const suffix = String(counter).padStart(COUNTER_DIGITS, '0');
            return base.slice(0, TEAM_NAME_MAX - suffix.length) + suffix;
        };

        /**
         * Suffix text. Max 16 chars incl. color codes, so use the fullest version
         * that fits instead of slicing (could cut a color code in half).
         */
        function suffixFor(player) {
            const colour = player.highlight || player.tier.colour;
            const rating = ` §8[§${colour}${player.rating}§8]`;
            const badge = player.badge ? ` §${player.badge.colour}${player.badge.value}${player.badge.suffix}` : '';
            const flag = player.tags && player.tags.length ? ` §5✘` : '';

            const candidates = setting('showBadge')
                ? [rating + badge + flag, rating + badge, rating + flag, rating]
                : [rating + flag, rating];

            for (const candidate of candidates) {
                if (candidate.length <= MAX_SUFFIX) return candidate;
            }
            // fallback: just the number
            return ` §${colour}${player.rating}`.slice(0, MAX_SUFFIX);
        }

        function apply(players) {
            if (!setting('enabled')) return;

            for (const player of players) {
                if (!player.name) continue;
                if (setting('hideTeammates') && player.teammate) continue;

                const suffix = suffixFor(player);
                const existing = tagged.get(player.name.toLowerCase());
                if (existing && existing.suffix === suffix) continue;

                // keep the server prefix (team color, rank)
                const original = ctx.teams.of(player.name);
                const prefix = (original && original.prefix) || '';
                const team = existing ? existing.team : teamNameFor(player.name);

                ctx.write('clientbound', 'scoreboard_team', {
                    team,
                    mode: existing ? 2 : 0,
                    name: team,
                    prefix,
                    suffix,
                    friendlyFire: 1,
                    nameTagVisibility: 'always',
                    color: 15,
                    ...(existing ? {} : { players: [player.name] })
                });

                ours.add(team);
                tagged.set(player.name.toLowerCase(), { team, name: player.name, suffix });
            }
        }

        function clearAll() {
            for (const entry of tagged.values()) {
                ctx.write('clientbound', 'scoreboard_team', { team: entry.team, mode: 1 });
            }
            tagged.clear();
            ours.clear();
        }

        ctx.on('autostats:scan', (event) => apply(event.players));

        // hypixel resends team packets and pulls players out of ours, reapply
        ctx.on('packet:scoreboard_team:clientbound', (event) => {
            if (!setting('enabled') || !tagged.size) return;
            // ignore our own packets
            if (event.data.team && ours.has(event.data.team)) return;

            const players = event.data.players || [];
            const stolen = players.some((name) => tagged.has(String(name).toLowerCase()));
            if (!stolen) return;

            if (reapplyTimer) ctx.clear(reapplyTimer);
            reapplyTimer = ctx.schedule(() => {
                reapplyTimer = null;
                const scan = ctx.shared.get('lastScanPlayers');
                if (scan) apply(scan);
            }, 250);
        });

        // Keep the last roster around so a re-apply has something to work from.
        ctx.on('autostats:scan', (event) => ctx.shared.set('lastScanPlayers', event.players));

        ctx.on('world_change', () => {
            // teams get wiped on server switch
            tagged.clear();
            ours.clear();
        });

        ctx.on('session_end', () => {
            tagged.clear();
            ours.clear();
        });

        ctx.commands.register('nametags', {
            description: 'Show ratings above players heads',
            usage: '[on|off|badge|teammates|status]',
            aliases: ['nt'],
            handler: (args, command) => {
                const action = (args[0] || 'toggle').toLowerCase();

                if (action === 'toggle' || action === 'on' || action === 'off') {
                    const next = action === 'toggle' ? !setting('enabled') : action === 'on';
                    ctx.store.set('enabled', next);
                    if (!next) clearAll();
                    else {
                        const scan = ctx.shared.get('lastScanPlayers');
                        if (scan) apply(scan);
                    }
                    return command.reply(`Nametag ratings &f${next ? 'on' : 'off'}&7.`);
                }
                if (action === 'badge') {
                    const next = !setting('showBadge');
                    ctx.store.set('showBadge', next);
                    clearAll();
                    const scan = ctx.shared.get('lastScanPlayers');
                    if (scan) apply(scan);
                    return command.reply(`Star on the nametag &f${next ? 'on' : 'off'}&7.`);
                }
                if (action === 'teammates') {
                    const next = !setting('hideTeammates');
                    ctx.store.set('hideTeammates', next);
                    return command.reply(`Teammates &f${next ? 'tagged too' : 'left alone'}&7.`);
                }

                ui.box('&7Nametags', [
                    `&7Showing     ${setting('enabled') ? '&aon' : '&coff'}`,
                    `&7Star too    &f${setting('showBadge') ? 'yes' : 'no'}`,
                    `&7Teammates   &f${setting('hideTeammates') ? 'left alone' : 'tagged too'}`,
                    `&7Tagged now  &f${tagged.size}`,
                    null,
                    '&8Text is appended to the floating nametag, which the',
                    '&8game only draws for players you can already see.'
                ]);
                return undefined;
            }
        });
    }
};
