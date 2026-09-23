'use strict';

/**
 * Auto lobby scan.
 *
 * When you join a game it waits for the tab list to settle, looks everyone up on
 * Hypixel and Urchin, and prints a table sorted by threat. Columns depend on the
 * game (bedwars / skywars / duels). Skips big main lobbies and caches lookups.
 *
 *   /scan        scan now
 *   /autostats   settings
 */

const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

// games start with a teleport, not a server switch, so chat is the only signal
const GAME_START = /Protect your bed and destroy the enemy beds|The game starts in 1 second|Cages open in|May the best (?:player|team) win/i;

// /who gives the full roster, more reliable than tab while the lobby fills
const WHO_LINE = /^ONLINE:\s*(.+)$/i;

const DEFAULTS = {
    enabled: true,
    maxPlayers: 20,
    minPlayers: 2,
    settleMs: 2500,
    concurrency: 3,
    tagTabList: true,
    tabSummary: true,
    checkTags: true,
    playSound: true,
    announceThreshold: 5,
    compact: false,
    gameStartScan: true,
    autoWho: true,
    nickAlerts: true,
    showTeams: true,
    alertTeammates: false,
    tabTable: true,
    tabRows: 8,
    highlightRules: [],
    manual: [],
    safelist: []
};

module.exports = {
    name: 'autostats',
    version: '1.4.0',
    author: 'wrath',
    description: 'Scans every lobby, ranked by threat',

    init(ctx) {
        const ui = ctx.ui;
        const rules = ctx.rules;
        const setting = (key) => {
            const value = ctx.store.get(key);
            return value === undefined ? DEFAULTS[key] : value;
        };

        // columns per game
        const MODES = {
            bedwars: {
                label: 'Bedwars',
                rating: (st) => st.bedwars.fkdr,
                ratingName: 'fkdr',
                badge: (st) => ({ value: st.bedwars.star, suffix: '\u272b', colour: ui.starColour(st.bedwars.star), width: 4 })
            },
            skywars: {
                label: 'SkyWars',
                rating: (st) => st.skywars.kdr,
                ratingName: 'kdr ',
                badge: (st) => ({ value: Number.parseFloat(st.skywars.level) || 0, suffix: '\u2726', colour: 'b', width: 4 })
            },
            duels: {
                label: 'Duels',
                rating: (st) => st.duels.wlr,
                ratingName: 'wlr ',
                badge: (st) => ({ value: st.duels.wins, suffix: 'w', colour: 'e', width: 5 })
            }
        };

        // default to bedwars
        const currentMode = () => MODES[ctx.game.mode] || MODES.bedwars;

        let settleTimer = null;
        let queuedAt = 0;
        let scanning = false;
        let scannedUuids = new Set();

        // keep hypixel's footer so we append to it instead of replacing it
        let compiled = null;
        let compiledSource = null;

        /** Compile the rule list once, then reuse it for every player. */
        function activeRules() {
            const list = setting('highlightRules').filter((r) => r.enabled !== false);
            const source = JSON.stringify(list);
            if (source !== compiledSource) {
                compiledSource = source;
                compiled = [];
                for (const rule of list) {
                    try {
                        compiled.push({ ...rule, test: rules.compile(rule.expression) });
                    } catch (err) {
                        ctx.log.warn(`Skipping rule "${rule.expression}": ${err.message}`);
                    }
                }
            }
            return compiled;
        }

        /** first match wins */
        function ruleColour(stats, extra) {
            for (const rule of activeRules()) {
                try {
                    if (rule.test(rules.variablesFor(stats, extra))) return rule.colour;
                } catch { /* a bad rule must not break the scan */ }
            }
            return null;
        }

        let lastHeader = null;
        let lastFooter = null;
        let summary = null;
        let tabRows = [];

        // --- lobby detection -------------------------------------------------

        const eligible = () => {
            const self = ctx.players.self;
            const selfName = self ? String(self.name).toLowerCase() : null;
            const fromTab = ctx.players
                .list()
                .filter((player) => player.name && NAME_PATTERN.test(player.name))
                .filter((player) => player.name.toLowerCase() !== selfName);

            // manually added players get scanned even if they're not in tab (party members etc)
            const seen = new Set(fromTab.map((p) => p.name.toLowerCase()));
            const manual = setting('manual')
                .filter((name) => !seen.has(String(name).toLowerCase()))
                .map((name) => ({ name, uuid: null, manual: true }));

            return [...fromTab, ...manual];
        };

        const queueScan = () => {
            if (!setting('enabled') || scanning) return;
            if (!ctx.hypixel.enabled && !ctx.urchin.enabled) return;

            const now = Date.now();
            if (!settleTimer) queuedAt = now;

            // cap the total wait, otherwise a steady stream of joins never lets it scan
            const waited = now - queuedAt;
            const maxWait = setting('settleMs') * 4;
            if (waited >= maxWait) {
                if (settleTimer) ctx.clear(settleTimer);
                settleTimer = null;
                scan({ auto: true });
                return;
            }

            if (settleTimer) ctx.clear(settleTimer);
            settleTimer = ctx.schedule(() => {
                settleTimer = null;
                scan({ auto: true });
            }, Math.min(setting('settleMs'), maxWait - waited));
        };

        ctx.on('world_change', () => {
            scannedUuids = new Set();
            summary = null;
            tabRows = [];
            if (settleTimer) ctx.clear(settleTimer);
            settleTimer = null;
            queuedAt = 0;
            queueScan();
        });

        ctx.on('player_join', () => queueScan());

        ctx.on('chat', (event) => {
            if (!setting('gameStartScan')) return;
            const line = event.plain.trim();
            if (!line) return;

            if (GAME_START.test(line)) {
                // rescan everyone once the match starts
                scannedUuids = new Set();
                if (setting('autoWho')) ctx.schedule(() => ctx.sendToServer('/who'), 600);
                else ctx.schedule(() => scan({ auto: true }), 900);
                return;
            }

            const who = WHO_LINE.exec(line);
            if (!who) return;
            const names = who[1]
                .split(/[,\s]+/)
                .map((name) => name.trim())
                .filter((name) => NAME_PATTERN.test(name));
            if (!names.length) return;
            scannedUuids = new Set();
            scan({ auto: true, extraNames: names });
        });

        // --- tab list footer -------------------------------------------------

        ctx.on('packet:playerlist_header:clientbound', (event) => {
            lastHeader = event.data.header;
            lastFooter = event.data.footer;
            if (!summary || !setting('tabSummary')) return;
            event.data.footer = decorateFooter(lastFooter);
            event.markModified();
        });

        function decorateFooter(original) {
            const base = original ? ctx.util.toLegacy(original) : '';
            const lines = [`${ui.brand()} §8» ${summary}`];

            // put the ranked list in the tab footer too
            const overlay = ctx.shared.get('tabOverlay');
            if (setting('tabTable') && tabRows.length && !(overlay && overlay.active())) {
                lines.push(...tabRows.slice(0, setting('tabRows')));
            }

            const block = lines.join('\n');
            return ctx.util.serialize(base ? `${base}\n${block}` : block);
        }

        function pushTabSummary() {
            if (!setting('tabSummary') || !summary) return;
            // header is in the same packet, let taboverlay restore its row
            const tabHeader = ctx.shared.get('tabHeader');
            const base = lastHeader || ctx.util.serialize('');
            ctx.write('clientbound', 'playerlist_header', {
                header: tabHeader ? tabHeader.decorate(base) : base,
                footer: decorateFooter(lastFooter)
            });
        }

        // --- the scan --------------------------------------------------------

        async function scan({ auto = false, command = null, extraNames = [] } = {}) {
            const report = command
                ? { say: (t) => command.reply(t), warn: (t) => command.error(t) }
                : { say: (t) => ui.say(t), warn: (t) => ui.warn(t) };

            if (!ctx.hypixel.enabled && !ctx.urchin.enabled) {
                report.warn('No API keys saved. Run "wrath key <key>" and "wrath urchin <key>".');
                return;
            }
            if (scanning) {
                report.warn('A scan is already running.');
                return;
            }
            // drop scans queued before auto scan got turned off
            if (auto && !setting('enabled')) return;

            const everyone = eligible();

            // merge in /who names tab hasn't caught up with yet
            const known = new Set(everyone.map((p) => String(p.name).toLowerCase()));
            for (const name of extraNames) {
                if (!known.has(name.toLowerCase())) everyone.push({ name, uuid: null });
            }

            const newcomers = everyone.filter((p) => !p.uuid || !scannedUuids.has(p.uuid));

            // always show the whole lobby, repeat lookups come from cache
            if (auto && newcomers.length < setting('minPlayers')) return;
            if (!everyone.length) {
                if (!auto) report.warn('Nobody here to scan.');
                return;
            }
            if (everyone.length > setting('maxPlayers')) {
                if (!auto) {
                    report.warn(`${everyone.length} players here, over the limit of ${setting('maxPlayers')}. Raise it with /autostats max <n>.`);
                }
                return;
            }

            scanning = true;
            const started = Date.now();

            // loading animation
            const frames = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '▊', '▋', '▌', '▍', '▎'];
            let frame = 0;
            ctx.actionBar(`${ui.brand()} §8» §7scanning §f${everyone.length}§7 players…`);
            const spinner = ctx.interval(() => {
                frame = (frame + 1) % frames.length;
                ctx.actionBar(`${ui.brand()} §8» §c${frames[frame]} §7reading §f${everyone.length}§7 players…`);
            }, 120);

            try {
                // look up the real account for remapped nicks
                const resolveNick = ctx.shared.get('resolveNick');
                const plan = everyone.map((player) => {
                    const alias = resolveNick ? resolveNick(player.name) : null;
                    return { player, alias, target: alias || player.uuid || player.name };
                });

                // hypixel takes names, urchin needs uuids
                const targets = plan.map((entry) => entry.target);
                const uuids = everyone.map((p) => p.uuid).filter(Boolean);

                // urchin batch = one request per lobby
                const [results, tags] = await Promise.all([
                    ctx.hypixel.enabled
                        ? ctx.hypixel.batch(targets, { concurrency: setting('concurrency') })
                        : Promise.resolve(targets.map((target) => ({ target, stats: null, error: null }))),
                    ctx.urchin.enabled && setting('checkTags') && uuids.length
                        ? ctx.urchin.lookup(uuids).catch((err) => {
                            ctx.log.warn(`Urchin lookup failed: ${err.message}`);
                            return new Map();
                        })
                        : Promise.resolve(new Map())
                ]);

                // players from /who have no uuid yet. fill them in from the hypixel
                // responses and ask urchin again for the ones we missed
                if (ctx.urchin.enabled && setting('checkTags')) {
                    const planByTarget = new Map(plan.map((entry) => [bare(entry.target), entry]));
                    const late = [];
                    for (const entry of results) {
                        if (!entry.stats || !entry.stats.uuid) continue;
                        const planned = planByTarget.get(bare(entry.target));
                        const player = planned && planned.player;
                        if (!player || player.uuid) continue;
                        player.uuid = entry.stats.uuid;
                        late.push(entry.stats.uuid);
                    }
                    if (late.length) {
                        const more = await ctx.urchin.lookup(late).catch((err) => {
                            ctx.log.warn(`Second Urchin lookup failed: ${err.message}`);
                            return new Map();
                        });
                        for (const [key, value] of more) tags.set(key, value);
                    }
                }

                for (const player of everyone) {
                    if (player.uuid) scannedUuids.add(player.uuid);
                }
                render(results, everyone, Date.now() - started, report, tags, plan);
            } catch (err) {
                report.warn(`Scan failed: ${err.message}`);
            } finally {
                ctx.clear(spinner);
                ctx.actionBar('');
                scanning = false;
            }
        }

        // --- presentation ----------------------------------------------------

        const bare = (value) => String(value || '').replace(/-/g, '').toLowerCase();

        /** Team color block, different one for your own team. */
        function teamMarker(playerName) {
            if (!setting('showTeams')) return '';
            const team = ctx.teams.of(playerName);
            if (!team) return '&8\u2595 ';
            const mine = ctx.teams.isTeammate(playerName);
            return `&${team.colour}${mine ? '\u2503' : '\u258c'} `;
        }

        /** The compact marker appended to a scan row, such as "[CCC]". */
        function tagMarker(tags) {
            const worst = ctx.urchin.highest(tags);
            if (!worst) return '';
            const meta = ctx.urchin.describe(worst.type);
            const extra = tags.length > 1 ? `&8+${tags.length - 1}` : '';
            return ` &8[&${meta.colour}${meta.icon}${extra}&8]`;
        }

        /** Tooltip lines describing every tag on a player. */
        function tagLines(tags) {
            if (!tags || !tags.length) return [];
            const lines = ['', '&5&lUrchin tags'];
            for (const tag of tags) {
                const meta = ctx.urchin.describe(tag.type);
                lines.push(`&8[&${meta.colour}${meta.icon}&8] &${meta.colour}${meta.label}`);
                if (tag.reason) lines.push(`&7  ${String(tag.reason).slice(0, 90)}`);
                if (tag.addedOn) {
                    const when = new Date(tag.addedOn * 1000).toISOString().slice(0, 10);
                    lines.push(`&8  added ${when}${tag.addedBy ? ` by ${tag.addedBy}` : ''}`);
                }
            }
            return lines;
        }

        function render(results, players, elapsed, report, tagMap = new Map(), plan = []) {
            const byUuid = new Map(players.map((p) => [bare(p.uuid || p.name), p]));
            const byTarget = new Map(plan.map((entry) => [bare(entry.target), entry]));

            const found = [];
            const nicked = [];
            const missing = [];
            const failed = [];

            for (const entry of results) {
                const planned = byTarget.get(bare(entry.target));
                const player = planned ? planned.player : byUuid.get(bare(entry.target));
                const shown = player ? player.name : entry.target;
                const tags = tagMap.get(bare(player && player.uuid)) || [];
                const common = { name: shown, uuid: player && player.uuid, tags, alias: planned && planned.alias };

                if (entry.stats) {
                    found.push({ ...common, stats: entry.stats });
                    continue;
                }

                // 404 from hypixel for someone in your game = nick.
                // for a name typed into /players it just means a typo.
                // any other error = lookup failed, not a nick
                const status = entry.error && entry.error.status;
                const reason = entry.error && entry.error.reason;
                const present = !(player && player.manual);

                if (status === 404 && present) nicked.push({ ...common, reason });
                else if (status === 404) missing.push(common);
                else failed.push({ ...common, reason: (entry.error && entry.error.message) || 'lookup failed' });
            }

            const severity = (item) => {
                const worst = ctx.urchin.highest(item.tags);
                return worst ? ctx.urchin.describe(worst.type).severity : 0;
            };

            const mode = currentMode();

            // A blacklist tag outranks any ratio, so tagged players sort first.
            found.sort((a, b) => severity(b) - severity(a) || mode.rating(b.stats) - mode.rating(a.stats));

            const compact = setting('compact');
            for (const item of found) item.team = ctx.teams.of(item.name);

            const rows = found.map((item) => {
                const rating = mode.rating(item.stats);
                const tier = ui.tier(rating);
                // highlight rule color overrides rank color
                const highlight = ruleColour(item.stats, { tagged: item.tags.length ? 1 : 0 });
                const colour = highlight || ui.rankColour(item.stats.rank);

                const mark = mode.badge(item.stats);
                const badge = `&${mark.colour}${String(mark.value).padStart(mark.width)}${mark.suffix}`;
                const score = `&${tier.colour}${String(rating).padStart(6)}`;
                // mapped nicks show as nick + real name
                const shownName = item.alias ? `${item.name} &8(&f${item.alias}&8)` : item.name.padEnd(16);
                const name = `&${colour}${shownName}`;
                const team = teamMarker(item.name);
                const label = compact
                    ? `${team}&r${name}&r&7${mode.ratingName}${score}${tagMarker(item.tags)}`
                    : `${tier.tag} ${team}&r${name}&r${badge} &7${mode.ratingName}${score}${tagMarker(item.tags)}`;
                return ui.action(
                    label,
                    `/stats ${item.name}`,
                    [ui.tooltip(item.stats, { clickHint: 'Click for the full card' }), ...tagLines(item.tags)].join('\n')
                );
            });

            // nicks get their own rows
            if (nicked.length) {
                rows.push(null);
                for (const item of nicked) {
                    rows.push(ui.action(
                        `&d&lNICK   &r&d${item.name.padEnd(16)}&r&8 ${item.reason === 'no-mojang-account' ? 'no such account' : 'no Hypixel record'}${tagMarker(item.tags)}`,
                        `/remap ${item.name} `,
                        [
                            `&d&l${item.name}`,
                            item.reason === 'no-mojang-account'
                                ? '&7No Minecraft account uses this name at all.'
                                : '&7Hypixel has no record of this account.',
                            '&7They are playing here right now, so the name is',
                            '&7not theirs. This is a nick.',
                            '',
                            `&8Click to start: /remap ${item.name} <their real name>`,
                            '&8Once mapped, scans show their real stats.',
                            ...tagLines(item.tags)
                        ].join('\n')
                    ));
                }
            }

            if (missing.length) {
                rows.push(`&8&oNo such account: &7${missing.map((u) => u.name).join(', ')} &8(check /players)`);
            }

            if (failed.length) {
                rows.push(null);
                rows.push(`&8&oLookup failed: &7${failed.map((u) => u.name).join(', ')}`);
            }

            if (!rows.length) {
                report.warn('Scan returned nothing.');
                return;
            }

            const safe = new Set(setting('safelist').map((n) => String(n).toLowerCase()));

            // don't alert on your own team (tags still show)
            const quietFor = (playerName) => safe.has(String(playerName).toLowerCase())
                || (!setting('alertTeammates') && ctx.teams.isTeammate(playerName));
            const tagged = [...found, ...nicked, ...missing, ...failed]
                .filter((item) => item.tags.length)
                .filter((item) => !quietFor(item.name));
            const ratings = found.map((f) => mode.rating(f.stats));
            const worstRating = ratings.length ? Math.max(...ratings) : 0;
            const average = ratings.length
                ? Math.round((ratings.reduce((sum, r) => sum + r, 0) / ratings.length) * 100) / 100
                : 0;

            const tagNote = tagged.length ? `&8, &c${tagged.length}&7 tagged` : '';
            const nickNote = nicked.length ? `&8, &d${nicked.length}&7 nicked` : '';
            const failNote = failed.length ? `&8, &7${failed.length} unreadable` : '';
            const modeNote = `&8[&7${mode.label}&8]`;
            ui.box(
                `${modeNote} &7scan &8· &f${found.length}&7 found${tagNote}${nickNote}${failNote} &8· &7${elapsed}ms`,
                rows,
                { footer: teamFooter(mode, average, worstRating) }
            );

            // compact rows for the footer
            tabRows = found.slice(0, setting('tabRows')).map((item) => {
                const rating = mode.rating(item.stats);
                const colour = ruleColour(item.stats, { tagged: item.tags.length ? 1 : 0 }) || ui.tier(rating).colour;
                const team = item.team ? `§${item.team.colour}▌ ` : '';
                const name = item.name.length > 14 ? `${item.name.slice(0, 13)}…` : item.name.padEnd(14);
                return `${team}§f${name} §${colour}${rating}`;
            });

            summary = [
                `§7${mode.label} §f${found.length + nicked.length + failed.length}`,
                nicked.length ? `§d${nicked.length} nicked` : null,
                tagged.length ? `§c${tagged.length} tagged` : '§aclean',
                `§7avg §f${average}`,
                `§7worst §${ui.tier(worstRating).colour}${worstRating}`
            ].filter(Boolean).join(' §8· ');

            // publish for sidebar / nametags / other plugins
            ctx.emit('scan', {
                mode: { key: ctx.game.mode, label: mode.label, ratingName: mode.ratingName.trim() },
                players: found.map((item) => {
                    const rating = mode.rating(item.stats);
                    const badge = mode.badge(item.stats);
                    return {
                        name: item.name,
                        uuid: item.uuid,
                        alias: item.alias || null,
                        rating,
                        tier: ui.tier(rating),
                        badge,
                        tags: item.tags,
                        stats: item.stats,
                        team: ctx.teams.of(item.name),
                        teammate: ctx.teams.isTeammate(item.name),
                        highlight: ruleColour(item.stats, { tagged: item.tags.length ? 1 : 0 })
                    };
                }),
                // team is the only thing we know about a nick
                nicked: nicked.map((item) => ({
                    name: item.name, uuid: item.uuid, tags: item.tags, reason: item.reason,
                    team: ctx.teams.of(item.name), teammate: ctx.teams.isTeammate(item.name)
                })),
                // keep nicks and failed lookups separate
                failed: failed.map((item) => ({
                    name: item.name, uuid: item.uuid, tags: item.tags,
                    team: ctx.teams.of(item.name), teammate: ctx.teams.isTeammate(item.name)
                })),
                counts: { found: found.length, nicked: nicked.length, failed: failed.length },
                average,
                worst: worstRating
            });

            // taboverlay owns tab entries when it's on
            const overlay = ctx.shared.get('tabOverlay');
            if (setting('tagTabList') && !(overlay && overlay.active())) {
                tagAll(found, [...nicked, ...failed], mode, nicked);
            }

            // alert on nicks
            const loudNicks = nicked.filter((item) => !quietFor(item.name));
            if (loudNicks.length && setting('nickAlerts')) {
                const names = loudNicks.map((n) => n.name).join('&7, &d');
                ui.say(`&d${loudNicks.length} nicked &7player${loudNicks.length === 1 ? '' : 's'} here: &d${names}`);
                if (setting('playSound')) ctx.sound.play('mob.bat.idle', { volume: 0.5, pitch: 110 });
            }
            pushTabSummary();

            // blacklist alert is the louder one
            if (tagged.length && setting('playSound')) {
                const first = tagged[0];
                const meta = ctx.urchin.describe(ctx.urchin.highest(first.tags).type);
                ctx.sound.play('mob.wither.spawn', { volume: 0.7, pitch: 63 });
                ui.sweep('BLACKLIST', `&f${first.name} &8- &${meta.colour}${meta.label}`, { frames: 6, interval: 60, ramp: 'royal' });
            } else if (setting('playSound') && worstRating >= setting('announceThreshold')) {
                const worstPlayer = found.find((f) => mode.rating(f.stats) === worstRating);
                if (worstPlayer && !quietFor(worstPlayer.name)) {
                    ctx.sound.play('mob.blaze.death', { volume: 0.6, pitch: 70 });
                    ui.sweep('THREAT', `&f${worstPlayer.name} &7has &c${mode.ratingName.trim().toUpperCase()} ${worstRating}`, { frames: 6, interval: 60, ramp: 'blood' });
                }
            }
        }

        /** Footer line: averages, plus a key to the team colours when known. */
        function teamFooter(mode, average, worstRating) {
            const base = `&8avg ${mode.ratingName.trim()} &7${average} &8\u00b7 worst &7${worstRating}`;
            const teams = setting('showTeams') ? ctx.teams.list() : [];
            if (!teams.length) return `${base} &8\u00b7 click a row for the full card`;

            const mine = ctx.teams.self;
            const key = teams
                .map((team) => `&${team.colour}${team.key === (mine && mine.key) ? '\u2503' : '\u258c'}${team.label}&8${team.members.size}`)
                .join(' ');
            return `${base} &8\u00b7 ${key}`;
        }

        function tagAll(found, unknown, mode = currentMode(), nicked = []) {
            const nickUuids = new Set(nicked.map((n) => bare(n.uuid)).filter(Boolean));
            const mark = (tags) => {
                const worst = ctx.urchin.highest(tags);
                if (!worst) return '';
                const meta = ctx.urchin.describe(worst.type);
                return ` §8[§${meta.colour}${meta.icon}§8]`;
            };

            for (const item of found) {
                if (!item.uuid) continue;
                const rating = mode.rating(item.stats);
                const tier = ui.tier(rating);
                const badge = mode.badge(item.stats);
                ctx.display.set(item.uuid, {
                    prefix: `§${tier.colour}[${badge.value}${badge.suffix}] §r`,
                    suffix: ` §8[§${tier.colour}${rating}§8]${mark(item.tags)}`
                });
            }
            for (const item of unknown) {
                if (!item.uuid) continue;
                const isNick = nickUuids.has(bare(item.uuid));
                ctx.display.set(item.uuid, {
                    prefix: isNick ? '§d[NICK] §r' : '§8[§o?§8] §r',
                    suffix: mark(item.tags)
                });
            }
        }

        // --- commands --------------------------------------------------------

        ctx.commands.register('scan', {
            description: 'Scan everyone in this lobby now',
            handler: (args, command) => {
                scannedUuids = new Set();
                scan({ auto: false, command });
            }
        });

        const listCommand = (key, label) => (args, command) => {
            const action = (args[0] || 'list').toLowerCase();
            const name = args[1];
            const current = setting(key);

            if (action === 'list') {
                if (!current.length) return ui.say(`&7The ${label} is empty.`);
                return ui.box(`&7${label} &8(&f${current.length}&8)`, current.map((n) => `&8\u2022 &f${n}`));
            }
            if (action === 'clear') {
                ctx.store.set(key, []);
                return ui.say(`&7Cleared the ${label}.`);
            }
            if (!name) return command.error(`Usage: ${action} <player>`);
            if (action === 'add') {
                if (current.some((n) => n.toLowerCase() === name.toLowerCase())) {
                    return command.error(`${name} is already on the ${label}.`);
                }
                ctx.store.set(key, [...current, name]);
                return ui.say(`&7Added &f${name} &7to the ${label}.`);
            }
            if (action === 'remove') {
                ctx.store.set(key, current.filter((n) => n.toLowerCase() !== name.toLowerCase()));
                return ui.say(`&7Removed &f${name} &7from the ${label}.`);
            }
            return command.error(`Unknown action "${action}".`);
        };

        ctx.commands.register('players', {
            description: 'Manually add players to every scan',
            usage: '<add|remove|list|clear> [player]',
            aliases: ['pladd'],
            handler: listCommand('manual', 'manual list')
        });

        ctx.commands.register('safe', {
            description: 'Players who never trigger an alert',
            usage: '<add|remove|list|clear> [player]',
            handler: listCommand('safelist', 'safelist')
        });

        ctx.commands.register('rules', {
            description: 'Colour players by a stat condition',
            usage: '<add <colour> <expr>|list|remove <n>|vars>',
            handler: (args, command) => {
                const action = (args[0] || 'list').toLowerCase();
                const current = setting('highlightRules');

                if (action === 'list') {
                    if (!current.length) {
                        return ui.box('&7Highlight rules', [
                            '&8No rules yet.',
                            '&7Try &f/rules add 4 fkdr > 10',
                            '&7Then &f/rules vars &7for what you can test.'
                        ]);
                    }
                    return ui.box(`&7Highlight rules &8(&f${current.length}&8)`, current.map((rule, index) =>
                        `&8${index + 1}. &${rule.colour}\u2588 &f${rule.expression}${rule.enabled === false ? ' &8(off)' : ''}`
                    ), { footer: '&8first match wins' });
                }
                if (action === 'vars') {
                    return ui.box('&7Rule variables', [
                        `&7${rules.VARIABLE_NAMES.join('&8, &7')}`,
                        null,
                        '&8operators: + - * / % ( ) < <= > >= = != && || !',
                        '&8example: &7star >= 300 && fkdr > 5'
                    ]);
                }
                if (action === 'clear') {
                    ctx.store.set('highlightRules', []);
                    return ui.say('&7Cleared every highlight rule.');
                }
                if (action === 'remove') {
                    const index = Number.parseInt(args[1], 10) - 1;
                    if (Number.isNaN(index) || !current[index]) return command.error('Give the number shown by /rules list.');
                    const next = [...current];
                    const [removed] = next.splice(index, 1);
                    ctx.store.set('highlightRules', next);
                    return ui.say(`&7Removed &f${removed.expression}&7.`);
                }
                if (action === 'add') {
                    const colour = args[1];
                    const expression = args.slice(2).join(' ');
                    if (!colour || !/^[0-9a-f]$/i.test(colour)) {
                        return command.error('Usage: /rules add <colour 0-9a-f> <expression>');
                    }
                    if (!expression) return command.error('Usage: /rules add <colour> <expression>');
                    try {
                        rules.compile(expression);
                    } catch (err) {
                        return command.error(`Bad rule: ${err.message}`);
                    }
                    ctx.store.set('highlightRules', [...current, { colour: colour.toLowerCase(), expression, enabled: true }]);
                    return ui.say(`&7Added rule &${colour}\u2588 &f${expression}&7.`);
                }
                return command.error(`Unknown action "${action}".`);
            }
        });

        ctx.commands.register('teams', {
            description: 'Show the teams in this game',
            handler: (args, command) => {
                const teams = ctx.teams.list();
                if (!teams.length) return command.error('The server has not set up any teams here.');

                const mine = ctx.teams.self;
                const rows = [];
                for (const team of teams) {
                    const yours = mine && team.key === mine.key;
                    rows.push(`&${team.colour}${yours ? '\u2503' : '\u258c'} &${team.colour}${team.label}&8 (${team.members.size})${yours ? ' &7your team' : ''}`);
                    const names = [...team.members]
                        .map((member) => {
                            const player = ctx.players.get(member);
                            return player ? player.name : member;
                        })
                        .sort();
                    rows.push(`&8  ${names.join(', ')}`);
                }
                ui.box(`&7Teams &8(&f${teams.length}&8)`, rows);
                return undefined;
            }
        });

        ctx.commands.register('autostats', {
            description: 'Automatic lobby scanning settings',
            usage: '[on|off|max <n>|delay <ms>|gamestart|who|nicks|teams|teammates|tab|footer|tags|sound|compact|status]',
            aliases: ['as'],
            handler: (args, command) => {
                const action = (args[0] || 'status').toLowerCase();

                if (action === 'on' || action === 'off') {
                    ctx.store.set('enabled', action === 'on');
                    return command.reply(`Automatic scanning is now &f${action}&7.`);
                }
                const toggles = {
                    gamestart: 'gameStartScan',
                    who: 'autoWho',
                    nicks: 'nickAlerts',
                    teams: 'showTeams',
                    teammates: 'alertTeammates',
                    tab: 'tagTabList',
                    footer: 'tabSummary',
                    tabtable: 'tabTable',
                    tags: 'checkTags',
                    sound: 'playSound',
                    compact: 'compact'
                };
                if (toggles[action]) {
                    const next = !setting(toggles[action]);
                    ctx.store.set(toggles[action], next);
                    return command.reply(`&f${action}&7 is now &f${next ? 'on' : 'off'}&7.`);
                }
                if (action === 'max' || action === 'delay') {
                    const value = Number.parseInt(args[1], 10);
                    if (Number.isNaN(value)) return command.error(`Usage: /autostats ${action} <number>`);
                    ctx.store.set(action === 'max' ? 'maxPlayers' : 'settleMs', value);
                    return command.reply(`Set &f${action}&7 to &f${value}&7.`);
                }
                if (action === 'status') {
                    const rate = ctx.hypixel.rateLimit;
                    ui.box('&7Autostats', [
                        `&7Game        &f${currentMode().label} &8${ctx.game.title ? `(${ctx.game.title})` : '(not detected)'}`,
                        `&7Scanning    ${setting('enabled') ? '&aon' : '&coff'}`,
                        `&7Lobby cap   &f${setting('maxPlayers')} players`,
                        `&7Settle wait &f${setting('settleMs')}ms`,
                        `&7Tab tags    &f${setting('tagTabList') ? 'on' : 'off'} &8| footer ${setting('tabSummary') ? 'on' : 'off'}`,
                        `&7Nick alerts ${setting('nickAlerts') ? '&aon' : '&coff'}`,
                        `&7Teams       ${setting('showTeams') ? `&aon &8(${ctx.teams.list().length} seen)` : '&coff'}`,
                        `&7Teammates   &f${setting('alertTeammates') ? 'alert like anyone else' : 'never alert'}`,
                        `&7Game start  &f${setting('gameStartScan') ? `&aon${setting('autoWho') ? ' &8(sends /who)' : ''}` : '&coff'}`,
                        `&7Tab table   &f${setting('tabTable') ? `on, ${setting('tabRows')} rows` : 'off'}`,
                        `&7Compact     &f${setting('compact') ? 'on' : 'off'} &8| rules ${setting('highlightRules').length} &8| manual ${setting('manual').length} &8| safe ${setting('safelist').length}`,
                        `&7Alerts      &f${setting('playSound') ? `on above FKDR ${setting('announceThreshold')}` : 'off'}`,
                        null,
                        `&7Hypixel     ${ctx.hypixel.enabled ? `&aon &8(${rate.remaining === null ? '?' : `${rate.remaining}/${rate.limit}`})` : '&8no key'}`,
                        `&7Urchin      ${ctx.urchin.enabled ? (setting('checkTags') ? '&aon' : '&7key saved, checking off') : '&8no key'}`
                    ]);
                    return undefined;
                }
                return command.error(`Unknown action "${action}".`);
            }
        });
    }
};
