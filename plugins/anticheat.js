'use strict';

/**
 * Flags suspicious movement from other players.
 *
 * Movement seen through a proxy is lossy (1/32 block, ~20 updates/s, lag), so
 * this only counts suspicious events and shows a tally. It is not proof.
 *
 * Read-only, never writes packets.
 *
 *   /flags       flags this game
 *   /anticheat   settings
 */

// 1.8 wire units: positions and relative moves are in 1/32 blocks, yaw and
// pitch are a byte covering 360 degrees, velocity is blocks per tick * 8000.
const POS = 32;
const ANGLE = 360 / 256;
const VELOCITY = 8000;

const DEFAULTS = {
    enabled: true,
    // most reliable checks
    checkVelocity: true,
    checkRotation: true,
    // noisier: jump pads, ladders and speed all trigger these
    checkSpeed: false,
    // placing blocks you can't be looking at
    checkScaffold: true,
    // perfect bridging run (weak, good players do this too)
    checkLegitScaffold: false,
    // swinging while blocking
    checkAutoBlock: true,
    // breaking blocks with no delay (noisy in bedwars)
    checkBreakDelay: false,
    // flags needed before it gets reported
    threshold: 4,
    announce: true,
    // auto add frequent offenders to the local watchlist (see autoWatch)
    autoWatch: false
};

// loose on purpose, a false flag is worse than a missed cheater
const LIMITS = {
    // bridging by hand needs a steep downward pitch
    bridgePitch: 25,
    // max distance for a block to count as under their feet
    bridgeReach: 2.0,
    // placements before the scaffold checks kick in
    scaffoldRun: 5,
    // clean run length that stops looking human
    perfectRun: 24,
    // sprint jumping peaks ~0.4 blocks/tick, speed II adds more
    speedPerTick: 0.62,
    // snap out and back within 3 ticks
    snapDegrees: 110,
    snapBackTicks: 3,
    // min fraction of the applied knockback they should move
    velocityKept: 0.25,
    // swings while the blocking flag is up. a couple is just timing
    autoBlockRun: 4,
    // vanilla has a cooldown between block breaks
    breakGapMs: 120,
    breakRun: 6
};

// 1.8 packs entity state into metadata key 0. Bit 0x10 is set while the
// player is using an item: blocking with a sword, eating, or drawing a bow.
const META_STATUS = 0;
const USING_ITEM = 0x10;
const SWING_ARM = 0;

