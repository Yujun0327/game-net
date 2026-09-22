import type { Beacon, GameSnapshot, Seat, WireGame, WireMove } from './protocol'
export type { GameSnapshot } from './protocol'
import { localKV, type KV } from './storage'
import { connectMqtt, type Broker, type Transport } from './transport'

/** What a game must provide to ride on the beacon session. */
export interface GameAdapter<Cfg, State, Move, Priv = undefined> {
  /** Topic namespace and storage prefix, e.g. 'splendor'. */
  app: string
  /** Bump when the wire format changes; builds with different values never meet. */
  protocol: number
  /** Bump when rules change; mismatching clients refuse to play together. */
  rulesVersion: string
  minSeats: number
  maxSeats: number
  /** Host builds the config at start; `players` are in seat order. `prev` is set on rematch. */
  makeConfig(players: { key: string; name: string }[], prev: Cfg | null): Cfg
  /**
   * Initial state for this client. `seat` is null for spectators. `priv` is
   * restored private data (e.g. a hidden reserve) when resuming; otherwise the
   * adapter may generate fresh private data and return it for persistence.
   */
  create(cfg: Cfg, seat: Seat | null, priv?: Priv): { state: State; priv?: Priv }
  apply(state: State, actor: Seat, move: Move): State
  /** Hash of the public state — every client must agree after every move. */
  hash(state: State): string
  /** Whose decision it is right now (turn-holder sequencing). */
  actor(state: State): Seat
  isOver(state: State): boolean
  /**
   * Host-side seating: reorder `players` (given in lobby order) before seats
   * are assigned by index. `prev` is the finished game on a rematch, so a
   * game can swap sides or randomize. Default: lobby order, unchanged.
   */
  orderSeats?<P extends { key: string; name: string }>(players: P[], prev: GameSnapshot<Cfg, Move> | null): P[]
  /**
   * The seat a move by `seat` is recorded under, or null to reject it.
   * Default: only the current actor may move, as itself. Override to allow
   * off-turn moves such as conceding.
   */
  actorFor?(state: State, seat: Seat, move: Move): Seat | null
}

export type Status =
  | 'connecting' // in the room, nobody else heard from yet
  | 'lobby' // gathering players
  | 'playing'
  | 'desync' // a remote move failed validation; awaiting a repair
  | 'room-full' // the lobby is full and we are not seated
  | 'version-mismatch'

export interface Peer {
  key: string
  name: string
  clientId: string
  creator: boolean
  ready: boolean
  wantRematch: boolean
  firstSeen: number
  lastSeen: number
  /** The game and log length they last reported. */
  gameId: string | null
  haveSeq: number
  haveBase: number
  /** Their latest game-defined payload. */
  extra: unknown
}

export interface LobbyPlayer {
  key: string
  name: string
  ready: boolean
  connected: boolean
  host: boolean
  self: boolean
}

export interface SessionOptions<Cfg, Move> {
  room: string
  /** Did this client create the room? Creators win host election. */
  creator: boolean
  identity: { key: string; name: string }
  transport?: Transport<Beacon<Cfg, Move>>
  brokers?: Broker[]
  kv?: KV
  now?: () => number
  /** false → no interval/visibility hooks; call tick() yourself (tests). */
  timers?: boolean
  log?: (text: string) => void
}

interface Saved<Cfg, Move, Priv> {
  snapshot: GameSnapshot<Cfg, Move>
  seat: Seat | null
  priv?: Priv
}

const PEER_STALE_MS = 15_000
const CADENCE_SEARCHING_MS = 2_500
const CADENCE_STEADY_MS = 6_000
const NUDGE_MIN_GAP_MS = 400
/** Logs up to this length always travel whole; longer ones as a tail. */
const FULL_LOG_MAX = 40
const TAIL_LEN = 12
/** After a peer was seen behind our tail, send full logs for this long. */
const FULL_LOG_WINDOW_MS = 8_000

