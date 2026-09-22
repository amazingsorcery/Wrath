'use strict';

const fs = require('fs');
const path = require('path');
const { Authflow, Titles } = require('prismarine-auth');
const { authDir } = require('./utils/paths');
const { create } = require('./utils/logger');

const log = create('auth');

/**
 * Must match node-minecraft-protocol's java auth settings or the token caches
 * end up different. msal + the java title isn't approved for device code auth
 * (invalid_grant), so use the live flow like nmp does.
 */
const AUTH_OPTIONS = {
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: 'Nintendo',
    flow: 'live'
};

function makeFlow(account, onCode) {
    return new Authflow(account, authDir(), { ...AUTH_OPTIONS }, onCode);
}

/** live returns snake_case, msal returns camelCase, handle both. */
function parseCode(data = {}) {
    return {
        url: data.verification_uri || data.verificationUri || 'https://www.microsoft.com/link',
        code: data.user_code || data.userCode || null,
        message: data.message || null
    };
}

function announce(data = {}) {
    const { url, code } = parseCode(data);

    if (!code) {
        log.warn(data.message || 'Microsoft sign-in required, but no device code was returned.');
        return;
    }

    log.warn('');
    log.warn('  Microsoft sign-in required.');
    log.warn(`  1. Open  ${url}`);
    log.warn(`  2. Code  ${code}`);
    log.warn('  3. Approve, then wait here. This finishes on its own.');
    log.warn('');
}

/**
 * Make sure a Minecraft token exists for `account`, running the device-code
 * flow if it does not. Resolves with the Minecraft profile.
 */
async function ensureAuth(account, { quiet = false, onCode = null } = {}) {
    // pass the code to the window as data
    const flow = makeFlow(account, (data) => {
        if (!quiet) announce(data);
        if (onCode) {
            try {
                onCode(parseCode(data));
            } catch { /* a viewer must never break the sign-in */ }
        }
    });
    const result = await flow.getMinecraftJavaToken({ fetchProfile: true });
    if (!result || !result.profile) {
        throw new Error('Signed in, but Microsoft returned no Minecraft profile. Does this account own Minecraft: Java Edition?');
    }
    return result.profile;
}

/**
 * Delete all cached tokens (wrath logout). Also fixes empty cache files left
 * by a failed sign in.
 */
function clearTokens() {
    const dir = authDir();
    let removed = 0;
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        try {
            fs.unlinkSync(path.join(dir, file));
            removed += 1;
        } catch (err) {
            log.warn(`Could not delete ${file}: ${err.message}`);
        }
    }
    return removed;
}

module.exports = { ensureAuth, clearTokens, announce, parseCode, AUTH_OPTIONS };
