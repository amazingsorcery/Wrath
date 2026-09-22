'use strict';

/** Connect splash. Also a small example of the plugin API. */
module.exports = {
    name: 'welcome',
    version: '2.1.0',
    author: 'wrath',
    description: 'Splash screen when you connect',

    init(ctx) {
        const ui = ctx.ui;

        ctx.on('server_connect', (event) => {
            const joins = ctx.store.get('joins', 0) + 1;
            ctx.store.set('joins', joins);

            // Give the client a moment to finish loading the world.
            ctx.schedule(() => {
                ui.sweep('WRATH', `&8connected to &7${event.host}`, { frames: 10, interval: 60 });
                ctx.sound.play('random.orb', { volume: 0.5, pitch: 90 });

                ctx.schedule(() => {
                    ui.box(`&7ready &8· &7session &f#${joins}`, [
                        ui.action(`&7${'Scan this lobby'.padEnd(22)}&8→ &f/scan`, '/scan', '&7Click to scan every player here'),
                        ui.action(`&7${'Look someone up'.padEnd(22)}&8→ &f/stats`, '/stats', '&7Click, then type a name'),
                        ui.action(`&7${'Everything else'.padEnd(22)}&8→ &f/wrath help`, '/wrath help', '&7Click for the command list')
                    ], { footer: `${ctx.hypixel.enabled ? '&ahypixel' : '&8hypixel'} &8| ${ctx.urchin.enabled ? '&aurchin' : '&8urchin'}` });
                }, 700);
            }, 1500);
        });

        ctx.commands.register('wrathtest', {
            description: 'Show every visual element at once',
            aliases: ['wt'],
            handler: (args, command) => {
                const me = ctx.players.self;

                ui.box('&7visual test', [
                    ui.action('&7Click this line &8(runs /wrath version)', '/wrath version', ['&f&lClickable', '&7Rows can run commands.']),
                    ui.hover('&7Hover this line &8(tooltips work)', ['&f&lTooltip', '&7Any component can carry one.']),
                    `&7Gradient  ${ui.gradient('WRATH PROXY')}`,
                    `&7Ramps     ${ui.gradient('fire', 'fire')} ${ui.gradient('ice', 'ice')} ${ui.gradient('toxic', 'toxic')} ${ui.gradient('royal', 'royal')}`,
                    `&7Bar       ${ui.bar(7, 10)} &8 7/10`,
                    null,
                    `&7Tiers     ${ui.tier(12).tag} ${ui.tier(6).tag} ${ui.tier(3.5).tag} ${ui.tier(1.2).tag} ${ui.tier(0.4).tag}`,
                    `&7Ranks     ${ui.rankName('MVP++', 'Name')} ${ui.rankName('MVP+', 'Name')} ${ui.rankName('VIP', 'Name')}`,
                    `&7Players   &f${ctx.players.list().length} &7in tab list`,
                    me ? `&7Position  &f${me.position.x.toFixed(1)}, ${me.position.y.toFixed(1)}, ${me.position.z.toFixed(1)}` : '&8no position yet'
                ]);
                ui.sweep('WRATH', '&8visual test', { frames: 8, interval: 55 });
                ctx.sound.play('note.pling', { pitch: 120 });
                command.reply('&7Visual test complete.');
            }
        });
    }
};
