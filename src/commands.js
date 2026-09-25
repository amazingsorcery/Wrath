'use strict';

const chatUtil = require('./utils/chat');
const { create } = require('./utils/logger');

const log = create('commands');

const { RAMPS, THEMES, edgeRampFor } = require('./api/ui');
const font = require('./utils/font');

const ITEM = ' §8┃ ';

// 1.8 chat is 320px wide, longer lines wrap
const CHAT_WIDTH = 320;

/** Shorten a line to fit the chat width (measured in px, font isn't monospace). */
function fit(head, tail) {
    const room = CHAT_WIDTH - font.width(head);
    return head + (room > 24 ? font.truncate(tail, room) : '');
}

/** The wordmark, painted with whichever theme is in use. */
function brandFor(theme) {
    const ramp = RAMPS[theme.ramp] || RAMPS.fire;
    const text = 'WRATH';
    return [...text]
        .map((char, index) => {
            const colour = ramp[Math.min(ramp.length - 1, Math.round((index / (text.length - 1)) * (ramp.length - 1)))];
            return `§${colour}§l${char}`;
        })
        .join('');
}

/** A divider that fades in and out of the dark, in the theme's colours. */
function ruleFor(theme, width = 52) {
    const codes = edgeRampFor(theme.ramp);
    const base = Math.floor(width / codes.length);
    let remainder = width % codes.length;
    let out = '';
    for (const code of codes) {
        const length = base + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        if (length <= 0) continue;
        out += `§${code}§m${' '.repeat(length)}`;
    }
    return out;
}

/**
 * Handles commands typed by the player. Anything consumed here is cancelled
 * before it reaches the server, so the server never sees proxy commands.
 */
class CommandHandler {
    constructor(proxy) {
        this.proxy = proxy;
        this.commands = new Map(); // name -> definition
        this.aliases = new Map(); // alias -> name
        this.registerBuiltins();
    }

    /** The colours the player picked, or the default. */
    theme() {
        const stored = this.proxy.config.get('theme', {}) || {};
        return { ...(THEMES[stored.name] || THEMES.ember), ...stored };
    }

    prefix() {
        return `${brandFor(this.theme())} §8» §r`;
    }

    errorPrefix() {
        return `${brandFor(this.theme())} §8» §c`;
    }

    rule(width = 52) {
        return ruleFor(this.theme(), width);
    }

    // --- registration ------------------------------------------------------

