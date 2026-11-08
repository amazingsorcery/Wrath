# Wrath

A Minecraft 1.8.9 proxy with a plugin API, written from scratch in Node.js.

Point a vanilla 1.8.9 client at `localhost`, Wrath logs into the real server for you, and plugins can read and rewrite packets in between. No client mod, no Forge.

Built mainly for Hypixel: automatic lobby stat scans, a stats table in the tab list, Urchin blacklist tags, nick detection and more.

## Cosmetic only

Plugins can only touch cosmetic packets. Everything goes through an allow-list in [`src/packets/policy.js`](src/packets/policy.js), and anything not on it throws a `PolicyError`.

| Plugins can                        | Plugins can't                     |
| ---------------------------------- | --------------------------------- |
| Read and rewrite incoming chat     | Send movement or look packets     |
| Send chat, action bar, titles      | Attack, swing or interact         |
| Play sounds / particles to you     | Click windows or move items       |
| Change tab list names              | Place or break blocks             |
| Read movement (read-only)          | Touch keep-alive or timing        |
| Register `/commands`               | Open raw sockets                  |

## Setup

Requires Node 18+, a Minecraft Java account and a 1.8.9 client.

```bash
npm install
npm run login                          # Microsoft device code sign in
node src/index.js key <hypixel-key>    # optional, for stats
node src/index.js urchin <urchin-key>  # optional, for blacklist tags
npm start
```

Then add `localhost:25565` as a server in Minecraft. The proxy only listens on `127.0.0.1`.

Use `node src/index.js target <host>` to change the server. Leave the port off unless you need it, since `minecraft-protocol` only follows SRV records on the default port.

## Desktop app

```bash
npm run app        # Electron window + tray
npm run window     # same UI in an Edge/Chrome app window, no Electron
npm run shortcut   # Desktop + Start Menu shortcuts
```

The app has an overview, a lobby table, plugin toggles, settings and a live log. Closing the window minimizes Wrath to the tray so your session keeps running. The local UI server needs a per-launch token and a loopback `Host` header, and API keys are never sent to the page.

`Wrath.cmd` runs everything in a console window instead, which is useful for debugging.

## Features

- **Lobby scans**: when a game starts, everyone gets looked up and ranked by threat in a clickable table. Columns change per game (Bedwars stars/FKDR, SkyWars level/KDR, Duels wins/WLR).
- **Tab list stats**: the tab list becomes a table with pixel-aligned columns.
- **Nametags**: ratings above players' heads.
- **Urchin tags**: blacklist tags in scans, plus `/v` and `/tag`.
- **Nicks**: players with no Hypixel record show as `NICK`. `/remap nick realname` remembers who they are.
- **Teams**: reads scoreboard teams so your own team doesn't trigger alerts.
- **Highlight rules**: color players by an expression like `fkdr > 10 && star > 100` (custom parser, no `eval`).
- **Bedwars QoL**: auto gg, trap reminder, magic milk timer, effect alerts.
- **Quiet**: mutes lobby sounds, particles and chat spam.
- **Movement flags**: counts suspicious movement (knockback, speed, rotation snaps, scaffold, autoblock). Not proof, and it never reports anyone automatically.
- **Reconnect**: if the server drops, you stay in the world while it reconnects.

## Commands

All commands are under `/wrath` (or `/wr`) so they don't block Hypixel's own `/who`, `/stats` etc.

| Command                         | What it does                    |
| ------------------------------- | ------------------------------- |
| `/wrath help`                   | List commands                   |
| `/wrath scan`                   | Scan the current lobby          |
| `/wrath stats <player>`         | Stat card                       |
| `/wrath tab`                    | Toggle the tab list table       |
| `/wrath plugins [enable/disable/reload]` | Manage plugins         |
| `/wrath connect <host[:port]>`  | Switch server                   |
| `/wrath config set <key> <val>` | Change a setting                |

Set `interceptPluginCommands` to `true` if you want the short forms (`/scan`) back.

## Writing a plugin

Drop a `.js` file into `plugins/`:

```js
module.exports = {
    name: 'example',
    version: '1.0.0',
    description: 'Says hi when someone joins',

    init(ctx) {
        ctx.on('player_join', (event) => {
            ctx.send(`&7Welcome, &f${event.player.name}&7.`);
        });

        ctx.commands.register('example', {
            description: 'Test command',
            handler: (args, command) => command.reply('&aIt works.')
        });
    }
};
```

Plugins don't `require` anything. Everything is on `ctx` (a test enforces this).

**Events:** `session_start`, `session_end`, `server_connect`, `server_disconnect`, `world_change`, `game_change`, `chat`, `outgoing_chat`, `player_join`, `player_leave`, `packet:<name>:clientbound`, `packet:<name>:serverbound`

**Context highlights:**

```js
ctx.send(text) / ctx.actionBar(text) / ctx.title(title, subtitle)
ctx.players.list() / ctx.players.get(name)
ctx.teams.isTeammate(name)
ctx.game.mode                      // 'bedwars', 'skywars', 'duels', 'lobby'
ctx.display.set(name, { prefix })  // tab list prefix/suffix
ctx.ui.box(title, lines) / ctx.ui.action(text, '/cmd', tooltip)
await ctx.hypixel.player(name)     // cached, rate limited
await ctx.urchin.lookup(uuids)
ctx.store.get(key) / ctx.store.set(key, value)
ctx.schedule(fn, ms) / ctx.interval(fn, ms)
```

Errors in a plugin are caught and logged, so one broken plugin can't stall the packet stream.

## Config

`config.json` is created on first run (and is gitignored).

| Key                       | Default          |
| ------------------------- | ---------------- |
| `proxyPort`               | `25565`          |
| `target.host`             | `mc.hypixel.net` |
| `hypixelKey`, `urchinKey` | `null`           |
| `interceptPluginCommands` | `false`          |
| `logLevel`                | `info`           |
| `reconnect`               | `true`           |
| `reconnectAttempts`       | `5`              |

CLI flags override it for one run: `node src/index.js start --port 25566 --target host:port --verbose`

## Tests

```bash
npm test              # offline tests, fake sockets, no network
npm run test:listen   # real 1.8.9 ping against the local server
node test/preview.js  # render in-game chat output in the terminal
```

## Troubleshooting

- **`invalid_grant` on login**: run `node src/index.js logout` and sign in again.
- **Disconnects instantly with `socketClosed`**: run `node src/index.js check`. `closed-immediately` means the server is blocking your IP, not a Wrath issue. Some networks need a relay host as the target.
- **Port in use**: `node src/index.js start --port 25566`.
- **"Please connect using 1.8.9"**: Wrath only supports protocol 47.

Logs are in `data/logs/wrath.log`.

## Disclaimer

Hypixel allows cosmetic-only proxies, but using any proxy carries some risk. Only install plugins you've read.

## License

MIT