module.exports = {
    name: 'anticheat',
    version: '1.3.0',
    author: 'wrath',
    description: 'Flags movement that looks wrong',

    init(ctx) {
        const ui = ctx.ui;
        const setting = (key) => {
            const value = ctx.store.get(key);
            return value === undefined ? DEFAULTS[key] : value;
        };

        // entityId -> tracking state
        const tracked = new Map();
        // lowercase name -> { checks: {name: count}, total, announced }
        const flags = new Map();

        const nameFor = (entityId) => {
            const player = ctx.players.byEntityId(entityId);
            return player ? player.name : null;
        };

        function state(entityId) {
            if (!tracked.has(entityId)) {
                tracked.set(entityId, {
                    x: null, y: null, z: null, yaw: null, pitch: 0,
                    lastMoveAt: 0, lastYawDelta: 0, lastYawAt: 0,
                    lastDx: 0, lastDz: 0,
                    pendingKnockback: null, effects: new Map(),
                    // bridging: run length + placements they weren't looking at
                    bridgeRun: 0, blindRun: 0, lastPlaceAt: 0,
                    blocking: false, blockedSwings: 0,
                    lastBreakAt: 0, fastBreaks: 0
                });
            }
            return tracked.get(entityId);
        }

        function flag(entityId, check, detail) {
            const name = nameFor(entityId);
            if (!name) return;
            // skip yourself and your team
            const self = ctx.players.self;
            if (self && name.toLowerCase() === String(self.name).toLowerCase()) return;

            const key = name.toLowerCase();
            const entry = flags.get(key) || { name, checks: {}, total: 0, announced: 0, last: '' };
            entry.checks[check] = (entry.checks[check] || 0) + 1;
            entry.total += 1;
            entry.last = detail || check;
            flags.set(key, entry);

            const limit = setting('threshold');

            // local watchlist only, never auto submit to urchin since these checks aren't proof
            if (setting('autoWatch') && entry.total >= limit && !entry.watched) {
                const watchlist = ctx.shared.get('watchlist');
                if (watchlist && watchlist.add(name)) {
                    entry.watched = true;
                    ui.say(`&7Added &f${name}&7 to your watchlist. &8Not reported to anyone.`);
                }
            }

            if (setting('announce') && entry.total >= limit && entry.total - entry.announced >= limit) {
                entry.announced = entry.total;
                ui.say(`&e⚠ &f${name} &7has looked wrong &f${entry.total}&7 times &8(${Object.keys(entry.checks).join(', ')})`);
                ctx.sound.play('note.bass', { pitch: 70, volume: 0.4 });
            }
        }

        // --- movement --------------------------------------------------------

        function moved(entityId, dx, dy, dz, ticks) {
            const st = state(entityId);
            const horizontal = Math.hypot(dx, dz);

            // no knockback taken after a hit
            if (st.pendingKnockback && setting('checkVelocity')) {
                const kb = st.pendingKnockback;
                const expected = Math.hypot(kb.x, kb.z);
                if (expected > 0.15) {
                    const kept = horizontal / expected;
                    if (kept < LIMITS.velocityKept) {
                        flag(entityId, 'velocity', `kept ${Math.round(kept * 100)}% of knockback`);
                    }
                }
                st.pendingKnockback = null;
            }

            if (setting('checkSpeed') && ticks > 0) {
                const perTick = horizontal / ticks;
                // speed potion raises the limit
                const speed = st.effects.get(1);
                const allowance = LIMITS.speedPerTick * (1 + 0.2 * ((speed || 0) + (speed ? 1 : 0)));
                if (perTick > allowance) {
                    flag(entityId, 'speed', `${perTick.toFixed(2)} blocks/tick`);
                }
            }
        }

        ctx.observe('entity_teleport', (event) => {
            if (!setting('enabled')) return;
            const st = state(event.data.entityId);
            const x = event.data.x / POS;
            const y = event.data.y / POS;
            const z = event.data.z / POS;
            // teleport = server correction, reset the baseline
            st.x = x;
            st.y = y;
            st.z = z;
            st.lastMoveAt = Date.now();
            st.pendingKnockback = null;
        });

        const relative = (event) => {
            if (!setting('enabled')) return;
            const id = event.data.entityId;
            const st = state(id);
            const dx = event.data.dX / POS;
            const dy = event.data.dY / POS;
            const dz = event.data.dZ / POS;

            const now = Date.now();
            const ticks = st.lastMoveAt ? Math.max(1, Math.round((now - st.lastMoveAt) / 50)) : 1;
            st.lastMoveAt = now;

            if (st.x !== null) {
                st.x += dx;
                st.y += dy;
                st.z += dz;
            }
            st.lastDx = dx;
            st.lastDz = dz;
            moved(id, dx, dy, dz, ticks);
        };

        ctx.observe('rel_entity_move', relative);
        ctx.observe('entity_move_look', (event) => {
            relative(event);
            rotated(event);
        });
        ctx.observe('entity_look', (event) => {
            if (!setting('enabled')) return;
            rotated(event);
        });

        // --- rotation --------------------------------------------------------

        function rotated(event) {
            if (!setting('enabled')) return;
            const id = event.data.entityId;
            const st = state(id);
            const yaw = event.data.yaw * ANGLE;

            // always track pitch, the scaffold check needs it
            if (event.data.pitch !== undefined) st.pitch = event.data.pitch * ANGLE;

            if (setting('checkRotation') && st.yaw !== null) {
                let delta = yaw - st.yaw;
                // Wrap to the shortest way round, so 359 to 1 is 2, not 358.
                while (delta > 180) delta -= 360;
                while (delta < -180) delta += 360;

                const now = Date.now();
                const sinceLast = st.lastYawAt ? (now - st.lastYawAt) / 50 : 99;

                // snap out and straight back = aim assist
                if (Math.abs(delta) > LIMITS.snapDegrees
                    && Math.abs(st.lastYawDelta) > LIMITS.snapDegrees
                    && Math.sign(delta) !== Math.sign(st.lastYawDelta)
                    && sinceLast <= LIMITS.snapBackTicks) {
                    flag(id, 'rotation', `snapped ${Math.round(Math.abs(delta))} degrees and back`);
                }

                st.lastYawDelta = delta;
                st.lastYawAt = now;
            }
            st.yaw = yaw;
        }

        // --- context ----------------------------------------------------------

        ctx.observe('named_entity_spawn', (event) => {
            const st = state(event.data.entityId);
            st.x = event.data.x / POS;
            st.y = event.data.y / POS;
            st.z = event.data.z / POS;
            st.yaw = (event.data.yaw || 0) * ANGLE;
            st.pitch = (event.data.pitch || 0) * ANGLE;
            st.lastMoveAt = Date.now();
        });

        // --- bridging ---------------------------------------------------------

        /** Player standing on top of a block that just got placed. */
        /** The closest tracked player to a point, within a radius. */
        function nearestTo(bx, by, bz, radius) {
            let best = null;
            let bestDistance = radius;
            for (const [entityId, st] of tracked) {
                if (st.x === null) continue;
                const distance = Math.hypot(st.x - (bx + 0.5), st.y - by, st.z - (bz + 0.5));
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = entityId;
                }
            }
            return best;
        }

        function placerOf(bx, by, bz) {
            let best = null;
            let bestDistance = LIMITS.bridgeReach;
            for (const [entityId, st] of tracked) {
                if (st.x === null) continue;
                const above = st.y - by;
                if (above < 0.2 || above > 2.6) continue;
                const distance = Math.hypot(st.x - (bx + 0.5), st.z - (bz + 0.5));
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = entityId;
                }
            }
            return best;
        }

        function blockPlaced(bx, by, bz) {
            if (!setting('enabled')) return;
            if (!setting('checkScaffold') && !setting('checkLegitScaffold')) return;

            const entityId = placerOf(bx, by, bz);
            if (entityId === null) return;
            const st = tracked.get(entityId);

            const now = Date.now();
            // gap resets the run
            if (now - st.lastPlaceAt > 1200) {
                st.bridgeRun = 0;
                st.blindRun = 0;
            }
            st.lastPlaceAt = now;
            st.bridgeRun += 1;

            // yaw 0 = south, increases clockwise
            const radians = (st.yaw * Math.PI) / 180;
            const facingX = -Math.sin(radians);
            const facingZ = Math.cos(radians);
            const movingBackwards = (st.lastDx * facingX + st.lastDz * facingZ) < -0.02;

            // placing under yourself while barely looking down
            const blind = Math.abs(st.pitch) < LIMITS.bridgePitch;
            st.blindRun = blind && movingBackwards ? st.blindRun + 1 : 0;

            if (setting('checkScaffold') && st.blindRun === LIMITS.scaffoldRun) {
                flag(entityId, 'scaffold', `${st.blindRun} blocks placed at ${Math.round(st.pitch)} degrees`);
                st.blindRun = 0;
            }

            if (setting('checkLegitScaffold') && st.bridgeRun > 0 && st.bridgeRun % LIMITS.perfectRun === 0) {
                flag(entityId, 'legit scaffold', `${st.bridgeRun} blocks without a miss`);
            }
        }

        ctx.observe('block_change', (event) => {
            const at = event.data.location || {};
            // type 0 = air, block was broken
            if (!event.data.type) blockBroken(at.x, at.y, at.z);
            else blockPlaced(at.x, at.y, at.z);
        });

        ctx.observe('multi_block_change', (event) => {
            const records = event.data.records || [];
            // big batch = chunk loading
            if (records.length > 8) return;
            for (const record of records) {
                const packed = record.horizontalPos;
                const x = (event.data.chunkX * 16) + ((packed >> 4) & 0xf);
                const z = (event.data.chunkZ * 16) + (packed & 0xf);
                if (!record.blockId) blockBroken(x, record.y, z);
                else blockPlaced(x, record.y, z);
            }
        });

        // --- blocking and breaking -------------------------------------------

        ctx.observe('entity_metadata', (event) => {
            if (!setting('enabled')) return;
            const entries = event.data.metadata;
            if (!Array.isArray(entries)) return;
            const status = entries.find((entry) => entry && entry.key === META_STATUS);
            if (!status) return;
            const value = Number(status.value);
            if (!Number.isFinite(value)) return;
            state(event.data.entityId).blocking = (value & USING_ITEM) !== 0;
        });

        ctx.observe('animation', (event) => {
            if (!setting('enabled') || !setting('checkAutoBlock')) return;
            if (event.data.animation !== SWING_ARM) return;

            const st = state(event.data.entityId);
            if (!st.blocking) {
                st.blockedSwings = 0;
                return;
            }

            // unblocking to swing takes a tick, so a stream of swings with block still up = autoblock
            st.blockedSwings += 1;
            if (st.blockedSwings >= LIMITS.autoBlockRun) {
                flag(event.data.entityId, 'autoblock', `${st.blockedSwings} swings while still blocking`);
                st.blockedSwings = 0;
            }
        });

        function blockBroken(bx, by, bz) {
            if (!setting('enabled') || !setting('checkBreakDelay')) return;
            const entityId = nearestTo(bx, by, bz, 5.5);
            if (entityId === null) return;

            const st = tracked.get(entityId);
            const now = Date.now();
            const gap = now - st.lastBreakAt;
            st.lastBreakAt = now;

            if (gap > 0 && gap < LIMITS.breakGapMs) {
                st.fastBreaks += 1;
                if (st.fastBreaks >= LIMITS.breakRun) {
                    flag(entityId, 'break delay', `${st.fastBreaks} breaks ${gap}ms apart`);
                    st.fastBreaks = 0;
                }
            } else if (gap > 400) {
                st.fastBreaks = 0;
            }
        }

        ctx.observe('entity_velocity', (event) => {
            if (!setting('enabled')) return;
            const st = state(event.data.entityId);
            const v = event.data.velocity || {};
            st.pendingKnockback = {
                x: (v.x || 0) / VELOCITY,
                y: (v.y || 0) / VELOCITY,
                z: (v.z || 0) / VELOCITY
            };
        });

        // track potion effects so speed pots don't get flagged
        ctx.observe('entity_effect', (event) => {
            state(event.data.entityId).effects.set(event.data.effectId, event.data.amplifier);
        });
        ctx.observe('remove_entity_effect', (event) => {
            state(event.data.entityId).effects.delete(event.data.effectId);
        });

        ctx.observe('entity_destroy', (event) => {
            for (const id of event.data.entityIds || []) tracked.delete(id);
        });

        ctx.on('world_change', () => {
            tracked.clear();
            flags.clear();
        });

        // --- commands ---------------------------------------------------------

        ctx.commands.register('flags', {
            description: 'What has looked wrong this game',
            usage: '[clear]',
            handler: (args, command) => {
                if ((args[0] || '').toLowerCase() === 'clear') {
                    flags.clear();
                    return command.reply('Cleared what was noticed.');
                }

                const entries = [...flags.values()]
                    .filter((entry) => entry.total >= setting('threshold'))
                    .sort((a, b) => b.total - a.total);

                if (!entries.length) {
                    return ui.box('&7Nothing noticed', [
                        '&7No movement has looked wrong this game.',
                        '',
                        `&8Counting from ${setting('threshold')} occurrences.`,
                        '&8Checks on: ' + ['velocity', 'rotation', 'speed', 'scaffold', 'legitScaffold', 'autoBlock', 'breakDelay']
                            .filter((c) => setting(`check${c[0].toUpperCase()}${c.slice(1)}`))
                            .join(', ')
                    ]);
                }

                const rows = entries.map((entry) => {
                    const breakdown = Object.entries(entry.checks)
                        .map(([check, count]) => `${check} ${count}`)
                        .join('&8, &7');
                    return ui.action(
                        `&e${String(entry.total).padStart(3)} &f${entry.name.padEnd(16)} &7${breakdown}`,
                        `/stats ${entry.name}`,
                        [
                            `&f&l${entry.name}`,
                            `&7Noticed &f${entry.total}&7 times`,
                            `&8Last: ${entry.last}`,
                            '',
                            '&8This is not proof of anything. Lag looks like this too.',
                            '&8Watch them, and report through Hypixel if you are sure.',
                            '',
                            '&8Click for their stats.'
                        ].join('\n')
                    );
                });

                return ui.box('&7Looked wrong this game', rows, {
                    footer: '&8not proof · lag looks like this too · watch before reporting'
                });
            }
        });

        ctx.commands.register('anticheat', {
            description: 'Movement flagging settings',
            usage: '[on|off|velocity|rotation|speed|scaffold|legit|autoblock|breakdelay|autowatch|threshold <n>|announce|status]',
            aliases: ['ac'],
            handler: (args, command) => {
                const action = (args[0] || 'status').toLowerCase();
                const toggles = {
                    on: 'enabled',
                    off: 'enabled',
                    velocity: 'checkVelocity',
                    rotation: 'checkRotation',
                    speed: 'checkSpeed',
                    scaffold: 'checkScaffold',
                    legit: 'checkLegitScaffold',
                    autoblock: 'checkAutoBlock',
                    breakdelay: 'checkBreakDelay',
                    autowatch: 'autoWatch',
                    announce: 'announce'
                };

                if (action === 'on' || action === 'off') {
                    ctx.store.set('enabled', action === 'on');
                    return command.reply(`Movement flagging is &f${action}&7.`);
                }
                if (toggles[action]) {
                    const next = !setting(toggles[action]);
                    ctx.store.set(toggles[action], next);
                    return command.reply(`&f${action}&7 is now &f${next ? 'on' : 'off'}&7.`);
                }
                if (action === 'threshold') {
                    const value = Number.parseInt(args[1], 10);
                    if (Number.isNaN(value) || value < 1) return command.error('Usage: /anticheat threshold <number>');
                    ctx.store.set('threshold', value);
                    return command.reply(`Reporting from &f${value}&7 occurrences.`);
                }

                ui.box('&7Movement flagging', [
                    `&7Watching    ${setting('enabled') ? '&aon' : '&coff'}`,
                    `&7Velocity    ${setting('checkVelocity') ? '&aon' : '&8off'} &8knockback that barely moves them`,
                    `&7Rotation    ${setting('checkRotation') ? '&aon' : '&8off'} &8snapping round and back`,
                    `&7Speed       ${setting('checkSpeed') ? '&aon' : '&8off'} &8noisy: jump pads and ladders`,
                    `&7Scaffold    ${setting('checkScaffold') ? '&aon' : '&8off'} &8bridging without looking down`,
                    `&7Legit scaff ${setting('checkLegitScaffold') ? '&aon' : '&8off'} &8weak: good players bridge well too`,
                    `&7Autoblock   ${setting('checkAutoBlock') ? '&aon' : '&8off'} &8swinging while still blocking`,
                    `&7Break delay ${setting('checkBreakDelay') ? '&aon' : '&8off'} &8noisy: fast tools look like this`,
                    `&7Threshold   &f${setting('threshold')} &8before it is worth saying`,
                    `&7Announce    ${setting('announce') ? '&aon' : '&8off'}`,
                    `&7Auto watch  ${setting('autoWatch') ? '&aon' : '&8off'} &8adds them to your own watchlist`,
                    null,
                    `&7Tracking    &f${tracked.size}&7 entities, &f${flags.size}&7 noticed`,
                    null,
                    '&8A proxy sees movement quantised and over a network that',
                    '&8stutters. This counts oddities; it does not catch cheaters.',
                    '&8Nothing here is ever submitted to a shared blacklist.'
                ]);
                return undefined;
            }
        });
    }
};
