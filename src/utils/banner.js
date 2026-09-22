'use strict';

// Terminal presentation: the startup banner, panels and colour ramps.
// Everything degrades to plain text when colour or Unicode is unavailable.

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

const useColour = () => {
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR) return true;
    return Boolean(process.stdout.isTTY);
};

const useUnicode = () => !process.env.WRATH_ASCII;

const fg = (r, g, b) => (useColour() ? `${ESC}38;2;${r};${g};${b}m` : '');
const reset = () => (useColour() ? RESET : '');
const bold = () => (useColour() ? BOLD : '');
const dim = () => (useColour() ? DIM : '');

/** Strip ANSI so padding maths counts visible characters only. */
const visibleLength = (text) => text.replace(/\x1b\[[0-9;]*m/g, '').length;

/** Cut a string to a visible width, keeping ANSI sequences intact. */
function truncateVisible(text, max) {
    if (visibleLength(text) <= max) return text;
    let out = '';
    let visible = 0;
    let index = 0;
    while (index < text.length && visible < max - 1) {
        const match = /^\x1b\[[0-9;]*m/.exec(text.slice(index));
        if (match) {
            out += match[0];
            index += match[0].length;
            continue;
        }
        out += text[index];
        index += 1;
        visible += 1;
    }
    return `${out}…`;
}

/** Blend between colour stops, position from 0 to 1. */
function ramp(stops, position) {
    const clamped = Math.max(0, Math.min(1, position));
    const span = 1 / (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(clamped / span));
    const local = (clamped - index * span) / span;
    const [r1, g1, b1] = stops[index];
    const [r2, g2, b2] = stops[index + 1];
    return [
        Math.round(r1 + (r2 - r1) * local),
        Math.round(g1 + (g2 - g1) * local),
        Math.round(b1 + (b2 - b1) * local)
    ];
}

// Deep crimson climbing to ember orange.
const FIRE = [[120, 0, 12], [190, 18, 30], [225, 45, 35], [255, 105, 30]];

const ART = [
    '██╗    ██╗██████╗  █████╗ ████████╗██╗  ██╗',
    '██║    ██║██╔══██╗██╔══██╗╚══██╔══╝██║  ██║',
    '██║ █╗ ██║██████╔╝███████║   ██║   ███████║',
    '██║███╗██║██╔══██╗██╔══██║   ██║   ██╔══██║',
    '╚███╔███╔╝██║  ██║██║  ██║   ██║   ██║  ██║',
    ' ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝'
];

const ASCII_ART = [
    ' _    _ ___  ___ _____ _  _ ',
    '| |  | | _ \\/ _ \\_   _| || |',
    '| |/\\| |   / /_\\ \\| | | __ |',
    '|__/\\__|_|_\\_/ \\_\\|_| |_||_|'
];

/** The big wordmark, painted with a vertical gradient. */
function wordmark() {
    const art = useUnicode() ? ART : ASCII_ART;
    return art
        .map((line, index) => {
            const [r, g, b] = ramp(FIRE, index / (art.length - 1));
            return `  ${fg(r, g, b)}${bold()}${line}${reset()}`;
        })
        .join('\n');
}

const BOX = {
    tl: '╭', tr: '╮', bl: '╰', br: '╯',
    h: '─', v: '│'
};
const ASCII_BOX = { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

/**
 * A rounded panel of label/value rows.
 * @param {Array<[string,string]|null>} rows null renders a divider
 */
function panel(rows, { width = 58, accent = [225, 45, 35] } = {}) {
    const box = useUnicode() ? BOX : ASCII_BOX;
    const [r, g, b] = accent;
    const edge = fg(r, g, b);
    const inner = width - 2;

    const out = [`  ${edge}${box.tl}${box.h.repeat(inner)}${box.tr}${reset()}`];

    for (const row of rows) {
        if (row === null) {
            out.push(`  ${edge}${box.v}${reset()}${dim()}${box.h.repeat(inner)}${reset()}${edge}${box.v}${reset()}`);
            continue;
        }
        const [label, value] = row;
        const body = truncateVisible(` ${dim()}${label.padEnd(12)}${reset()}${value}`, inner);
        const pad = Math.max(0, inner - visibleLength(body));
        out.push(`  ${edge}${box.v}${reset()}${body}${' '.repeat(pad)}${edge}${box.v}${reset()}`);
    }

    out.push(`  ${edge}${box.bl}${box.h.repeat(inner)}${box.br}${reset()}`);
    return out.join('\n');
}

/** A thin gradient divider the width of the banner. */
function divider(width = 58) {
    if (!useColour()) return `  ${'-'.repeat(width)}`;
    const char = useUnicode() ? '─' : '-';
    let out = '  ';
    for (let i = 0; i < width; i += 1) {
        const [r, g, b] = ramp(FIRE, i / (width - 1));
        out += `${fg(r, g, b)}${char}`;
    }
    return out + reset();
}

/** The wordmark plus its tagline, ready to print. */
function splash(tagline = 'cosmetic-only proxy for minecraft 1.8.9') {
    const lines = [wordmark()];
    const pad = ' '.repeat(3);
    lines.push('');
    lines.push(`${pad}${dim()}${tagline}${reset()}`);
    return lines.join('\n');
}

/** Paint a single line of text with the fire gradient. */
function gradient(text, stops = FIRE) {
    if (!useColour()) return text;
    return (
        [...text]
            .map((char, index) => {
                const [r, g, b] = ramp(stops, text.length <= 1 ? 0 : index / (text.length - 1));
                return `${fg(r, g, b)}${char}`;
            })
            .join('') + reset()
    );
}

const colours = {
    red: (t) => `${fg(225, 45, 35)}${t}${reset()}`,
    ember: (t) => `${fg(255, 105, 30)}${t}${reset()}`,
    green: (t) => `${fg(80, 200, 120)}${t}${reset()}`,
    grey: (t) => `${dim()}${t}${reset()}`,
    bold: (t) => `${bold()}${t}${reset()}`
};

module.exports = { wordmark, splash, divider, panel, gradient, colours, visibleLength, truncateVisible, useColour, useUnicode, FIRE };
