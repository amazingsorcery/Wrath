'use strict';

/**
 * Records raw server chat so broken chat patterns can be fixed.
 *
 *   /capture 60      record for 60s
 *   /capture stop    stop early
 *   /capture last    show what was caught
 *
 * Also written to data/logs/wrath.log.
 */

const DEFAULT_SECONDS = 60;
const MAX_KEPT = 200;

module.exports = {
    name: 'capture',
    version: '1.0.0',
    author: 'wrath',
    description: 'Record chat to fix dead patterns',

    init(ctx) {
        const ui = ctx.ui;

        let recording = false;
        let timer = null;
        let lines = [];
        let startedAt = 0;

        /** Which known patterns a line matches, for labelling the record. */
        function labelsFor(text) {
            const source = ctx.shared.get('bedwarsPatterns');
            if (typeof source !== 'function') return [];
            let patterns;
            try {
                patterns = source();
            } catch {
                return [];
            }
            return Object.entries(patterns)
                .filter(([, pattern]) => {
                    try {
                        return pattern.test(text);
                    } catch {
                        return false;
                    }
                })
                .map(([name]) => name);
        }

        ctx.on('chat', (event) => {
            if (!recording) return;
            const text = event.plain.trim();
            if (!text) return;

            const labels = labelsFor(text);
            lines.push({ text, labels, at: Date.now() });
            if (lines.length > MAX_KEPT) lines.shift();

            // log is the permanent copy
            ctx.log.info(`[capture]${labels.length ? ` [${labels.join(',')}]` : ''} ${text}`);
        });

        function stop(reason) {
            if (!recording) return false;
            recording = false;
            if (timer) ctx.clear(timer);
            timer = null;

            const matched = lines.filter((line) => line.labels.length).length;
            const seconds = Math.round((Date.now() - startedAt) / 1000);

            ui.box('&7Capture finished', [
                `&7Lines     &f${lines.length} &8over ${seconds}s`,
                `&7Matched   &f${matched} &8by a known pattern`,
                null,
                '&8Written to data/logs/wrath.log, search for [capture].',
                '&8Use /capture last to page through them here.',
                ...(matched === 0 && lines.length > 0
                    ? ['', '&eNothing matched a pattern.', '&8If something should have, /patterns will show which is dead.']
                    : [])
            ], { footer: reason ? `&8${reason}` : null });
            return true;
        }

        ctx.commands.register('capture', {
            description: 'Record chat to fix dead patterns',
            usage: '[seconds|stop|last|clear]',
            handler: (args, command) => {
                const action = (args[0] || '').toLowerCase();

                if (action === 'stop') {
                    if (!stop('stopped early')) return command.error('Nothing is being recorded.');
                    return undefined;
                }

                if (action === 'clear') {
                    lines = [];
                    return command.reply('Cleared the recording.');
                }

                if (action === 'last') {
                    if (!lines.length) return command.error('Nothing recorded yet. Run /capture first.');
                    const recent = lines.slice(-12);
                    ui.box(`&7Last &f${recent.length}&7 of &f${lines.length}`, recent.map((line) => {
                        const tag = line.labels.length ? `&a[${line.labels.join(',')}] ` : '&8';
                        const text = line.text.length > 44 ? `${line.text.slice(0, 43)}…` : line.text;
                        return ui.hover(`${tag}&7${text}`, [`&f${line.text}`, '', line.labels.length ? `&a matched: ${line.labels.join(', ')}` : '&8 matched nothing']);
                    }));
                    return undefined;
                }

                if (recording) return command.error('Already recording. /capture stop to finish.');

                const seconds = Math.max(5, Math.min(600, Number.parseInt(action, 10) || DEFAULT_SECONDS));
                recording = true;
                lines = [];
                startedAt = Date.now();
                timer = ctx.schedule(() => stop('time is up'), seconds * 1000);

                ui.box('&7Recording chat', [
                    `&7For &f${seconds}s&7, or until &f/capture stop`,
                    '&8Play a round and do the thing that should trigger,',
                    '&8then check /patterns to see whether it registered.'
                ]);
                ctx.sound.play('note.pling', { pitch: 90, volume: 0.4 });
                return undefined;
            }
        });

        ctx.on('session_end', () => stop('session ended'));
    }
};
