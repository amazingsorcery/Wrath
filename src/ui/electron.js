'use strict';

/**
 * Electron app. Runs the proxy in the main process (no native deps, so no
 * rebuild needed).
 */

const path = require('path');
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } = require('electron');

const { WrathProxy } = require('../proxy');
const { create, setFile } = require('../utils/logger');
const { dataDir } = require('../utils/paths');

const log = create('app');

const ICON = path.join(__dirname, '..', '..', 'assets', 'wrath.png');

let proxy = null;
let win = null;
let tray = null;
let quitting = false;

// single instance, two would fight over the port
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (win) {
            win.show();
            win.focus();
        }
    });
    start();
}

function start() {
    try {
        setFile(path.join(dataDir(), 'logs', 'wrath.log'));
    } catch { /* logging must never stop the app opening */ }

    app.on('ready', () => {
        createWindow();
        createTray();
        launchProxy();
    });

    // closing the window hides to tray, the proxy keeps running
    app.on('window-all-closed', (event) => {
        if (event && event.preventDefault) event.preventDefault();
    });

    app.on('before-quit', () => {
        quitting = true;
        if (proxy) {
            try {
                proxy.stop();
            } catch { /* already down */ }
        }
    });
}

function createWindow() {
    win = new BrowserWindow({
        width: 1180,
        height: 780,
        minWidth: 900,
        minHeight: 600,
        show: false,
        title: 'Wrath',
        icon: nativeImage.createFromPath(ICON),
        backgroundColor: '#0b0c10',
        autoHideMenuBar: true,
        webPreferences: {
            // no node in the page, it uses the local http api
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    Menu.setApplicationMenu(null);
    win.once('ready-to-show', () => win.show());

    // log page load failures
    win.webContents.on('did-finish-load', () => log.info('Window rendered.'));
    win.webContents.on('did-fail-load', (event, code, description) => {
        log.error(`The window could not load its page: ${description} (${code})`);
    });

    // open external links in the browser
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    win.on('close', (event) => {
        if (quitting) return;
        event.preventDefault();
        win.hide();
    });
}

function createTray() {
    try {
        const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
        tray = new Tray(image);
        tray.setToolTip('Wrath');
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: 'Open Wrath', click: () => { win.show(); win.focus(); } },
            { type: 'separator' },
            { label: 'Quit Wrath', click: () => app.quit() }
        ]));
        tray.on('double-click', () => { win.show(); win.focus(); });
    } catch (err) {
        // if the tray fails, closing the window quits
        log.warn(`Could not create the tray icon: ${err.message}`);
        tray = null;
        quitting = true;
    }
}

async function launchProxy() {
    proxy = new WrathProxy();

    try {
        // start the server first
        await proxy.openWindow({ browser: false });
        if (!proxy.window) throw new Error('the local window server did not start');

        win.loadURL(proxy.window.url);

        const account = proxy.config.get('account', 'default');
        proxy.window.setStatus('signing in');

        const { ensureAuth } = require('../auth');
        proxy.profile = await ensureAuth(account, {
            onCode: (details) => proxy.window.setAuth(details)
        });
        proxy.window.setAuth(null);

        proxy.api.loadAll();
        proxy.listen();
    } catch (err) {
        log.error(err && err.message ? err.message : String(err));
        if (proxy && proxy.window) {
            proxy.window.setStatus('error');
            return;
        }
        // no window to show this in
        dialog.showErrorBox('Wrath could not start', String(err && err.message ? err.message : err));
        app.quit();
    }
}
