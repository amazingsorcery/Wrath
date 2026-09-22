'use strict';

// Starts the local server (no login, no upstream) and does a real 1.8.9 ping.

const os = require('os');
const path = require('path');
const fs = require('fs');
const mc = require('minecraft-protocol');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wrath-listen-'));
process.env.WRATH_HOME = home;

const { WrathProxy } = require('../src/proxy');

const PORT = 25566;
const proxy = new WrathProxy({ proxyPort: PORT });

proxy.listen();

proxy.server.once('listening', () => {
    mc.ping({ host: '127.0.0.1', port: PORT, version: '1.8.9' }, (err, result) => {
        let code = 0;
        if (err) {
            console.log(`  FAIL ping failed: ${err.message}`);
            code = 1;
        } else {
            console.log(`  ok   server responded to a 1.8.9 ping`);
            console.log(`       version : ${result.version.name} (protocol ${result.version.protocol})`);
            console.log(`       motd    : ${JSON.stringify(result.description)}`);
            console.log(`       players : ${result.players.online}/${result.players.max}`);
            if (result.version.protocol !== 47) {
                console.log('  FAIL expected protocol 47');
                code = 1;
            }
        }
        proxy.stop();
        fs.rmSync(home, { recursive: true, force: true });
        process.exit(code);
    });
});

setTimeout(() => {
    console.log('  FAIL server never started listening');
    process.exit(1);
}, 10000).unref();
