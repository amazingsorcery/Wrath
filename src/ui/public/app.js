'use strict';

/* Wrath window. Renders the event stream, all state lives in the proxy. */

const TOKEN = new URLSearchParams(location.search).get('token') || '';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const state = {
    data: null,
    scan: null,
    lines: [],
    follow: true,
    filter: ''
};

const MAX_LINES = 600;

// --- talking to the proxy ---------------------------------------------------

async function post(route, body) {
    const res = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wrath-token': TOKEN },
        body: JSON.stringify(body || {})
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.error) throw new Error(payload.error || `Request failed (${res.status})`);
    return payload;
}

function connect() {
    const source = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);

    source.onmessage = (message) => {
        let frame;
        try {
            frame = JSON.parse(message.data);
        } catch {
            return;
        }
        if (frame.type === 'state') applyState(frame.payload);
        else if (frame.type === 'scan') applyScan(frame.payload);
        else if (frame.type === 'log') addLine(frame.payload);
        else if (frame.type === 'auth') showAuth(frame.payload);
        else if (frame.type === 'fault') showFault(frame.payload);
        else if (frame.type === 'history') {
            state.lines = frame.payload.slice(-MAX_LINES);
            renderLog();
            renderFeed();
        }
    };

    source.onerror = () => {
        // show that the stream dropped
        const pill = $('state-pill');
        pill.dataset.status = 'offline';
        pill.querySelector('.label').textContent = 'reconnecting';
    };
}

// --- state ------------------------------------------------------------------

/* Fatal errors (port taken etc), shown at the top. */
function showFault(fault) {
    const bar = $('fault');
    if (!fault || !fault.message) {
        bar.hidden = true;
        return;
    }
    $('fault-text').textContent = fault.message;
    bar.hidden = false;
}

/* Device code sign in overlay. */
function showAuth(details) {
    const veil = $('auth-veil');
    if (!details || !details.code) {
        veil.hidden = true;
        return;
    }
    $('auth-url').textContent = details.url;
    $('auth-url').href = details.url;
    $('auth-code').textContent = details.code;
    veil.hidden = false;
}

const STATUS_TEXT = {
    starting: 'starting',
    'signing in': 'signing in',
    listening: 'waiting for Minecraft',
    connected: 'connected',
    error: 'error',
    offline: 'reconnecting'
};

function applyState(data) {
    state.data = data;

    $('version').textContent = `v${data.version}`;

    const pill = $('state-pill');
    pill.dataset.status = data.status;
    pill.querySelector('.label').textContent = STATUS_TEXT[data.status] || data.status;

    const address = `localhost:${data.port}`;
    $('connect-address').textContent = address;
    $('connect-note').textContent = data.session
        ? `${data.session.username} is connected through Wrath.`
        : 'Then join it like any other server.';

    $('card-account').textContent = data.account || '—';
    $('card-target').textContent = `${data.target.host}:${data.target.port}`;
    $('card-session').textContent = data.session
        ? `${data.players} player${data.players === 1 ? '' : 's'} in view`
        : 'Nothing connected';

    setKeyCard('card-hypixel', data.keys.hypixel);
    setKeyCard('card-urchin', data.keys.urchin);
    $('card-rate').textContent = data.rate && data.rate.limit
        ? `${data.rate.remaining}/${data.rate.limit} requests left`
        : 'Needed for stats';

    $('home-mode').textContent = data.mode && data.mode !== 'unknown' ? `playing ${data.mode}` : '';

    $('rail-account').textContent = data.account || '—';
    $('rail-target').textContent = `${data.target.host}:${data.target.port}`;

    fillSettings(data);
    renderPlugins(data.plugins);
}

function setKeyCard(id, present) {
    const node = $(id);
    node.textContent = present ? 'Saved' : 'Not set';
    node.className = `card-value ${present ? 'good' : 'bad'}`;
}

// don't overwrite a field while it's being edited
function fill(id, value) {
    const node = $(id);
    if (document.activeElement === node) return;
    node.value = value === null || value === undefined ? '' : value;
}

function fillSettings(data) {
    fill('in-host', data.target.host);
    fill('in-port', data.target.port);
    fill('in-proxyport', data.port);
    fill('in-loglevel', data.logLevel);
    if (document.activeElement !== $('in-reconnect')) $('in-reconnect').checked = Boolean(data.reconnect);

    // keys never get sent to the page
    const hyp = $('in-hypixel');
    if (document.activeElement !== hyp && !hyp.value) hyp.placeholder = data.keys.hypixel ? '•••••• saved' : 'not set';
    const urc = $('in-urchin');
    if (document.activeElement !== urc && !urc.value) urc.placeholder = data.keys.urchin ? '•••••• saved' : 'not set';

    $('path-base').textContent = data.baseDir || '—';
    $('path-log').textContent = data.logPath || 'disabled';
}

