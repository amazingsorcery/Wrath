'use strict';

// Helpers for Minecraft 1.8 chat components and legacy section-sign colour codes.

const SECTION = '§';

const COLOURS = {
    black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3',
    dark_red: '4', dark_purple: '5', gold: '6', gray: '7',
    dark_gray: '8', blue: '9', green: 'a', aqua: 'b',
    red: 'c', light_purple: 'd', yellow: 'e', white: 'f'
};

const FORMATS = { obfuscated: 'k', bold: 'l', strikethrough: 'm', underlined: 'n', italic: 'o' };

/** Turn `&a` style codes into real section signs. */
function colourize(text) {
    return String(text).replace(/&([0-9a-fk-or])/gi, `${SECTION}$1`);
}

/** Remove every colour/format code from a string. */
function strip(text) {
    return String(text).replace(new RegExp(`${SECTION}[0-9a-fk-or]`, 'gi'), '');
}

/**
 * Convert a chat component (object or JSON string) into plain legacy text.
 * Handles `text`, `extra`, `translate`/`with`, and inherited formatting.
 */
function toLegacy(component, inherited = {}) {
    if (component === null || component === undefined) return '';
    if (typeof component === 'string') {
        let parsed;
        try {
            parsed = JSON.parse(component);
        } catch {
            return component;
        }
        return toLegacy(parsed, inherited);
    }
    if (Array.isArray(component)) return component.map((c) => toLegacy(c, inherited)).join('');
    if (typeof component !== 'object') return String(component);

    const style = { ...inherited };
    if (component.color) style.color = component.color;
    for (const key of Object.keys(FORMATS)) {
        if (component[key] !== undefined) style[key] = component[key];
    }

    let prefix = '';
    if (style.color && COLOURS[style.color]) prefix += SECTION + COLOURS[style.color];
    for (const [key, code] of Object.entries(FORMATS)) {
        if (style[key]) prefix += SECTION + code;
    }

    let body = '';
    if (typeof component.text === 'string') body += component.text;

    if (component.translate) {
        const args = (component.with || []).map((w) => toLegacy(w, style));
        // no lang file, just join the args
        body += args.length ? args.join(' ') : component.translate;
    }

    let out = body ? prefix + body : '';
    for (const child of component.extra || []) {
        out += toLegacy(child, style);
    }
    return out;
}

/**
 * Convert legacy text into a minimal chat component the vanilla client renders
 * identically. Section signs survive in `text`, so a flat node is enough.
 */
function toComponent(value) {
    if (value && typeof value === 'object') return value;
    return { text: colourize(value === undefined || value === null ? '' : String(value)) };
}

/** Serialise anything acceptable as a chat message into a JSON string. */
function serialize(value) {
    if (typeof value === 'string') {
        // Already JSON? Keep it verbatim so callers can pass raw components.
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                JSON.parse(trimmed);
                return trimmed;
            } catch {
                /* fall through to plain text */
            }
        }
        return JSON.stringify(toComponent(value));
    }
    return JSON.stringify(toComponent(value));
}

module.exports = { SECTION, COLOURS, FORMATS, colourize, strip, toLegacy, toComponent, serialize };
