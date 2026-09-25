'use strict';

/**
 * Minecraft 1.8 font widths, for lining up tab list columns.
 * Space is 4px and bold space is 5px, so mixing them hits almost any width.
 */

// Advance widths in pixels, glyph plus the one pixel of spacing after it.
// Anything not listed is 6, which covers most of the alphabet and the digits.
const WIDTH = {
    ' ': 4, '!': 2, '"': 5, '\'': 3, '(': 5, ')': 5, '*': 5, ',': 2, '.': 2,
    ':': 2, ';': 2, '<': 5, '>': 5, '@': 7, 'I': 4, '[': 4, ']': 4, '`': 3,
    'f': 5, 'i': 2, 'k': 5, 'l': 3, 't': 4, '{': 5, '|': 2, '}': 5, '~': 7
};

const DEFAULT_WIDTH = 6;

// unicode glyphs, approximate (8px symbols, 16px CJK)
function unicodeWidth(code) {
    if (code >= 0x1100 && code <= 0x11ff) return 16;
    if (code >= 0x2e80 && code <= 0xa4cf) return 16;
    if (code >= 0xac00 && code <= 0xd7a3) return 16;
    if (code >= 0xf900 && code <= 0xfaff) return 16;
    if (code >= 0xfe30 && code <= 0xfe6f) return 16;
    if (code >= 0xff00 && code <= 0xff60) return 16;
    return 8;
}

/** Width of one character, before bold is taken into account. */
function charWidth(char) {
    const code = char.codePointAt(0);
    if (code > 0x7f) return unicodeWidth(code);
    const known = WIDTH[char];
    return known === undefined ? DEFAULT_WIDTH : known;
}

/** Width of a legacy-coded string in px. Color codes reset bold. */
function width(text) {
    let total = 0;
    let bold = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];

        if ((char === '§' || char === '&') && i + 1 < text.length) {
            const code = text[i + 1].toLowerCase();
            if (/[0-9a-fk-or]/.test(code)) {
                if (code === 'l') bold = true;
                else if (code === 'r' || /[0-9a-f]/.test(code)) bold = false;
                i += 1;
                continue;
            }
        }

        // Surrogate pairs are one glyph, so step over the low half.
        const code = text.codePointAt(i);
        if (code > 0xffff) i += 1;
        total += charWidth(String.fromCodePoint(code)) + (bold ? 1 : 0);
    }

    return total;
}

/** Spaces exactly `pixels` wide (4a + 5b). Some widths (6, 7, 11) round up. */
function spacer(pixels) {
    if (pixels <= 0) return '';

    for (let target = pixels; target <= pixels + 3; target += 1) {
        const boldCount = target % 4;
        const plainCount = (target - boldCount * 5) / 4;
        if (plainCount < 0 || !Number.isInteger(plainCount)) continue;
        const plain = ' '.repeat(plainCount);
        // §r first so a leftover color doesn't make it bold
        return boldCount ? `${plain}§l${' '.repeat(boldCount)}§r` : plain;
    }

    return ' '.repeat(Math.round(pixels / 4));
}

/** Pad `text` on the right so the result is `pixels` wide. */
function padRight(text, pixels) {
    return text + spacer(pixels - width(text));
}

/** Pad `text` on the left so the result is `pixels` wide. */
function padLeft(text, pixels) {
    return spacer(pixels - width(text)) + text;
}

/**
 * Place cells at fixed pixel offsets: { text, at, align }.
 * Gaps are measured from the actual width so far, so errors don't stack.
 * startAt = px already drawn (the server's name in the tab list).
 */
function layout(cells, startAt = 0) {
    let out = '';

    for (const cell of cells) {
        if (!cell || cell.text === undefined || cell.text === null) continue;
        const text = String(cell.text);
        const target = cell.align === 'right' ? cell.at - width(text) : cell.at;
        const gap = target - (startAt + width(out));
        // overflowed cells still get one space (except the first)
        out += (gap > 0 ? spacer(gap) : (out === '' ? '' : ' ')) + text;
    }

    return out;
}

/** Cut to a pixel width, never splitting a colour code, adding an ellipsis. */
function truncate(text, pixels) {
    if (width(text) <= pixels) return text;

    let out = '';
    for (let i = 0; i < text.length; i += 1) {
        if ((text[i] === '§' || text[i] === '&') && i + 1 < text.length && /[0-9a-fk-or]/i.test(text[i + 1])) {
            out += text.slice(i, i + 2);
            i += 1;
            continue;
        }
        if (width(out + text[i]) + charWidth('…') > pixels) break;
        out += text[i];
    }
    return `${out}…`;
}

module.exports = { width, spacer, padLeft, padRight, layout, truncate, charWidth };