// --- plugins ----------------------------------------------------------------

function renderPlugins(plugins) {
    const host = $('plugins');
    host.textContent = '';

    for (const plugin of plugins) {
        const card = el('div', `plugin${plugin.enabled ? '' : ' off'}`);

        const head = el('div', 'plugin-head');
        head.append(el('span', 'plugin-name', plugin.name));
        head.append(el('span', 'plugin-version', `v${plugin.version}`));

        const toggle = el('label', 'switch');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = plugin.enabled;
        input.addEventListener('change', async () => {
            input.disabled = true;
            try {
                await post('/api/plugin', { name: plugin.name, enabled: input.checked });
                toast(`${plugin.name} ${input.checked ? 'enabled' : 'disabled'}`, 'good');
            } catch (err) {
                input.checked = !input.checked;
                toast(err.message, 'bad');
            } finally {
                input.disabled = false;
            }
        });
        toggle.append(input, el('span'));
        head.append(toggle);

        card.append(head, el('div', 'plugin-desc', plugin.description || ''));
        if (plugin.errors) card.append(el('div', 'plugin-err', `${plugin.errors} recent error${plugin.errors === 1 ? '' : 's'}`));
        host.append(card);
    }
}

// --- the roster -------------------------------------------------------------

// columns per game, same as in game
const COLUMNS = {
    bedwars: [
        ['star', 'Stars'], ['ws', 'WS'], ['finals', 'Finals'], ['fkdr', 'FKDR'],
        ['wlr', 'W/L'], ['beds', 'Beds'], ['bblr', 'BBLR']
    ],
    skywars: [['swLevel', 'Level'], ['swKdr', 'KDR']],
    duels: [['duelsWins', 'Wins'], ['duelsWlr', 'WLR']]
};

// same tiers as in game
function tierOf(value) {
    const number = Number.parseFloat(value);
    if (!Number.isFinite(number)) return 0;
    if (number < 1) return 0;
    if (number < 2) return 1;
    if (number < 4) return 2;
    if (number < 8) return 3;
    return 4;
}

function applyScan(scan) {
    state.scan = scan;
    renderRoster();
}

function renderRoster() {
    const scan = state.scan;
    const head = $('roster-head');
    const body = $('roster-body');
    const empty = $('roster-empty');
    head.textContent = '';
    body.textContent = '';

    if (!scan || (!scan.rows.length && !scan.nicked.length && !scan.failed.length)) {
        $('roster').style.display = 'none';
        empty.style.display = 'block';
        return;
    }

    $('roster').style.display = '';
    empty.style.display = 'none';

    const columns = COLUMNS[scan.mode.key] || COLUMNS.bedwars;

    head.append(el('th', 'left tight', 'Team'));
    head.append(el('th', 'left', 'Player'));
    for (const [, title] of columns) head.append(el('th', null, title));
    head.append(el('th', null, 'Tags'));

    for (const row of scan.rows) {
        const tr = el('tr', row.teammate ? 'mine' : null);

        tr.append(teamCell(row.team, row.teammate));

        const cell = el('td', 'left');
        cell.append(el('span', `name tier-${tierOf(row.rating)}`, row.name));
        tr.append(cell);

        for (const [key] of columns) {
            const value = row.stats[key];
            const shown = value === null || value === undefined ? '–' : value;
            const td = el('td', `num tier-${key === 'star' || key === 'ws' ? 0 : tierOf(value)}`, String(shown));
            tr.append(td);
        }

        const tagCell = el('td');
        if (row.tags.length) tagCell.append(el('span', 'pill tag', row.tags[0]));
        tr.append(tagCell);

        body.append(tr);
    }

    for (const nick of scan.nicked) {
        const tr = el('tr');
        tr.append(teamCell(nick.team, nick.teammate));
        const cell = el('td', 'left');
        cell.append(el('span', 'name', nick.name));
        tr.append(cell);
        const span = el('td');
        span.colSpan = columns.length;
        span.className = 'num';
        span.textContent = nick.reason || '';
        tr.append(span);
        const tagCell = el('td');
        tagCell.append(el('span', 'pill nick', 'nick'));
        tr.append(tagCell);
        body.append(tr);
    }

    for (const item of scan.failed) {
        const tr = el('tr');
        tr.append(teamCell(item.team, false));
        const cell = el('td', 'left');
        cell.append(el('span', 'name', item.name));
        tr.append(cell);
        const span = el('td');
        span.colSpan = columns.length;
        tr.append(span);
        const tagCell = el('td');
        tagCell.append(el('span', 'pill unknown', 'no data'));
        tr.append(tagCell);
        body.append(tr);
    }

    const when = new Date(scan.at).toLocaleTimeString();
    $('scan-note').textContent = `${scan.mode.label} · ${scan.rows.length} found · ${when}`;

    // team split
    const sides = new Map();
    for (const row of scan.rows) {
        if (!row.team) continue;
        const key = row.team.label;
        if (!sides.has(key)) sides.set(key, { ...row.team, count: 0, mine: false });
        const side = sides.get(key);
        side.count += 1;
        if (row.teammate) side.mine = true;
    }

    const legend = $('roster-legend');
    legend.textContent = '';
    for (const side of sides.values()) {
        const chip = el('span', 'legend-item');
        const bar = el('span', `team-chip${side.mine ? ' mine' : ''}`);
        bar.style.background = minecraftColour(side.colour);
        chip.append(bar, el('span', null, `${side.label} ${side.count}`));
        if (side.mine) chip.append(el('span', 'legend-you', 'you'));
        legend.append(chip);
    }
    legend.style.display = sides.size ? '' : 'none';
}

