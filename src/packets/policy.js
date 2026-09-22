'use strict';

/**
 * Packet policy. Default deny: plugins can only touch packets listed here.
 * Movement, combat, inventory, world and timing packets are never writable.
 */

// Clientbound packets a plugin may rewrite as they pass through the proxy.
const MUTABLE_CLIENTBOUND = new Set([
    'chat',
    'title',
    'playerlist_header',
    'player_info',
    'scoreboard_objective',
    'scoreboard_score',
    'scoreboard_display_objective',
    'scoreboard_team',
    'tab_complete',
    // Cancellable so a plugin can mute a sound or hide a particle effect.
    'named_sound_effect',
    'world_particles'
]);

// clientbound packets plugins can create (client side only)
const INJECTABLE_CLIENTBOUND = new Set([
    'chat',
    'title',
    'playerlist_header',
    'player_info',
    'scoreboard_objective',
    'scoreboard_score',
    'scoreboard_display_objective',
    'scoreboard_team',
    'named_sound_effect',
    'world_particles'
]);

// serverbound packets plugins can modify/cancel (chat + commands)
const MUTABLE_SERVERBOUND = new Set(['chat', 'tab_complete']);

// Serverbound packets a plugin may send on the player's behalf.
const INJECTABLE_SERVERBOUND = new Set(['chat', 'tab_complete']);

/**
 * Packets plugins can read but not modify (for anticheat). Delivered as
 * frozen copies, still in NEVER for writing.
 */
const OBSERVABLE = new Set([
    'entity_teleport',
    'rel_entity_move',
    'entity_move_look',
    'entity_look',
    'entity_velocity',
    'entity_metadata',
    'entity_effect',
    'remove_entity_effect',
    'entity_status',
    'animation',
    'named_entity_spawn',
    'entity_destroy',
    // block changes, needed for the bridging checks
    'block_change',
    'multi_block_change'
]);

function canObserve(name) {
    return OBSERVABLE.has(name);
}

/** Explicitly forbidden. Default deny covers these already, listed for clarity. */
const NEVER = new Set([
    'position', 'look', 'position_look', 'flying',
    'use_entity', 'arm_animation', 'block_dig', 'block_place', 'entity_action',
    'held_item_slot', 'window_click', 'set_creative_slot', 'close_window',
    'abilities', 'steer_vehicle', 'client_command', 'spectate',
    'keep_alive', 'transaction', 'update_health', 'set_slot', 'window_items',
    'entity_velocity', 'entity_teleport', 'rel_entity_move', 'explosion',
    'block_change', 'multi_block_change', 'map_chunk', 'login', 'respawn'
]);

class PolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PolicyError';
    }
}

function canMutate(direction, name) {
    if (NEVER.has(name)) return false;
    return direction === 'clientbound' ? MUTABLE_CLIENTBOUND.has(name) : MUTABLE_SERVERBOUND.has(name);
}

function canInject(direction, name) {
    if (NEVER.has(name)) return false;
    return direction === 'clientbound' ? INJECTABLE_CLIENTBOUND.has(name) : INJECTABLE_SERVERBOUND.has(name);
}

function assertInject(direction, name, pluginName) {
    if (canInject(direction, name)) return;
    throw new PolicyError(
        `Plugin "${pluginName}" tried to send ${direction} packet "${name}". ` +
        'Wrath only allows cosmetic packets; see src/packets/policy.js.'
    );
}

function assertMutate(direction, name, pluginName) {
    if (canMutate(direction, name)) return;
    throw new PolicyError(
        `Plugin "${pluginName}" tried to modify ${direction} packet "${name}". ` +
        'Wrath only allows cosmetic packets; see src/packets/policy.js.'
    );
}

module.exports = {
    OBSERVABLE,
    canObserve,
    MUTABLE_CLIENTBOUND,
    INJECTABLE_CLIENTBOUND,
    MUTABLE_SERVERBOUND,
    INJECTABLE_SERVERBOUND,
    NEVER,
    PolicyError,
    canMutate,
    canInject,
    assertInject,
    assertMutate
};
