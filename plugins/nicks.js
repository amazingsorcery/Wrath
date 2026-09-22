'use strict';

/**
 * Nick mapping. Remember who a nick is and use the real name everywhere.
 *
 *   /remap <nick> <realname>   save
 *   /remap <nick>              remove
 *   /nicks                     list
 */

const DEFAULTS = {
    showRealName: true,
    alertOnNick: true
};

module.exports = {
    name: 'nicks',
    version: '1.0.0',
    author: 'wrath',
    description: 'Map nicknames to real accounts',

    init(ctx) {
        const ui = ctx.ui;
        const setting = (key) => {
            const value = ctx.store.get(key);
            return value === undefined ? DEFAULTS[key] : value;
        };

        const all = () => ctx.store.get('map', {});
        const lookup = (nick) => all()[String(nick).toLowerCase()] || null;

        const save = (nick, real) => {
            const map = { ...all() };
            if (real) map[String(nick).toLowerCase()] = real;
            else delete map[String(nick).toLowerCase()];
            ctx.store.set('map', map);
        };

        /** Re-apply the tab-list decoration for every known nick on screen. */
        const decorateAll = () => {
            if (!setting('showRealName')) return;
            for (const player of ctx.players.list()) {
                const real = lookup(player.name);
                if (real) ctx.display.set(player.uuid, { prefix: '', suffix: ` §8(§f${real}§8)` });
            }
        };

        ctx.on('server_connect', () => ctx.schedule(decorateAll, 2500));
        ctx.on('world_change', () => ctx.schedule(decorateAll, 2500));

        ctx.on('player_join', (event) => {
            const real = lookup(event.player.name);
            if (!real) return;
            if (setting('showRealName')) {
                ctx.display.set(event.player.uuid, { prefix: '', suffix: ` §8(§f${real}§8)` });
            }
            if (setting('alertOnNick')) {
                ui.say(`&f${event.player.name} &7is &f${real}&7.`);
            }
        });

        ctx.commands.register('remap', {
            description: 'Map a nickname to a real account',
            usage: '<nick> [realname]',
            aliases: ['nick'],
            handler: (args, command) => {
                if (!args[0]) return command.error('Usage: /remap <nick> [realname]');
                const nick = args[0];
                const real = args[1];

                if (!real) {
                    if (!lookup(nick)) return command.error(`No mapping saved for ${nick}.`);
                    save(nick, null);
                    const player = ctx.players.get(nick);
                    if (player) ctx.display.clear(player.uuid);
                    return ui.say(`&7Forgot the mapping for &f${nick}&7.`);
                }

                save(nick, real);
                const player = ctx.players.get(nick);
                if (player && setting('showRealName')) {
                    ctx.display.set(player.uuid, { prefix: '', suffix: ` §8(§f${real}§8)` });
                }
                ui.say(`&f${nick} &8→ &f${real}&7. Stat lookups will follow the mapping.`);
                return undefined;
            }
        });

        ctx.commands.register('nicks', {
            description: 'List saved nickname mappings',
            usage: '[clear]',
            handler: (args, command) => {
                if ((args[0] || '').toLowerCase() === 'clear') {
                    ctx.store.set('map', {});
                    return ui.say('&7Cleared every nickname mapping.');
                }
                const map = all();
                const entries = Object.entries(map);
                if (!entries.length) return ui.say('&7No nickname mappings yet.\n&8Add one with &7/remap <nick> <name>');
                return ui.box(`&7Nicknames &8(&f${entries.length}&8)`, entries.map(([nick, real]) =>
                    ui.action(`&8${nick} &7→ &f${real}`, `/stats ${real}`, '&7Click for their stats')
                ));
            }
        });

        // for stat lookups
        ctx.shared.set('resolveNick', lookup);
    }
};