/** Team bar + letter. Thicker for your team, grey when no team. */
function teamCell(team, mine) {
    const cell = el('td', 'left tight');
    const wrap = el('div', 'team');
    const chip = el('span', `team-chip${mine ? ' mine' : ''}`);
    if (team) chip.style.background = minecraftColour(team.colour);
    wrap.append(chip);
    if (team) {
        const label = el('span', 'team-label', String(team.label || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 3));
        label.style.color = minecraftColour(team.colour);
        wrap.append(label);
    }
    cell.append(wrap);
    return cell;
}

// Minecraft colour codes, for the team stripe.
const COLOURS = {
    0: '#000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa', 4: '#aa0000', 5: '#aa00aa',
    6: '#ffaa00', 7: '#aaa', 8: '#555', 9: '#5555ff', a: '#55ff55', b: '#55ffff',
    c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#fff'
};
const minecraftColour = (code) => COLOURS[String(code).toLowerCase()] || '#666';

// --- log --------------------------------------------------------------------

function addLine(entry) {
    state.lines.push(entry);
    if (state.lines.length > MAX_LINES) state.lines.shift();

    if (matches(entry)) {
        const node = lineNode(entry);
        const box = $('log');
        box.append(node);
        while (box.childElementCount > MAX_LINES) box.firstElementChild.remove();
        if (state.follow) box.scrollTop = box.scrollHeight;
    }
    renderFeed();
}

const matches = (entry) => {
    if (!state.filter) return true;
    const needle = state.filter.toLowerCase();
    return entry.text.toLowerCase().includes(needle) || String(entry.scope || '').includes(needle);
};

const clock = (time) => new Date(time).toLocaleTimeString([], { hour12: false });

function lineNode(entry) {
    const line = el('div', `log-line ${entry.level}`);
    line.append(el('time', null, clock(entry.time)));
    line.append(el('span', 'scope', entry.scope || ''));
    line.append(el('span', 'msg', entry.text));
    return line;
}

function renderLog() {
    const box = $('log');
    box.textContent = '';
    for (const entry of state.lines) {
        if (matches(entry)) box.append(lineNode(entry));
    }
    if (state.follow) box.scrollTop = box.scrollHeight;
}

/* Overview: latest non-debug lines. */
function renderFeed() {
    const box = $('home-feed');
    const interesting = state.lines
        .filter((entry) => entry.level !== 'debug')
        .slice(-14)
        .reverse();

    box.textContent = '';
    if (!interesting.length) {
        box.append(el('div', 'feed-empty', 'Nothing has happened yet.'));
        return;
    }
    for (const entry of interesting) {
        const line = el('div', `feed-line ${entry.level}`);
        line.append(el('time', null, clock(entry.time)));
        line.append(el('span', null, entry.text));
        box.append(line);
    }
}

// --- chrome -----------------------------------------------------------------

