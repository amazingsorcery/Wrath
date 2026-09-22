'use strict';

/**
 * Personal watchlist. Marks players in tab and alerts when they join.
 * Works without an API key.
 */
module.exports = {
    name: 'highlight',
    version: '2.1.0',
    author: 'wrath',
    description: 'Tag and announce watchlist players',

    init(ctx) {
        const ui = ctx.ui;

        // ignore the tab list burst when joining a lobby
        let settledAt = 0;
        ctx.on('world_change', () => {
            settledAt = Date.now() + 3000;
        });

        const list = () => ctx.store.get('names', []);
        const save = (names) => ctx.store.set('names', names);
        const watched = (name) => list().includes(String(name).toLowerCase());

        const tag = (player) => {
            if (!player || !watched(player.name)) return;
            ctx.display.set(player.uuid, { prefix: '§c◆ §r', suffix: '' });
        };

        ctx.on('player_join', (event) => {
            const player = event.player;
            if (!player.name || !watched(player.name)) return;
            tag(player);
            if (Date.now() < settledAt) return;
            ui.say(`&c◆ &f${player.name} &7is here.`);
            ctx.sound.play('note.pling', { pitch: 200, volume: 0.8 });
        });

        ctx.on('server_connect', () => {
            ctx.schedule(() => {
                for (const player of ctx.players.list()) tag(player);
            }, 2000);
        });

        /** Exposed so anticheat can add players. */
        ctx.shared.set('watchlist', {
            add: (playerName) => {
                const key = String(playerName).toLowerCase();
                if (list().includes(key)) return false;
                save([...list(), key]);
                const player = ctx.players.get(playerName);
                if (player) tag(player);
                return true;
            },
            has: (playerName) => watched(playerName),
            list: () => list()
        });

        ctx.commands.register('highlight', {
            description: 'Manage the watchlist',
            usage: '<add|remove|list|clear> [name]',
            aliases: ['hl'],
            handler: (args, command) => {
                const action = (args[0] || 'list').toLowerCase();
                const name = args[1] ? args[1].toLowerCase() : null;
                const names = list();

                if (action === 'list') {
                    if (!names.length) return ui.say('&7Watchlist is empty. &8/highlight add <name>');
                    return ui.box(`&7Watchlist &8(&f${names.length}&8)`, names.map((n) => `&c◆ &f${n}`));
                }
                if (action === 'clear') {
                    save([]);
                    return ui.say('&7Watchlist cleared.');
                }
                if (!name) return command.error(`Usage: /highlight ${action} <name>`);

                if (action === 'add') {
                    if (names.includes(name)) return command.error(`${name} is already on the list.`);
                    save([...names, name]);
                    const player = ctx.players.get(name);
                    if (player) tag(player);
                    return ui.say(`&7Added &f${name}&7.`);
                }
                if (action === 'remove') {
                    if (!names.includes(name)) return command.error(`${name} is not on the list.`);
                    save(names.filter((entry) => entry !== name));
                    const player = ctx.players.get(name);
                    if (player) ctx.display.clear(player.uuid);
                    return ui.say(`&7Removed &f${name}&7.`);
                }
                return command.error(`Unknown action "${action}".`);
            }
        });
    }
};
