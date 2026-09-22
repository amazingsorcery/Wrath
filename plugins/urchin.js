'use strict';

/**
 * Urchin blacklist commands.
 *
 *   /v <player...>              check players
 *   /ws <player>                hidden winstreaks
 *   /session <player> [period]  gains today / this week
 *   /tag <player> <type> <why>  submit a tag (key needs permission)
 */

const TYPE_HELP = 'i, c, cc, bc, ccc, a, s, ls';

module.exports = {
    name: 'urchin',
    version: '1.1.0',
    author: 'wrath',
    description: 'Blacklist tags, winstreaks, sessions',

    init(ctx) {
        const ui = ctx.ui;

        const requireKey = (command) => {
            if (ctx.urchin.enabled) return true;
            command.error('No Urchin key saved. Run "wrath urchin <your-key>" in the terminal.');
            return false;
        };

        const tagRows = (tags) => {
            const rows = [];
            for (const tag of tags) {
                const meta = ctx.urchin.describe(tag.type);
                const when = tag.addedOn ? new Date(tag.addedOn * 1000).toISOString().slice(0, 10) : 'unknown';
                rows.push(ui.hover(
                    `&8[&${meta.colour}${meta.icon}&8] &${meta.colour}${meta.label}`,
                    [
                        `&${meta.colour}&l${meta.label}`,
                        `&7${tag.reason || 'No reason given.'}`,
                        `&8Added ${when}${tag.addedBy ? ` by ${tag.addedBy}` : ''}`
                    ].join('\n')
                ));
                if (tag.reason) rows.push(`&7  ${String(tag.reason).slice(0, 80)}`);
            }
            return rows;
        };

        ctx.commands.register('v', {
            description: 'Check Urchin tags for a player',
            usage: '<player...>',
            aliases: ['check'],
            handler: (args, command) => {
                if (!requireKey(command)) return;
                const names = args.length ? args : [ctx.players.self && ctx.players.self.name].filter(Boolean);
                if (!names.length) return command.error('Usage: /v <player>');

                ctx.actionBar(`${ui.brand()} &8» &7checking &f${names.length}&7...`);

                Promise.all(
                    names.slice(0, 10).map((name) =>
                        ctx.urchin
                            .player(name)
                            .then((result) => ({ name, result, error: null }))
                            .catch((error) => ({ name, result: null, error }))
                    )
                ).then((entries) => {
                    const rows = [];
                    let anyTags = false;

                    for (const entry of entries) {
                        if (entry.error) {
                            rows.push(`&8✖ &f${entry.name} &8- &c${entry.error.message}`);
                            continue;
                        }
                        const { tags, displayName } = entry.result;
                        const shown = displayName || `&f${entry.name}`;
                        if (!tags.length) {
                            rows.push(`&a✔ ${shown} &8- &7clean`);
                            continue;
                        }
                        anyTags = true;
                        rows.push(`&c✖ ${shown} &8- &c${tags.length} tag${tags.length === 1 ? '' : 's'}`);
                        rows.push(...tagRows(tags));
                    }

                    ui.box('&7Urchin check', rows);
                    ctx.sound.play(anyTags ? 'mob.wither.spawn' : 'note.pling', { volume: 0.5, pitch: anyTags ? 63 : 150 });
                });
                return undefined;
            }
        });

        /** Bedwars modes. */
        const MODE_ORDER = ['overall', 'core', 'solos', 'doubles', 'threes', 'fours', '4v4'];

        ctx.commands.register('ws', {
            description: 'Winstreaks, including hidden ones',
            usage: '<player>',
            aliases: ['streak'],
            handler: (args, command) => {
                if (!requireKey(command)) return;
                const target = args[0] || (ctx.players.self && ctx.players.self.name);
                if (!target) return command.error('Usage: /ws <player>');

                ctx.actionBar(`${ui.brand()} &8\u00bb &7rebuilding streaks for &f${target}&7...`);
                ctx.urchin
                    .winstreaks(target)
                    .then((result) => {
                        const shown = result.displayName || `&f${target}`;
                        if (!result.any) {
                            return ui.say(`${shown} &7has no reconstructed streaks on record.`);
                        }

                        const known = MODE_ORDER.filter((mode) => result.modes[mode]);
                        const rest = Object.keys(result.modes).filter((mode) => !MODE_ORDER.includes(mode));
                        const rows = [...known, ...rest].map((mode) => {
                            const entry = result.modes[mode];
                            const colour = entry.value >= 20 ? '4' : entry.value >= 10 ? 'c' : entry.value >= 5 ? '6' : 'e';
                            const flag = entry.approximate ? ' &8~' : '';
                            return `&7${mode.padEnd(9)} &${colour}${entry.value}${flag}`;
                        });

                        return ui.box(`${shown} &8\u00b7 &7winstreaks`, [
                            ...rows,
                            null,
                            '&8Rebuilt from snapshot history, because Hypixel',
                            '&8stopped exposing these. &8~ means inferred across a gap.'
                        ]);
                    })
                    .catch((err) => command.error(err.message));
                return undefined;
            }
        });

        ctx.commands.register('session', {
            description: 'What a player gained recently',
            usage: '<player> [daily|weekly|monthly]',
            aliases: ['delta'],
            handler: (args, command) => {
                if (!requireKey(command)) return;
                const target = args[0] || (ctx.players.self && ctx.players.self.name);
                if (!target) return command.error('Usage: /session <player> [daily|weekly|monthly]');
                const period = (args[1] || 'daily').toLowerCase();

                ctx.actionBar(`${ui.brand()} &8\u00bb &7checking &f${target}&7...`);
                ctx.urchin
                    .session(target, period)
                    .then((result) => {
                        const shown = result.displayName || `&f${target}`;
                        if (!result.changed || !result.summary.active) {
                            return ui.say(`${shown} &7has not played since &f${result.fromReadable}&7.`);
                        }

                        const bw = result.summary.bedwars;
                        const sw = result.summary.skywars;
                        const signed = (n) => (n > 0 ? `&a+${n}` : n < 0 ? `&c${n}` : '&80');
                        const rows = [];

                        if (bw.stars || bw.wins || bw.losses || bw.finalKills) {
                            rows.push('&b&lBEDWARS');
                            rows.push(`  &7stars   ${signed(bw.stars)}`);
                            rows.push(`  &7games   &f${result.summary.gamesPlayed}   &8${signed(bw.wins)}&8 W  ${signed(bw.losses)}&8 L`);
                            rows.push(`  &7finals  ${signed(bw.finalKills)}&8 / ${signed(bw.finalDeaths)}&8 deaths`);
                            rows.push(`  &7beds    ${signed(bw.bedsBroken)}`);
                            if (result.summary.gamesPlayed >= 3) {
                                const tier = ui.tier(result.summary.sessionFkdr);
                                rows.push(`  &7fkdr    &${tier.colour}${result.summary.sessionFkdr} &8this ${result.period.replace('ly', '')}`);
                            }
                        }
                        if (sw.wins || sw.kills) {
                            rows.push('&b&lSKYWARS');
                            rows.push(`  &7wins    ${signed(sw.wins)}   &7kills ${signed(sw.kills)}`);
                        }

                        return ui.box(`${shown} &8\u00b7 &7${result.period}`, rows, {
                            footer: `&8since ${result.fromReadable}`
                        });
                    })
                    .catch((err) => command.error(err.message));
                return undefined;
            }
        });

        ctx.commands.register('tag', {
            description: 'Submit an Urchin tag',
            usage: '<player> <type> <reason...>',
            handler: (args, command) => {
                if (!requireKey(command)) return;
                if (args.length < 3) {
                    command.error(`Usage: /tag <player> <type> <reason>`);
                    command.error(`Types: ${TYPE_HELP}`);
                    return;
                }
                const [player, type, ...rest] = args;
                const reason = rest.join(' ');

                ctx.urchin
                    .addTag(player, type, reason)
                    .then(() => {
                        ui.say(`&aTagged &f${player} &7as &f${type}&7.`);
                        ctx.sound.play('note.pling', { pitch: 180 });
                    })
                    .catch((err) => command.error(err.message));
                return undefined;
            }
        });
    }
};
