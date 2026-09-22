# @yujun/game-net

Shared multiplayer layer for the board-game sites (Splendor, Harmonies, Castle Combo,
Davinci Code, Yacht Night, Toy Battle, Sky Team). No backend: a broadcast channel over
MQTT brokers plus a stateless N-player "beacon" session.

## Why

WebRTC (Trystero) needs signaling, NAT traversal and a TURN fallback to all line up, and
every one of those depends on the device and network. The beacon protocol only needs a
lossy broadcast channel, so a single reachable broker is enough for everyone.

## Pieces

- `connectMqtt` — publishes every message to all brokers and subscribes on all of them;
  duplicates are dropped, dead brokers are ignored, dropped sockets auto-reconnect.
- `BeaconSession` — one message type (a periodic `sync` beacon carrying the sender's identity,
  lobby intent and full view of the game). Presence, host election, lobby roster, game start,
  move sync, refresh-resume, spectators and rematch all fall out of merging the latest beacon
  per peer. Framework-agnostic: plain fields plus `subscribe()`.
- `GameAdapter` — what a game supplies: config builder, initial state, `apply`, `hash`, `actor`,
  `isOver`, optional `actorFor` for off-turn moves such as conceding.
- `Mesh` (`@yujun/game-net/mesh`) — deterministic in-memory transport for tests.

## Using it in a game

```ts
import { BeaconSession, brokersFromEnv, playerKey, loadPlayerName } from '@yujun/game-net'

const core = new BeaconSession(adapter, {
  room, creator,
  identity: { key: playerKey('splendor'), name: loadPlayerName('splendor') },
  brokers: brokersFromEnv(import.meta.env),
})
core.subscribe(() => rerender())
```

Wrap the core in a Svelte class that bumps a `$state` revision counter in `subscribe` and reads
the core through getters.

## Your own broker

Set `VITE_MQTT_URL` (and `VITE_MQTT_USERNAME` / `VITE_MQTT_PASSWORD`) at build time to put a
broker you own first; the public brokers stay as fallbacks. A free HiveMQ Cloud instance works.
Credentials in a static site are public — use a broker you are happy to expose.

## Privacy

Topics on public brokers are world-readable. Only public game state goes on the wire; per-seat
secrets stay in the adapter's `priv` and never leave the client.