let toastTimer = null;
function toast(text, kind) {
    const node = $('toast');
    node.textContent = text;
    node.className = `toast show ${kind || ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        node.className = 'toast';
    }, 2600);
}

function wire() {
    for (const tab of document.querySelectorAll('.tab')) {
        tab.addEventListener('click', () => {
            for (const other of document.querySelectorAll('.tab')) other.classList.toggle('is-active', other === tab);
            for (const view of document.querySelectorAll('.view')) {
                view.classList.toggle('is-active', view.dataset.view === tab.dataset.view);
            }
            if (tab.dataset.view === 'log') $('log').scrollTop = $('log').scrollHeight;
        });
    }

    $('btn-copy').addEventListener('click', async () => {
        const address = $('connect-address').textContent;
        try {
            await navigator.clipboard.writeText(address);
        } catch {
            // clipboard can fail, select the text instead
            const range = document.createRange();
            range.selectNodeContents($('connect-address'));
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }
        const button = $('btn-copy');
        button.textContent = 'Copied';
        button.classList.add('done');
        setTimeout(() => {
            button.textContent = 'Copy';
            button.classList.remove('done');
        }, 1400);
    });

    $('btn-scan').addEventListener('click', async () => {
        try {
            await post('/api/scan');
            toast('Scanning the lobby', 'good');
        } catch (err) {
            toast(err.message, 'bad');
        }
    });

    $('btn-quit').addEventListener('click', async () => {
        try {
            await post('/api/quit');
            document.body.innerHTML = '<div class="empty" style="margin-top:40vh">Wrath has stopped. You can close this window.</div>';
        } catch (err) {
            toast(err.message, 'bad');
        }
    });

    $('btn-reload').addEventListener('click', async () => {
        try {
            await post('/api/reload');
            toast('Plugins reloaded', 'good');
        } catch (err) {
            toast(err.message, 'bad');
        }
    });

    for (const button of document.querySelectorAll('[data-save]')) {
        button.addEventListener('click', () => save(button.dataset.save));
    }

    for (const button of document.querySelectorAll('[data-verify]')) {
        button.addEventListener('click', async () => {
            const which = button.dataset.verify;
            button.disabled = true;
            button.textContent = '...';
            try {
                const result = await post('/api/verify', { which });
                toast(result.ok ? `${which} key works` : result.error, result.ok ? 'good' : 'bad');
            } catch (err) {
                toast(err.message, 'bad');
            } finally {
                button.disabled = false;
                button.textContent = 'Test';
            }
        });
    }

    $('fault-settings').addEventListener('click', () => {
        document.querySelector('[data-view="settings"]').click();
    });

    $('fault-retry').addEventListener('click', async (event) => {
        const button = event.target;
        button.disabled = true;
        button.textContent = 'Trying...';
        try {
            await post('/api/retry');
            toast('Trying again', 'good');
        } catch (err) {
            toast(err.message, 'bad');
        } finally {
            button.disabled = false;
            button.textContent = 'Try again';
        }
    });

    $('auth-copy').addEventListener('click', async () => {
        const code = $('auth-code').textContent;
        try {
            await navigator.clipboard.writeText(code);
            toast('Code copied', 'good');
        } catch {
            toast('Copy it by hand: ' + code, 'bad');
        }
    });

    $('in-reconnect').addEventListener('change', () => save('reconnect'));

    $('log-filter').addEventListener('input', (event) => {
        state.filter = event.target.value.trim();
        renderLog();
    });

    $('btn-follow').addEventListener('click', (event) => {
        state.follow = !state.follow;
        event.target.dataset.on = state.follow ? '1' : '0';
        event.target.textContent = state.follow ? 'Following' : 'Paused';
        if (state.follow) $('log').scrollTop = $('log').scrollHeight;
    });

    $('btn-clear').addEventListener('click', () => {
        state.lines = [];
        renderLog();
        renderFeed();
    });

    // stop autoscroll when scrolled up
    $('log').addEventListener('scroll', () => {
        const box = $('log');
        const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        if (!atEnd && state.follow) {
            state.follow = false;
            $('btn-follow').dataset.on = '0';
            $('btn-follow').textContent = 'Paused';
        }
    });
}

async function save(key) {
    let value;
    if (key === 'target') {
        value = { host: $('in-host').value.trim(), port: Number($('in-port').value) };
    } else if (key === 'proxyPort') {
        value = Number($('in-proxyport').value);
    } else if (key === 'hypixelKey') {
        value = $('in-hypixel').value.trim();
    } else if (key === 'urchinKey') {
        value = $('in-urchin').value.trim();
    } else if (key === 'logLevel') {
        value = $('in-loglevel').value;
    } else if (key === 'reconnect') {
        value = $('in-reconnect').checked;
    }

    try {
        const result = await post('/api/config', { key, value });
        if (key === 'hypixelKey') $('in-hypixel').value = '';
        if (key === 'urchinKey') $('in-urchin').value = '';
        toast(result.restartNeeded ? 'Saved. Restart Wrath for this one.' : 'Saved', 'good');
    } catch (err) {
        toast(err.message, 'bad');
    }
}

wire();
connect();
