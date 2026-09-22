'use strict';

/**
 * Hide chat lines that match a pattern, and optionally rewrite the ones that
 * get through. Shows how to cancel and modify a clientbound packet.
 */
module.exports = {
    name: 'chatfilter',
    version: '1.0.0',
    author: 'wrath',
    description: 'Hide or rewrite incoming chat lines',

    init(ctx) {
        const patterns = () => ctx.store.get('patterns', []);

        ctx.on('chat', (event) => {
            // Action bar and system lines are position 2; leave those alone.
            if (event.position === 2) return;

            const plain = event.plain;
            for (const pattern of patterns()) {
                let regex;
                try {
                    regex = new RegExp(pattern, 'i');
                } catch {
                    continue; // a bad pattern should not break chat
                }
                if (regex.test(plain)) {
                    event.cancel();
                    ctx.store.set('hidden', ctx.store.get('hidden', 0) + 1);
                    return;
                }
            }
        });

        ctx.commands.register('chatfilter', {
            description: 'Manage hidden chat patterns',
            usage: '<add|remove|list|stats> [regex]',
            aliases: ['cf'],
            handler: (args, command) => {
                const action = (args[0] || 'list').toLowerCase();
                const value = args.slice(1).join(' ');
                const current = patterns();

                if (action === 'list') {
                    if (!current.length) return command.reply('&7No filters. &8/chatfilter add <regex>');
                    current.forEach((pattern, index) => command.reply(`&8${index + 1}. &f${pattern}`));
                    return undefined;
                }
                if (action === 'stats') {
                    return command.reply(`&7Hidden so far: &f${ctx.store.get('hidden', 0)}`);
                }
                if (action === 'add') {
                    if (!value) return command.error('Usage: /chatfilter add <regex>');
                    try {
                        new RegExp(value);
                    } catch (err) {
                        return command.error(`Not a valid pattern: ${err.message}`);
                    }
                    ctx.store.set('patterns', [...current, value]);
                    return command.reply(`&7Now hiding lines matching &f${value}&7.`);
                }
                if (action === 'remove') {
                    const index = Number.parseInt(value, 10) - 1;
                    if (Number.isNaN(index) || !current[index]) return command.error('Give the number shown by /chatfilter list.');
                    const [removed] = current.splice(index, 1);
                    ctx.store.set('patterns', current);
                    return command.reply(`&7Removed &f${removed}&7.`);
                }
                return command.error(`Unknown action "${action}".`);
            }
        });
    }
};
