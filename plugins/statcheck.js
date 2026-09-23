'use strict';

/**
 * Manual Hypixel lookups.
 *
 *   /stats <player>   stat card
 *   /who <player>     online status
 *   /guild <player>   guild info
 */

module.exports = {
    name: 'statcheck',
    version: '2.1.0',
    author: 'wrath',
    description: 'Hypixel stat cards on demand',

    init(ctx) {
        const ui = ctx.ui;

        /** Follow a saved nickname mapping, when the nicks plugin has one. */
        const resolve = (name) => {
            const resolver = ctx.shared.get('resolveNick');
            const real = resolver ? resolver(name) : null;
            return real || name;
        };

        const requireKey = (command) => {
            if (ctx.hypixel.enabled) return true;
            command.error('No Hypixel API key saved. Run "wrath key <your-key>" in the terminal.');
            return false;
        };

        /** Winstreaks are mostly hidden now, so show where the number came from. */
        function streakText(bw) {
            if (bw.winstreak === null || bw.winstreak === undefined) return '   &8streak hidden';
            if (!bw.winstreakSource) return `   &7streak &f${bw.winstreak}`;
            const approximate = bw.winstreakSource.endsWith('~');
            return `   &7streak &f${bw.winstreak} &8via urchin${approximate ? ' ~' : ''}`;
        }

        function card(stats) {
            const bw = stats.bedwars;
            const sw = stats.skywars;
            const tier = ui.tier(bw.fkdr);

            const heading = ui.hover(
                `${ui.rankName(stats.rank, stats.name)} &8· &7level &f${stats.networkLevel}`,
                ui.tooltip(stats)
            );

            ui.box(heading, [
                `&b&lBEDWARS`,
                `  &7star   &${ui.starColour(bw.star)}${bw.star}✫   &8${ui.bar(bw.star % 100, 100, 10, ui.starColour(bw.star))} &8next ${100 - (bw.star % 100)}✫`,
                `  &7fkdr   &${tier.colour}${bw.fkdr}   &8(${ui.short(bw.finalKills)} finals / ${ui.short(bw.finalDeaths)} deaths)`,
                `  &7wins   &f${ui.short(bw.wins)}   &8W/L ${bw.wlr}${streakText(bw)}`,
                `  &7threat &${tier.colour}&l${tier.label} &8${ui.bar(Math.min(bw.fkdr, 10), 10, 10, tier.colour)}`,
                null,
                `&b&lSKYWARS`,
                `  &7level  &f${sw.level || 'n/a'}   &7kdr &f${sw.kdr}   &7wins &f${ui.short(sw.wins)}`,
                `&b&lDUELS`,
                `  &7wlr    &f${stats.duels.wlr}   &7wins &f${ui.short(stats.duels.wins)}`,
                null,
                ui.line(
                    ui.action('&8[&aonline?&8]', `/who ${stats.name}`, '&7Click to check if they are online'),
                    ' ',
                    ui.action('&8[&dguild&8]', `/guild ${stats.name}`, '&7Click to show their guild'),
                    ' ',
                    ui.action('&8[&5tags&8]', `/v ${stats.name}`, '&7Click to check the Urchin blacklist'),
                    ' ',
                    ui.action('&8[&btoday&8]', `/session ${stats.name}`, '&7Click for what they have gained today'),
                    ' ',
                    ui.action('&8[&estreaks&8]', `/ws ${stats.name}`, '&7Click for winstreaks, including hidden ones')
                )
            ]);
            ctx.sound.play('note.pling', { pitch: 150, volume: 0.4 });
        }

        ctx.commands.register('stats', {
            description: 'Show a full Hypixel stat card',
            usage: '<player>',
            aliases: ['sc'],
            handler: (args, command) => {
                if (!requireKey(command)) return;
                const target = args[0] || (ctx.players.self && ctx.players.self.name);
                if (!target) return command.error('Usage: /stats <player>');

                // use the nick mapping if we have one
                const real = resolve(target);
                ctx.actionBar(`${ui.brand()} &8» &7looking up &f${real}&7...`);
                ctx.hypixel
                    .player(real)
                    .then(async (stats) => {
                        // winstreak hidden, try urchin
                        if (stats.bedwars.winstreak === null && ctx.urchin.enabled) {
                            try {
                                const streaks = await ctx.urchin.winstreaks(real);
                                const overall = streaks.modes.overall || streaks.modes.core;
                                if (overall) {
                                    stats.bedwars.winstreak = overall.value;
                                    stats.bedwars.winstreakSource = overall.approximate ? 'urchin~' : 'urchin';
                                }
                            } catch { /* the card is still worth showing without it */ }
                        }
                        card(stats);
                    })
                    .catch((err) => command.error(`&f${args[0]}&7: ${err.message}`));
                return undefined;
            }
        });

        ctx.commands.register('who', {
            description: 'Check whether a player is online',
            usage: '<player>',
            handler: (args, command) => {
                if (!requireKey(command)) return;
                if (!args[0]) return command.error('Usage: /who <player>');

                ctx.hypixel
                    .status(resolve(args[0]))
                    .then((session) => {
                        if (!session.online) return ui.say(`&f${args[0]} &7is &coffline&7.`);
                        const where = [session.gameType, session.mode, session.map].filter(Boolean).join(' &8/ &7');
                        return ui.say(`&f${args[0]} &7is &aonline &8· &7${where || 'unknown'}`);
                    })
                    .catch((err) => command.error(`&f${args[0]}&7: ${err.message}`));
                return undefined;
            }
        });

        ctx.commands.register('guild', {
            description: 'Show a player\'s guild',
            usage: '<player>',
            handler: (args, command) => {
                if (!requireKey(command)) return;
                if (!args[0]) return command.error('Usage: /guild <player>');

                ctx.hypixel
                    .guild(resolve(args[0]))
                    .then((guild) => {
                        if (!guild) return ui.say(`&f${args[0]} &7is not in a guild.`);
                        return ui.box(`&f&l${guild.name} &r&8[${guild.tag || '---'}]`, [
                            `&7Level   &f${guild.exp ? Math.floor(Math.sqrt(guild.exp / 100000)) : '?'}`,
                            `&7Members &f${(guild.members || []).length}`,
                            `&7Created &f${guild.created ? new Date(guild.created).toISOString().slice(0, 10) : 'unknown'}`
                        ]);
                    })
                    .catch((err) => command.error(`&f${args[0]}&7: ${err.message}`));
                return undefined;
            }
        });
    }
};
