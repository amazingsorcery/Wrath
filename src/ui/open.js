'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { create } = require('../utils/logger');

const log = create('window');

/**
 * Open the window as a browser app window (Edge, Chrome, Brave, then the
 * default browser as a normal tab).
 */

const CANDIDATES = [
    ['Microsoft Edge', [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
    ]],
    ['Google Chrome', [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
    ]],
    ['Brave', [
        'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'
    ]]
];

function findBrowser() {
    for (const [name, paths] of CANDIDATES) {
        for (const candidate of paths) {
            if (fs.existsSync(candidate)) return { name, path: candidate };
        }
    }
    return null;
}

/** Separate profile so the window doesn't close with the normal browser. */
function profileDir() {
    const dir = path.join(os.tmpdir(), 'wrath-window');
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch { /* fall back to the shared profile */ }
    return dir;
}

function openWindow(url, { width = 1180, height = 760 } = {}) {
    const browser = findBrowser();

    if (browser) {
        const args = [
            `--app=${url}`,
            `--window-size=${width},${height}`,
            `--user-data-dir=${profileDir()}`,
            '--no-first-run',
            '--no-default-browser-check',
            // no background updates / crash reporting
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-features=Translate,MediaRouter'
        ];
        try {
            const child = spawn(browser.path, args, { detached: true, stdio: 'ignore' });
            child.unref();
            log.info(`Window opened in ${browser.name}.`);
            return true;
        } catch (err) {
            log.warn(`Could not open ${browser.name}: ${err.message}`);
        }
    }

    // fallback: default browser
    try {
        const child = process.platform === 'win32'
            ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
            : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
        child.unref();
        log.info('Window opened in your default browser.');
        return true;
    } catch (err) {
        log.error(`Could not open a window: ${err.message}`);
        log.error(`Open this yourself: ${url}`);
        return false;
    }
}

module.exports = { openWindow, findBrowser };
