'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Write JSON atomically (temp file + rename) so a crash can't leave a half
 * written file.
 */
function writeJsonAtomic(file, data) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });

    // Same directory, because rename is only atomic within one filesystem.
    const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`);
    const body = `${JSON.stringify(data, null, 2)}\n`;

    let handle;
    try {
        handle = fs.openSync(temp, 'w');
        fs.writeFileSync(handle, body);
        // fsync before rename
        fs.fsyncSync(handle);
    } finally {
        if (handle !== undefined) fs.closeSync(handle);
    }

    try {
        fs.renameSync(temp, file);
    } catch (err) {
        try {
            fs.unlinkSync(temp);
        } catch { /* the temp file is already gone */ }
        throw err;
    }
}

/** Read JSON, returning the fallback when the file is missing or corrupt. */
function readJsonSafe(file, fallback = null) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const text = fs.readFileSync(file, 'utf8');
        if (!text.trim()) return fallback;
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

module.exports = { writeJsonAtomic, readJsonSafe };
