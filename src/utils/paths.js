'use strict';

const fs = require('fs');
const path = require('path');

function ensure(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getBaseDir() {
    if (process.env.WRATH_HOME) return path.resolve(process.env.WRATH_HOME);
    // When bundled into a single executable, process.pkg/__dirname is unreliable,
    // so fall back to the directory the binary was launched from.
    if (process.pkg) return path.dirname(process.execPath);
    return path.resolve(__dirname, '..', '..');
}

const dataDir = () => ensure(path.join(getBaseDir(), 'data'));
const pluginsDir = () => ensure(path.join(getBaseDir(), 'plugins'));
const pluginDataDir = () => ensure(path.join(dataDir(), 'plugins'));
const authDir = () => ensure(path.join(dataDir(), 'auth'));
const configFile = () => path.join(getBaseDir(), 'config.json');

module.exports = { ensure, getBaseDir, dataDir, pluginsDir, pluginDataDir, authDir, configFile };
