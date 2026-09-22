'use strict';

const net = require('net');
const dns = require('dns').promises;
const mc = require('minecraft-protocol');

/** Resolve the SRV record Minecraft uses, then fall back to a plain A record. */
async function resolveTarget(host) {
    try {
        const records = await dns.resolveSrv(`_minecraft._tcp.${host}`);
        if (records && records.length) {
            return { srv: true, host: records[0].name, port: records[0].port };
        }
    } catch {
        /* no SRV record is normal */
    }
    const addresses = await dns.lookup(host, { all: true });
    return { srv: false, host, addresses: addresses.map((a) => a.address) };
}

/**
 * Open a TCP socket and watch what the server does before we send anything.
 * A healthy Minecraft server holds the connection open waiting for a
 * handshake; a server that is refusing this network closes it immediately.
 */
function tcpProbe(host, port, timeout = 6000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const socket = net.connect(port, host);
        let connectedAt = null;
        socket.setTimeout(timeout);

        socket.on('connect', () => {
            connectedAt = Date.now() - started;
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve({ ok: true, connectedAt, heldOpen: true });
        });
        socket.on('error', (err) => {
            socket.destroy();
            resolve({ ok: false, connectedAt, error: err.message });
        });
        socket.on('close', () => {
            if (connectedAt === null) return; // an error already resolved this
            const closedAfter = Date.now() - started - connectedAt;
            resolve({ ok: true, connectedAt, heldOpen: false, closedAfter });
        });
    });
}

function pingProbe(host, port, timeout = 8000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: 'timed out' }), timeout);
        try {
            mc.ping({ host, port, version: '1.8.9', closeTimeout: timeout }, (err, result) => {
                clearTimeout(timer);
                if (err) return resolve({ ok: false, error: err.message });
                return resolve({
                    ok: true,
                    version: result.version && result.version.name,
                    protocol: result.version && result.version.protocol,
                    online: result.players && result.players.online
                });
            });
        } catch (err) {
            clearTimeout(timer);
            resolve({ ok: false, error: err.message });
        }
    });
}

/** Run the checks and work out if it's the network, the server or wrath. */
async function diagnose(host, port) {
    const report = { host, port, dns: null, tcp: null, ping: null, verdict: null, advice: [] };

    try {
        report.dns = await resolveTarget(host);
        if (report.dns.srv) port = report.dns.port;
    } catch (err) {
        report.dns = { error: err.message };
        report.verdict = 'dns-failed';
        report.advice.push(`"${host}" could not be resolved. Check the address and your internet connection.`);
        return report;
    }

    const connectHost = report.dns.srv ? report.dns.host : host;
    report.port = port;
    report.tcp = await tcpProbe(connectHost, port);

    if (!report.tcp.ok) {
        report.verdict = 'tcp-refused';
        report.advice.push(`Could not open a connection to ${connectHost}:${port} (${report.tcp.error}).`);
        report.advice.push('A firewall on this machine or network is the usual cause.');
        return report;
    }

    if (!report.tcp.heldOpen) {
        report.verdict = 'closed-immediately';
        report.advice.push(`${connectHost}:${port} accepted the connection then closed it after ${report.tcp.closedAfter}ms without being sent anything.`);
        report.advice.push('The server is refusing this network at the IP level. No proxy setting can change that.');
        report.advice.push(`Try joining ${host} directly in Minecraft. If that fails too, the block is not caused by Wrath.`);
        return report;
    }

    report.ping = await pingProbe(connectHost, port);
    if (!report.ping.ok) {
        report.verdict = 'no-status';
        report.advice.push(`The connection stayed open but the server sent no status response (${report.ping.error}).`);
        report.advice.push('This usually means the server is rejecting this client or is under maintenance.');
        return report;
    }

    report.verdict = 'ok';
    report.advice.push(`${host} is reachable and answered as ${report.ping.version}.`);
    return report;
}

module.exports = { diagnose, tcpProbe, pingProbe, resolveTarget };
