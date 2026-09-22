export type Seat = number

export interface WireMove<Move> {
  seq: number
  actor: Seat
  move: Move
  /** Hash of the public state AFTER applying this move. */
  hash: string
}

/** The complete shared description of one game — everything public. */
export interface GameSnapshot<Cfg, Move> {
  gameId: string
  /** Wall-clock at creation; a newer game from a legitimate host supersedes an older one. */
  createdAt: number
  cfg: Cfg
  hostKey: string
  /** playerKey → seat index. */
  seats: Record<string, Seat>
  log: WireMove<Move>[]
}

/** A snapshot on the wire. Long logs travel as a tail; `logBase` says where it starts. */
export interface WireGame<Cfg, Move> extends Omit<GameSnapshot<Cfg, Move>, 'log'> {
  logLen: number
  /** Number of moves omitted before `log[0]` (0 = the full log). */
  logBase: number
  log: WireMove<Move>[]
}

/**
 * The ONLY wire message. Every beacon carries the sender's identity, lobby
 * intent and complete view of the game, so convergence never depends on
 * ordering, connection events or who spoke first: any dropped or stale
 * message is repaired by the next beacon.
 */
export interface Beacon<Cfg, Move> {
  t: 'sync'
  protocol: number
  rules: string
  room: string
  clientId: string
  key: string
  name: string
  creator: boolean
  ready: boolean
  /** "I want a rematch of `game`" — only meaningful with a finished game attached. */
  wantRematch: boolean
  /** Seating order (keys), sent only by whoever believes they host the lobby. */
  roster: string[] | null
  /** Game-defined payload (lobby options, chat…) merged by the game, not the core. */
  extra: unknown
  game: WireGame<Cfg, Move> | null
}
