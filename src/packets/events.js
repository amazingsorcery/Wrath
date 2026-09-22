'use strict';

const chatUtil = require('../utils/chat');

/** Base event: every handler can cancel, and cancellation drops the packet. */
class Event {
    constructor(type, session) {
        this.type = type;
        this.session = session;
        this._cancelled = false;
        this._modified = false;
    }

    get cancelled() {
        return this._cancelled;
    }

    get modified() {
        return this._modified;
    }

    cancel() {
        this._cancelled = true;
        return this;
    }

    markModified() {
        this._modified = true;
        return this;
    }
}

/** A packet passing through the proxy that a plugin is allowed to rewrite. */
class PacketEvent extends Event {
    constructor(name, data, direction, session) {
        super(`packet:${name}`, session);
        this.name = name;
        this.data = data;
        this.direction = direction;
    }
}

/** An incoming chat message from the server. */
class ChatEvent extends PacketEvent {
    constructor(data, session) {
        super('chat', data, 'clientbound', session);
        this.type = 'chat';
        this.position = data.position;
    }

    /** The message as plain legacy text, colour codes included. */
    get message() {
        if (this._message === undefined) this._message = chatUtil.toLegacy(this.data.message);
        return this._message;
    }

    /** The message with every colour and format code removed. */
    get plain() {
        return chatUtil.strip(this.message);
    }

    /** The raw component, parsed. */
    get component() {
        try {
            return typeof this.data.message === 'string' ? JSON.parse(this.data.message) : this.data.message;
        } catch {
            return { text: String(this.data.message) };
        }
    }

    /** Replace the message the client will render. */
    setMessage(value) {
        this.data.message = chatUtil.serialize(value);
        this._message = undefined;
        this.markModified();
        return this;
    }
}

/** A chat message or command the player typed. */
class OutgoingChatEvent extends PacketEvent {
    constructor(data, session) {
        super('chat', data, 'serverbound', session);
        this.type = 'outgoing_chat';
    }

    get message() {
        return this.data.message;
    }

    get isCommand() {
        return typeof this.data.message === 'string' && this.data.message.startsWith('/');
    }

    setMessage(value) {
        this.data.message = String(value);
        this.markModified();
        return this;
    }
}

/** A player appearing in or leaving the tab list. */
class PlayerEvent extends Event {
    constructor(type, player, session) {
        super(type, session);
        this.player = player;
    }
}

/** Read-only packet event. No cancel, data is frozen. */
class ObservedEvent {
    constructor(name, data, session) {
        this.type = `observe:${name}`;
        this.name = name;
        this.session = session;
        this.data = Object.freeze({ ...data });
        Object.freeze(this);
    }
}

/** Emitted when the proxy finishes connecting to, or loses, the target server. */
class ConnectionEvent extends Event {
    constructor(type, session, details = {}) {
        super(type, session);
        Object.assign(this, details);
    }
}

module.exports = { Event, PacketEvent, ChatEvent, OutgoingChatEvent, PlayerEvent, ConnectionEvent, ObservedEvent };