    register(name, options = {}) {
        const key = String(name).toLowerCase().replace(/^\//, '');
        if (this.commands.has(key)) {
            log.warn(`Command "${key}" is already registered; ignoring the duplicate.`);
            return false;
        }
        if (typeof options.handler !== 'function') {
            log.warn(`Command "${key}" was registered without a handler.`);
            return false;
        }
        const definition = {
            name: key,
            description: options.description || '',
            usage: options.usage || '',
            aliases: (options.aliases || []).map((a) => String(a).toLowerCase()),
            handler: options.handler,
            plugin: options.plugin || null,
            builtin: Boolean(options.builtin)
        };
        this.commands.set(key, definition);
        for (const alias of definition.aliases) {
            if (!this.aliases.has(alias)) this.aliases.set(alias, key);
        }
        return true;
    }

    unregister(name, pluginName) {
        const key = String(name).toLowerCase();
        const definition = this.commands.get(key);
        if (!definition) return false;
        if (pluginName && definition.plugin !== pluginName) return false;
        this.commands.delete(key);
        for (const [alias, target] of [...this.aliases]) {
            if (target === key) this.aliases.delete(alias);
        }
        return true;
    }

    unregisterPlugin(pluginName) {
        for (const [key, definition] of [...this.commands]) {
            if (definition.plugin === pluginName) this.unregister(key, pluginName);
        }
    }

    resolve(token) {
        const key = String(token).toLowerCase();
        return this.commands.get(key) || this.commands.get(this.aliases.get(key)) || null;
    }

    // --- dispatch ----------------------------------------------------------

    /**
     * @returns {boolean} true when the message was consumed by the proxy.
     */
    handle(message, session) {
        if (typeof message !== 'string' || !message.startsWith('/')) return false;

        const prefix = this.proxy.config.get('commandPrefix', '/wrath').toLowerCase();
        const parts = message.trim().split(/\s+/);
        const head = parts[0].toLowerCase();

        if (head === prefix || head === '/wr') {
            this.runRoot(parts.slice(1), session);
            return true;
        }

        if (this.proxy.config.get('interceptPluginCommands', true)) {
            const definition = this.resolve(head.slice(1));
            if (definition && !definition.builtin) {
                this.run(definition, parts.slice(1), session);
                return true;
            }
        }
        return false;
    }

    run(definition, args, session) {
        const ctx = this.buildContext(session);
        try {
            definition.handler(args, ctx);
        } catch (err) {
            log.error(`Command /${definition.name} threw:`, err);
            ctx.error(`/${definition.name} failed: ${err.message}`);
        }
    }

    /**
     * How a command has to be typed. With interception off everything goes
     * behind /wrath so we don't shadow hypixel's /who /stats /tag.
     */
    invocation(name) {
        const root = this.proxy.config.get('commandPrefix', '/wrath');
        if (this.proxy.config.get('interceptPluginCommands', false)) return `/${name}`;
        return `${root} ${name}`;
    }

    /** Every name and alias that resolves to a command, longest first. */
    names() {
        const all = [...this.commands.keys(), ...this.aliases.keys()];
        return all.sort((a, b) => b.length - a.length);
    }

    /**
     * Rewrite /command mentions in text to match how commands are reachable.
     * Matches after a color code ("&f/scan") but not inside urls.
     */
    qualify(text) {
        if (typeof text !== 'string' || !text.includes('/')) return text;
        if (this.proxy.config.get('interceptPluginCommands', false)) return text;

        const names = this.names();
        if (!names.length) return text;

        const pattern = new RegExp(
            `(^|[&\u00a7][0-9a-fk-orA-FK-OR]|[^A-Za-z0-9/._-])/(${names.join('|')})\\b`,
            'g'
        );
        const root = this.proxy.config.get('commandPrefix', '/wrath');
        return text.replace(pattern, (match, lead, name) => `${lead}${root} ${name}`);
    }

    runRoot(args, session) {
        const ctx = this.buildContext(session);
        const sub = (args[0] || 'help').toLowerCase();
        const definition = this.commands.get(sub) || this.commands.get(this.aliases.get(sub));
        if (!definition) {
            ctx.error(`Unknown command "${sub}". Try ${this.proxy.config.get('commandPrefix')} help.`);
            return;
        }
        this.run(definition, args.slice(1), session);
    }

    buildContext(session) {
        // fix command mentions on output
        const paint = (text) => chatUtil.colourize(this.qualify(text));
        const reply = (text) => {
            if (session) session.sendClientbound('chat', { message: chatUtil.serialize(this.prefix() + paint(text)), position: 0 });
            else log.info(chatUtil.strip(paint(text)));
        };
        const error = (text) => {
            if (session) session.sendClientbound('chat', { message: chatUtil.serialize(this.errorPrefix() + paint(text)), position: 0 });
            else log.error(chatUtil.strip(paint(text)));
        };
        return {
            reply,
            error,
            raw: (text) => {
                if (session) session.sendClientbound('chat', { message: chatUtil.serialize(text), position: 0 });
            },
            session,
            proxy: this.proxy,
            api: this.proxy.api,
            config: this.proxy.config
        };
    }

    // --- built-in commands -------------------------------------------------

    registerBuiltins() {
        const root = () => this.proxy.config.get('commandPrefix', '/wrath');

        this.register('help', {
            description: 'List available commands',
            builtin: true,
            handler: (args, ctx) => {
                ctx.raw(this.rule());
                ctx.raw(` ${this.prefix()}§7command list`);

                const builtins = [...this.commands.values()].filter((c) => c.builtin);
                const plugins = [...this.commands.values()].filter((c) => !c.builtin);

                for (const command of builtins) {
                    const call = `${root()} ${command.name}`;
                    ctx.raw(fit(`${ITEM}§c${call.padEnd(22)}§8│ §7`, command.description));
                }
                if (plugins.length) {
                    ctx.raw(this.rule());
                    for (const command of plugins) {
                        // show the prefixed form
                        const call = this.invocation(command.name);
                        ctx.raw(fit(`${ITEM}§6${call.padEnd(22)}§8│ §7`, command.description));
                    }
                }
                ctx.raw(this.rule());
            }
        });

        this.register('version', {
            description: 'Show the proxy version',
            builtin: true,
            handler: (args, ctx) => {
                ctx.raw(this.rule());
                ctx.raw(` ${this.prefix()}§7version`);
                ctx.raw(`${ITEM}§7Wrath      §c§lv${this.proxy.version}`);
                ctx.raw(`${ITEM}§7Minecraft  §f1.8.9 §8(protocol 47)`);
                ctx.raw(`${ITEM}§7Node       §f${process.version}`);
                ctx.raw(this.rule());
            }
        });

        this.register('status', {
            description: 'Show connection status',
            builtin: true,
            handler: (args, ctx) => {
                const target = this.proxy.config.get('target');
                const session = ctx.session;
                const live = session && session.targetReady;
                const rate = this.proxy.hypixel.rate;

                ctx.raw(this.rule());
                ctx.raw(` ${this.prefix()}§7status`);
                ctx.raw(`${ITEM}§7Link      ${live ? '§a● connected' : '§c● offline'}`);
                ctx.raw(`${ITEM}§7Target    §f${target.host}§8:${target.port}`);
                if (session) {
                    ctx.raw(`${ITEM}§7Players   §f${session.players.list().length} §8tracked`);
                    ctx.raw(`${ITEM}§7Uptime    §f${Math.round((Date.now() - session.startedAt) / 1000)}s`);
                }
                ctx.raw(`${ITEM}§7API       ${this.proxy.hypixel.enabled ? `§a key saved §8(${rate.remaining === null ? '?' : `${rate.remaining}/${rate.limit}`})` : '§8 no key'}`);
                ctx.raw(this.rule());
            }
        });

        this.register('plugins', {
            description: 'List, enable or reload plugins',
            usage: '[enable|disable|reload] [name]',
            aliases: ['pl'],
            builtin: true,
            handler: (args, ctx) => {
                const action = (args[0] || 'list').toLowerCase();
                const api = this.proxy.api;
                if (action === 'list') {
                    const all = api.list();
                    if (!all.length) return ctx.reply('&7No plugins installed.');
                    ctx.reply(`&7Plugins (&f${all.length}&7):`);
                    for (const plugin of all) {
                        const state = plugin.enabled ? '&aon ' : '&coff';
                        const head = `  ${state} &f${plugin.name} &8v${plugin.version} &8- &7`.replace(/&/g, '§');
                        ctx.raw(fit(head, plugin.description));
                    }
                    return undefined;
                }
                if (action === 'reload') {
                    api.reloadAll();
                    return ctx.reply('&aReloaded all plugins.');
                }
                const name = args[1];
                if (!name) return ctx.error(`Usage: ${root()} plugins ${action} <name>`);
                const result = action === 'enable' ? api.enable(name) : action === 'disable' ? api.disable(name) : null;
                if (!result) return ctx.error(`Unknown action "${action}".`);
                return result.ok ? ctx.reply(`&a${action}d ${name}.`) : ctx.error(result.error);
            }
        });

        this.register('connect', {
            description: 'Change the target server',
            usage: '<host[:port]>',
            builtin: true,
            handler: (args, ctx) => {
                if (!args[0]) return ctx.error(`Usage: ${root()} connect <host[:port]>`);
                const [host, portText] = args[0].split(':');
                const port = portText ? Number.parseInt(portText, 10) : 25565;
                if (!host || Number.isNaN(port)) return ctx.error('Could not parse that address.');
                this.proxy.config.set('target', { host, port });
                ctx.reply(`&7Target set to &f${host}:${port}&7. Reconnect to apply.`);
                if (ctx.session) {
                    ctx.session.disconnect(`§aTarget changed to ${host}:${port}\n§7Reconnect to the proxy.`);
                }
                return undefined;
            }
        });

        this.register('key', {
            description: 'Check the Hypixel API key status',
            builtin: true,
            handler: (args, ctx) => {
                const api = this.proxy.hypixel;
                if (args.length) {
                    // don't take keys through chat, a typo would send it to the server
                    return ctx.error('Set your key from the terminal instead: wrath key <your-key>');
                }
                if (!api.enabled) return ctx.error('No Hypixel API key saved. Run "wrath key <your-key>" in the terminal.');
                const { remaining, limit } = api.rate;
                ctx.reply('&aA Hypixel API key is saved.');
                if (limit !== null) ctx.reply(`&7Quota: &f${remaining}&7/&f${limit} &7left this window.`);
                return undefined;
            }
        });

        this.register('errors', {
            description: 'Show recent plugin errors',
            builtin: true,
            handler: (args, ctx) => {
                const errors = this.proxy.api.errors;
                if ((args[0] || '').toLowerCase() === 'clear') {
                    errors.length = 0;
                    return ctx.reply('&7Cleared the error log.');
                }
                ctx.raw(this.rule());
                ctx.raw(` ${this.prefix()}§7recent errors`);
                if (!errors.length) {
                    ctx.raw(`${ITEM}§aNothing has failed this session.`);
                } else {
                    for (const entry of errors.slice(0, 8)) {
                        const ago = Math.round((Date.now() - entry.at) / 1000);
                        ctx.raw(`${ITEM}§c${entry.plugin} §8${ago}s ago`);
                        ctx.raw(`${ITEM}§8  ${String(entry.message).slice(0, 80)}`);
                    }
                }
                ctx.raw(this.rule());
                return undefined;
            }
        });

        this.register('theme', {
            description: 'Change the colours Wrath uses',
            usage: '[name]',
            builtin: true,
            handler: (args, ctx) => {
                const { THEMES } = require('./api/ui');
                const wanted = (args[0] || '').toLowerCase();
                const config = this.proxy.config;

                if (wanted && THEMES[wanted]) {
                    config.set('theme', { name: wanted, ...THEMES[wanted] });
                    ctx.reply(`Theme set to &f${THEMES[wanted].label}&7. Every panel follows it.`);
                    return undefined;
                }
                if (wanted) return ctx.error(`No theme called "${wanted}".`);

                const current = config.get('theme', {});
                ctx.raw(this.rule());
                ctx.raw(` ${this.prefix()}\u00a77themes`);
                for (const [name, theme] of Object.entries(THEMES)) {
                    const active = current.name === name || (!current.name && name === 'ember');
                    const swatch = ['\u258c', '\u258c', '\u258c'].map((block, index) =>
                        `\u00a7${[theme.primary, theme.accent, '8'][index]}${block}`).join('');
                    ctx.raw(`${ITEM}${swatch} \u00a7${theme.primary}${theme.label.padEnd(8)}\u00a78${active ? ' in use' : ''}`);
                }
                ctx.raw(`${ITEM}\u00a78${root()} theme <name>`);
                ctx.raw(this.rule());
                return undefined;
            }
        });

        this.register('config', {
            description: 'View or change proxy settings',
            usage: '[get <key>|set <key> <value>]',
            builtin: true,
            handler: (args, ctx) => {
                const action = (args[0] || 'list').toLowerCase();
                if (action === 'list') {
                    ctx.reply('&7Current settings:');
                    for (const [key, value] of Object.entries(this.proxy.config.data)) {
                        if (key === 'plugins') continue;
                        const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
                        ctx.raw(fit(`  §8${key}: §f`, shown));
                    }
                    return undefined;
                }
                if (action === 'get') {
                    if (!args[1]) return ctx.error(`Usage: ${root()} config get <key>`);
                    return ctx.reply(`&7${args[1]}: &f${JSON.stringify(this.proxy.config.get(args[1]))}`);
                }
                if (action === 'set') {
                    if (args.length < 3) return ctx.error(`Usage: ${root()} config set <key> <value>`);
                    const key = args[1];
                    const rawValue = args.slice(2).join(' ');
                    let value = rawValue;
                    if (rawValue === 'true') value = true;
                    else if (rawValue === 'false') value = false;
                    else if (/^-?\d+$/.test(rawValue)) value = Number.parseInt(rawValue, 10);
                    this.proxy.config.set(key, value);
                    return ctx.reply(`&7Set &f${key} &7to &f${JSON.stringify(value)}&7.`);
                }
                return ctx.error(`Unknown action "${action}".`);
            }
        });
    }
}

module.exports = { CommandHandler };
