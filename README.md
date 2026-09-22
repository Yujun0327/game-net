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
// core.setExtra(payload) rides game-defined data (lobby picks, chat) on every beacon;
// adapter.orderSeats(players, prev) chooses sides at start and on rematch.
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

## Wallet (`@yujun/game-net/wallet`)

Platform-wide identity + hosted ledger, added 2026-09. Gameplay stays P2P; only three
moments touch the server: `hello` (name), `claim` (1,000/day, KST), and settlement.

- `identity.ts` — one Ed25519 keypair per browser (`yujungame:identity`), the public key is
  the player id everywhere. `exportSeed`/`importSeed` = the link code between devices.
- `canonical.ts` — sorted-key JSON; signatures are over `<domain>\n<canonical>`.
- `money.ts` — THE rules table (`MONEY_RULES`, `DAILY_CASH`, `CAPS`) and `computeDeltas`.
  Shared with the Edge Function via `npm run sync-shared` (the test suite checks the copies).
- `wallet.ts` — `WalletSession` attaches to a `BeaconSession`: locks the stake when a bet game
  starts, signs + posts its own settlement when the game ends, polls until settled.
- `supabase/` — migration (tables, RLS, SQL functions) and the `ledger` Edge Function.

Flow: every seat posts only its own signature; the ledger applies the deltas once all seats have
spoken (one transaction, advisory lock per game). Threat model: casual cheating by friends. A
modified client cannot invent a result because honest peers only sign what they computed; self-play
is bounded by `CAPS`, not proofs.

Deploy: `supabase link --project-ref <ref> && supabase db push && supabase functions deploy ledger`,
then put the project URL + anon key in `src/ledger-config.ts`.