/**
 * Stateless N-player beacon session.
 *
 * One message type, sent on a cadence and on every local change: a beacon
 * with this client's identity, lobby intent and full view of the game.
 * All logic is a pure merge of "latest beacon per peer" into local state:
 *
 * - Presence = "beacon received recently", never transport events.
 * - Host election is a deterministic function of the live peer set
 *   (creator wins, then lowest key); once a game exists its hostKey rules.
 * - The host owns the pre-game roster and starts the game by putting a
 *   snapshot in its beacon; everyone adopts it idempotently.
 * - Moves ride in the log; receivers apply the suffix they lack. Turn-holder
 *   sequencing (the actor self-stamps seq) is valid because at any seq
 *   exactly one seat may act and every in-sync client agrees which.
 *
 * Framework-agnostic: plain fields plus `subscribe` for change notification.
 */
export class BeaconSession<Cfg, State, Move, Priv = undefined> {
  readonly room: string
  readonly myKey: string
  readonly clientId = randomId()
  readonly creator: boolean

  name: string
  ready = false
  wantRematch = false
  /** Game-defined payload carried in our beacons (see `setExtra`). */
  extra: unknown = undefined
  status: Status = 'connecting'
  state: State
  priv: Priv | undefined
  seat: Seat | null = null
  snapshot: GameSnapshot<Cfg, Move> | null = null
  started = false
  readonly peers = new Map<string, Peer>()
  /** Seating order held by the host (ours when hosting, theirs otherwise). */
  private hostRoster: string[] | null = null
  private rosterFrom: string | null = null

  private readonly adapter: GameAdapter<Cfg, State, Move, Priv>
  private readonly transport: Transport<Beacon<Cfg, Move>>
  private readonly kv: KV
  private readonly now: () => number
  private readonly log: (text: string) => void
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastOut = 0
  private dirty = false
  private fullLogUntil = 0
  private presenceSig = ''
  private readonly onVisible = () => {
    if (typeof document !== 'undefined' && document.hidden) return
    this.transport.wake()
    this.sendBeacon()
  }

