'use strict';

const fs = require('fs');
const path = require('path');

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

const colourOn = () => {
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR) return true;
    return Boolean(process.stdout.isTTY);
};

const paint = (code, text) => (colourOn() ? `${ESC}${code}m${text}${RESET}` : text);
const rgb = (r, g, b, text) => (colourOn() ? `${ESC}38;2;${r};${g};${b}m${text}${RESET}` : text);

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

// --- file sink --------------------------------------------------------------
// so errors survive the console window closing

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;

let logPath = null;
let logStream = null;
let written = 0;

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

function rotate() {
    if (!logPath) return;
    try {
        if (logStream) {
            logStream.end();
            logStream = null;
        }
        for (let i = KEEP - 1; i >= 1; i -= 1) {
            const from = `${logPath}.${i}`;
            const to = `${logPath}.${i + 1}`;
            if (fs.existsSync(from)) fs.renameSync(from, to);
        }
        if (fs.existsSync(logPath)) fs.renameSync(logPath, `${logPath}.1`);
    } catch { /* a failed rotation must never stop the proxy */ }
    written = 0;
}

/** Start writing to a file as well as the console. */
function setFile(file) {
    try {
        logPath = file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        written = fs.existsSync(file) ? fs.statSync(file).size : 0;
        if (written > MAX_BYTES) rotate();
        logStream = fs.createWriteStream(file, { flags: 'a' });
        logStream.on('error', () => {
            // don't crash if logging fails
            logStream = null;
        });
        toFile(`--- started ${new Date().toISOString()} ---`);
        return true;
    } catch {
        logPath = null;
        logStream = null;
        return false;
    }
}

function toFile(line) {
    if (!logStream) return;
    const text = `${stripAnsi(line)}\n`;
    written += Buffer.byteLength(text);
    try {
        logStream.write(text);
    } catch { /* ignore */ }
    if (written > MAX_BYTES) {
        rotate();
        try {
            logStream = fs.createWriteStream(logPath, { flags: 'a' });
        } catch { logStream = null; }
    }
}

function closeFile() {
    if (!logStream) return;
    try {
        logStream.end();
    } catch { /* ignore */ }
    logStream = null;
}

function currentFile() {
    return logPath;
}

const STYLE = {
    debug: { mark: '·', paint: (t) => paint('2', t) },
    info: { mark: '●', paint: (t) => rgb(90, 200, 245, t) },
    warn: { mark: '▲', paint: (t) => rgb(240, 190, 60, t) },
    error: { mark: '✖', paint: (t) => rgb(235, 70, 60, t) }
};

const ASCII_MARK = { debug: '.', info: '*', warn: '!', error: 'x' };

// --- subscribers ------------------------------------------------------------
// the window gets the same lines, without ansi

const subscribers = new Set();

/** Receive every line at or above the console threshold. Returns a canceller. */
function subscribe(handler) {
    subscribers.add(handler);
    return () => subscribers.delete(handler);
}

function publish(entry) {
    for (const handler of subscribers) {
        try {
            handler(entry);
        } catch { /* a broken viewer must never break logging */ }
    }
}

function setLevel(name) {
    if (LEVELS[name] !== undefined) threshold = LEVELS[name];
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function format(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function emit(level, scope, args) {
    if (LEVELS[level] < threshold) return;

    const style = STYLE[level];
    const mark = process.env.WRATH_ASCII ? ASCII_MARK[level] : style.mark;
    const body = args.map(format).join(' ');

    // empty call = blank line
    if (args.length === 1 && args[0] === '') {
        process.stdout.write('\n');
        return;
    }

    publish({ time: Date.now(), level, scope: scope || null, text: stripAnsi(body) });

    const head = `  ${paint('2', stamp())} ${style.paint(mark)} ${scope ? paint('2', scope.padEnd(9)) : ' '.repeat(9)} `;
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(head + body + '\n');

    // file always logs info and up
    if (LEVELS[level] >= LEVELS.info) {
        toFile(`${stamp()} ${level.toUpperCase().padEnd(5)} ${(scope || '-').padEnd(9)} ${body}`);
    }
}

function create(scope) {
    return {
        debug: (...a) => emit('debug', scope, a),
        info: (...a) => emit('info', scope, a),
        warn: (...a) => emit('warn', scope, a),
        error: (...a) => emit('error', scope, a),
        /** Write a line with no decoration, for banners and panels. */
        raw: (text) => process.stdout.write(`${text}\n`),
        child: (sub) => create(sub)
    };
}

module.exports = { create, setLevel, setFile, closeFile, currentFile, subscribe, logger: create(null), colourOn };