  constructor(adapter: GameAdapter<Cfg, State, Move, Priv>, opts: SessionOptions<Cfg, Move>) {
    this.adapter = adapter
    this.room = opts.room.toUpperCase()
    this.creator = opts.creator
    this.myKey = opts.identity.key
    this.name = opts.identity.name.trim() || 'Guest'
    this.kv = opts.kv ?? localKV
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((t) => console.log(`[${adapter.app}] ${t}`))

    const placeholderCfg = adapter.makeConfig([{ key: this.myKey, name: this.name }], null)
    this.state = adapter.create(placeholderCfg, null).state

    this.transport =
      opts.transport ??
      connectMqtt({ app: adapter.app, protocol: adapter.protocol, room: this.room, brokers: opts.brokers, log: this.log })
    this.transport.onMessage((b) => this.onBeacon(b))
    this.transport.onUp(() => this.sendBeacon())

    this.restore()
    if (!this.started && this.creator) this.status = 'lobby'

    if (opts.timers !== false) {
      this.timer = setInterval(() => this.tick(), 1000)
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible)
    }
    this.log(`session up · room=${this.room} creator=${this.creator} key=${this.myKey.slice(0, 8)} resumed=${this.started}`)
    this.sendBeacon()
  }

  /* ---------------- derived ---------------- */

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  get playing(): boolean {
    return this.started && (this.status === 'playing' || this.status === 'desync')
  }

  get spectator(): boolean {
    return this.started && this.seat === null
  }

  get isHost(): boolean {
    return this.hostKey === this.myKey
  }

  /**
   * Deterministic host election. Before a game: creators first, then the
   * lowest key among live clients. With a game: its hostKey, unless that
   * player is gone and a live seated player can take over.
   */
  get hostKey(): string {
    const live = this.liveKeys()
    if (this.snapshot) {
      const h = this.snapshot.hostKey
      if (h === this.myKey || live.includes(h)) return h
      const seated = [this.myKey, ...live].filter((k) => this.snapshot!.seats[k] !== undefined).sort()
      return seated[0] ?? h
    }
    const all = [this.myKey, ...live]
    const creators = all.filter((k) => (k === this.myKey ? this.creator : this.peers.get(k)!.creator)).sort()
    return creators[0] ?? all.sort()[0]
  }

  /** Lobby view in seating order; the host's roster is authoritative. */
  get players(): LobbyPlayer[] {
    const host = this.hostKey
    const keys = this.isHost ? this.ownRoster() : (this.hostRoster ?? [this.myKey])
    return keys.map((key) => {
      if (key === this.myKey) {
        return { key, name: this.name, ready: this.ready, connected: true, host: key === host, self: true }
      }
      const p = this.peers.get(key)
      return {
        key,
        name: p?.name ?? '?',
        ready: p?.ready ?? false,
        connected: p ? this.isLive(p) : false,
        host: key === host,
        self: false,
      }
    })
  }

  get canStart(): boolean {
    if (!this.isHost || this.started) return false
    const ps = this.players
    return (
      ps.length >= this.adapter.minSeats &&
      ps.length <= this.adapter.maxSeats &&
      ps.every((p) => p.ready && p.connected)
    )
  }

  get cfg(): Cfg | null {
    return this.snapshot?.cfg ?? null
  }

  get logLength(): number {
    return this.snapshot?.log.length ?? 0
  }

  presence(key: string): boolean {
    if (key === this.myKey) return true
    const p = this.peers.get(key)
    return p ? this.isLive(p) : false
  }

  /** Key of the player whose move it is, when they are absent; else null. */
  get waitingOn(): string | null {
    if (!this.started || !this.snapshot || this.adapter.isOver(this.state)) return null
    const actor = this.adapter.actor(this.state)
    const key = Object.keys(this.snapshot.seats).find((k) => this.snapshot!.seats[k] === actor)
    if (!key || key === this.myKey) return null
    return this.presence(key) ? null : key
  }

  nameOf(key: string): string {
    if (key === this.myKey) return this.name
    return this.peers.get(key)?.name ?? '?'
  }

  channelCount(): number {
    return this.transport.channelCount()
  }

  /* ---------------- actions ---------------- */

  setName(name: string): void {
    this.name = name.trim() || 'Guest'
    this.sendBeacon()
    this.notify()
  }

  setReady(ready: boolean): void {
    this.ready = ready
    this.sendBeacon()
    this.notify()
  }

  /** Attach a game-defined payload to our beacons and announce it now. */
  setExtra(extra: unknown): void {
    this.extra = extra
    this.sendBeacon()
    this.notify()
  }

  /** Live peers (beacon heard recently), in arrival order. */
  get livePeers(): Peer[] {
    return [...this.peers.values()].filter((p) => this.isLive(p)).sort((a, b) => a.firstSeen - b.firstSeen)
  }

  /** Broker/channel status for diagnostics. */
  channels(): { url: string; up: boolean }[] {
    return this.transport.channels()
  }

  startGame(): void {
    if (!this.canStart) return
    const lobby = this.players.map((p) => ({ key: p.key, name: p.name }))
    const players = this.adapter.orderSeats ? this.adapter.orderSeats(lobby, null) : lobby
    const cfg = this.adapter.makeConfig(players, null)
    const seats: Record<string, Seat> = {}
    players.forEach((p, i) => (seats[p.key] = i))
    this.adopt({ gameId: this.newGameId(), createdAt: this.now(), cfg, hostKey: this.myKey, seats, log: [] })
    this.log(`hosting game ${this.snapshot!.gameId} with ${players.length} seats`)
  }

  submit(move: Move): void {
    if (!this.started || !this.snapshot || this.seat === null) throw new Error('not seated')
    const actor = this.adapter.actorFor
      ? this.adapter.actorFor(this.state, this.seat, move)
      : this.adapter.actor(this.state) === this.seat
        ? this.seat
        : null
    if (actor === null) throw new Error('not your turn')
    this.state = this.adapter.apply(this.state, actor, move)
    this.snapshot.log.push({ seq: this.snapshot.log.length + 1, actor, move, hash: this.adapter.hash(this.state) })
    this.persist()
    this.sendBeacon()
    this.notify()
  }

  requestRematch(): void {
    if (!this.started || !this.adapter.isOver(this.state)) return
    this.wantRematch = true
    if (this.isHost) this.startRematch()
    else this.sendBeacon()
    this.notify()
  }

  /** Manual nudge from the lobby: reconnect dropped brokers and re-announce. */
  rescan(): void {
    this.transport.wake()
    this.sendBeacon()
  }

  leave(): void {
    this.kv.remove(this.storageKey())
    this.destroy()
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible)
    this.transport.close()
  }

  /** Runs every second: presence, roster upkeep, beacon cadence. */
  tick(): void {
    const now = this.now()
    if (this.isHost && !this.started) this.hostRoster = this.ownRoster()

    const sig = [...this.peers.values()].map((p) => `${p.key}:${this.isLive(p) ? 1 : 0}`).join(',')
    if (sig !== this.presenceSig) {
      this.presenceSig = sig
      this.notify()
    }

    const steady =
      this.started &&
      this.snapshot !== null &&
      [...this.peers.values()]
        .filter((p) => this.isLive(p))
        .every((p) => p.gameId === this.snapshot!.gameId && p.haveSeq >= this.snapshot!.log.length)
    const cadence = steady ? CADENCE_STEADY_MS : CADENCE_SEARCHING_MS
    if (this.dirty || now - this.lastOut >= cadence) this.sendBeacon()
  }

  /* ---------------- internals ---------------- */

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  private isLive(p: Peer): boolean {
    return this.now() - p.lastSeen < PEER_STALE_MS
  }

  private liveKeys(): string[] {
    return [...this.peers.values()].filter((p) => this.isLive(p)).map((p) => p.key)
  }

  /** Host's roster: self first, then live peers by arrival, capped at maxSeats. */
  private ownRoster(): string[] {
    const prev = this.hostRoster && this.rosterFrom === this.myKey ? this.hostRoster : [this.myKey]
    const keep = prev.filter((k) => k === this.myKey || this.presence(k))
    if (!keep.includes(this.myKey)) keep.unshift(this.myKey)
    const arrivals = [...this.peers.values()]
      .filter((p) => this.isLive(p) && !keep.includes(p.key))
      .sort((a, b) => a.firstSeen - b.firstSeen || (a.key < b.key ? -1 : 1))
    for (const p of arrivals) if (keep.length < this.adapter.maxSeats) keep.push(p.key)
    this.rosterFrom = this.myKey
    return keep
  }

  private newGameId(): string {
    return `${this.room}-${randomId().slice(0, 8)}`
  }

  /** Rate-limited eager beacon (replies to newcomers and repairs). */
  private nudge(): void {
    if (this.now() - this.lastOut >= NUDGE_MIN_GAP_MS) this.sendBeacon()
    else this.dirty = true // send at the next tick instead of dropping the update
  }

  private sendBeacon(): void {
    this.lastOut = this.now()
    this.dirty = false
    this.transport.send({
      t: 'sync',
      protocol: this.adapter.protocol,
      rules: this.adapter.rulesVersion,
      room: this.room,
      clientId: this.clientId,
      key: this.myKey,
      name: this.name,
      creator: this.creator,
      ready: this.ready,
      wantRematch: this.wantRematch,
      roster: !this.started && this.isHost ? (this.hostRoster = this.ownRoster()) : null,
      extra: this.extra,
      game: this.snapshot ? this.wireGame(this.snapshot) : null,
    })
  }

  private wireGame(s: GameSnapshot<Cfg, Move>): WireGame<Cfg, Move> {
    const { log, ...rest } = s
    const full = log.length <= FULL_LOG_MAX || this.now() < this.fullLogUntil
    const logBase = full ? 0 : log.length - TAIL_LEN
    return { ...rest, logLen: log.length, logBase, log: full ? log : log.slice(logBase) }
  }

  private onBeacon(b: Beacon<Cfg, Move>): void {
    if (b?.t !== 'sync' || b.room !== this.room || b.clientId === this.clientId || b.key === this.myKey) return
    if (b.protocol !== this.adapter.protocol || b.rules !== this.adapter.rulesVersion) {
      if (!this.started) this.status = 'version-mismatch'
      this.nudge() // so they learn about us (and the mismatch) too
      this.notify()
      return
    }
    const now = this.now()
    const prev = this.peers.get(b.key)
    const wasLive = prev ? this.isLive(prev) : false
    const peer: Peer = {
      key: b.key,
      name: b.name,
      clientId: b.clientId,
      creator: b.creator,
      ready: b.ready,
      wantRematch: b.wantRematch,
      firstSeen: prev && wasLive ? prev.firstSeen : now,
      lastSeen: now,
      gameId: b.game?.gameId ?? null,
      haveSeq: b.game?.logLen ?? 0,
      haveBase: b.game?.logBase ?? 0,
      extra: b.extra,
    }
    this.peers.set(b.key, peer)
    if (!prev || !wasLive) {
      this.log(`peer present: ${b.name} (${b.key.slice(0, 8)})`)
      this.nudge() // introduce ourselves right away instead of waiting for the cadence
    }

    // roster: trust it only from whoever we compute to be host
    if (b.roster && b.key === this.hostKey) {
      this.hostRoster = b.roster
      this.rosterFrom = b.key
    }
    if (!this.started) {
      const roster = this.isHost ? this.ownRoster() : this.hostRoster
      const full = !!roster && !roster.includes(this.myKey) && roster.length >= this.adapter.maxSeats
      if (this.status !== 'version-mismatch') this.status = full ? 'room-full' : 'lobby'
    }

    if (b.game) this.mergeGame(b.game)

    // rematch: the host acts on anyone's wish for the finished game
    if (
      this.started &&
      this.snapshot &&
      this.isHost &&
      this.adapter.isOver(this.state) &&
      b.game?.gameId === this.snapshot.gameId &&
      (b.wantRematch || this.wantRematch)
    ) {
      this.startRematch()
    }

    // repair: if they lack something we have, answer promptly
    if (this.snapshot) {
      const mine = this.snapshot.log.length
      const behind = !b.game || (b.game.gameId === this.snapshot.gameId && b.game.logLen < mine)
      if (behind) {
        const myBase = mine <= FULL_LOG_MAX ? 0 : mine - TAIL_LEN
        if ((b.game?.logLen ?? 0) < myBase) this.fullLogUntil = now + FULL_LOG_WINDOW_MS
        this.nudge()
      }
    }
    this.notify()
  }

  private mergeGame(g: WireGame<Cfg, Move>): void {
    if (!this.snapshot) {
      if (g.logBase > 0) return // wait for a full log; our beacon (no game) asks for it
      if (g.seats[this.myKey] === undefined && !this.started) {
        // a game we are not part of: adopt as spectator only if the lobby cannot seat us
        // (a late reconnect with a lost key still watches rather than blocks)
      }
      this.log(`adopting game ${g.gameId} as ${g.seats[this.myKey] ?? 'spectator'}`)
      this.adopt(toSnapshot(g))
      return
    }
    if (g.gameId !== this.snapshot.gameId) {
      // a newer game from the legitimate host (rematch) supersedes ours
      const legit = g.hostKey === this.hostKey || this.snapshot.seats[g.hostKey] !== undefined
      if (legit && g.createdAt > this.snapshot.createdAt && g.logBase === 0) {
        this.log(`replacing game ${this.snapshot.gameId} with ${g.gameId}`)
        this.adopt(toSnapshot(g))
      }
      return
    }
    const mine = this.snapshot.log.length
    if (g.logLen <= mine || g.logBase > mine) return
    for (let i = mine - g.logBase; i < g.log.length; i++) {
      try {
        this.applyWire(g.log[i])
      } catch (err) {
        this.log(`remote move rejected: ${String(err)}`)
        this.status = 'desync'
        return
      }
    }
    if (this.status === 'desync') this.status = 'playing'
    this.persist()
  }

  private startRematch(): void {
    if (!this.snapshot) return
    const seated = Object.entries(this.snapshot.seats)
      .sort((a, b) => a[1] - b[1])
      .map(([key]) => ({ key, name: this.nameOf(key) }))
    const players = this.adapter.orderSeats ? this.adapter.orderSeats(seated, this.snapshot) : seated
    const cfg = this.adapter.makeConfig(players, this.snapshot.cfg)
    const seats: Record<string, Seat> = {}
    players.forEach((p, i) => (seats[p.key] = i))
    this.adopt({
      gameId: this.newGameId(),
      createdAt: Math.max(this.now(), this.snapshot.createdAt + 1),
      cfg,
      hostKey: this.myKey,
      seats,
      log: [],
    })
    this.log(`rematch: game ${this.snapshot!.gameId}`)
  }

  /** Take a snapshot as our game (host after creating, guest on receipt). */
  private adopt(snap: GameSnapshot<Cfg, Move>, priv?: Priv): void {
    this.snapshot = { ...snap, log: [] }
    this.seat = snap.seats[this.myKey] ?? null
    this.wantRematch = false
    this.ready = false
    const made = this.adapter.create(snap.cfg, this.seat, priv)
    this.state = made.state
    this.priv = made.priv
    this.started = true
    this.status = 'playing'
    try {
      for (const wire of snap.log) this.applyWire(wire)
    } catch (err) {
      this.log(`replay failed: ${String(err)}`)
      this.status = 'desync'
    }
    this.persist()
    this.sendBeacon()
    this.notify()
  }

  private applyWire(wire: WireMove<Move>): void {
    if (!this.snapshot) return
    if (wire.seq !== this.snapshot.log.length + 1) throw new Error(`bad seq ${wire.seq}`)
    const next = this.adapter.apply(this.state, wire.actor, wire.move)
    if (this.adapter.hash(next) !== wire.hash) throw new Error(`hash mismatch at seq ${wire.seq}`)
    this.state = next
    this.snapshot.log.push(wire)
  }

  private storageKey(): string {
    return `${this.adapter.app}:room:${this.room}:${this.myKey}`
  }

  private persist(): void {
    if (!this.snapshot) return
    const saved: Saved<Cfg, Move, Priv> = { snapshot: this.snapshot, seat: this.seat, priv: this.priv }
    this.kv.set(this.storageKey(), JSON.stringify(saved))
  }

  private restore(): void {
    const raw = this.kv.get(this.storageKey())
    if (!raw) return
    try {
      const saved = JSON.parse(raw) as Saved<Cfg, Move, Priv>
      if (!saved?.snapshot?.gameId || !Array.isArray(saved.snapshot.log)) return
      this.adopt(saved.snapshot, saved.priv)
      this.log(`restored game ${saved.snapshot.gameId} at move ${saved.snapshot.log.length}`)
    } catch (err) {
      this.log(`saved game unusable (${String(err)})`)
      this.snapshot = null
      this.started = false
      this.status = 'connecting'
      this.kv.remove(this.storageKey())
    }
  }
}

function toSnapshot<Cfg, Move>(g: WireGame<Cfg, Move>): GameSnapshot<Cfg, Move> {
  const { logLen: _l, logBase: _b, ...rest } = g
  return { ...rest, log: g.log }
}

function randomId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
