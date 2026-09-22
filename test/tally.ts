import type { GameAdapter, Seat } from '../src/index'

/** A toy turn-based game: each seat adds a number on its turn; ends after 3 rounds. */
export interface Cfg {
  playerCount: number
  names: string[]
  seed: number
}
export interface State {
  turn: Seat
  totals: number[]
  moves: number
  over: boolean
  /** Only the owning client knows this (tests private data). */
  secret?: string
}
export type Move = { add: number } | { concede: true }

export const tally: GameAdapter<Cfg, State, Move, string> = {
  app: 'tally',
  protocol: 1,
  rulesVersion: '1',
  minSeats: 2,
  maxSeats: 4,
  makeConfig: (players, prev) => ({
    playerCount: players.length,
    names: players.map((p) => p.name),
    seed: (prev?.seed ?? 0) + 1,
  }),
  create: (cfg, seat, priv) => {
    const secret = seat === null ? undefined : (priv ?? `secret-of-${seat}-${Math.random().toString(36).slice(2, 6)}`)
    return {
      state: { turn: cfg.seed % cfg.playerCount, totals: Array(cfg.playerCount).fill(0), moves: 0, over: false, secret },
      priv: secret,
    }
  },
  apply: (s, actor, move) => {
    if (s.over) throw new Error('game over')
    if ('concede' in move) return { ...s, over: true }
    if (actor !== s.turn) throw new Error('wrong actor')
    const totals = [...s.totals]
    totals[actor] += move.add
    const moves = s.moves + 1
    return { ...s, totals, moves, turn: (s.turn + 1) % totals.length, over: moves >= 3 * totals.length }
  },
  hash: (s) => `${s.turn}|${s.totals.join(',')}|${s.moves}|${s.over}`,
  actor: (s) => s.turn,
  isOver: (s) => s.over,
  actorFor: (s, seat, move) => ('concede' in move ? seat : s.turn === seat ? seat : null),
  winners: (s) => {
    const best = Math.max(...s.totals)
    return s.totals.map((t, i) => (t === best ? i : -1)).filter((i) => i >= 0)
  },
}

/**
 * The same toy game played as a zero-sum table: every seat buys in for
 * `stake`, and the final totals decide a net payout per seat (10 per point
 * above / below the table mean, remainder to the lowest seat) — a copy so
 * the casual adapter above stays untouched.
 */
export const tallyTable: GameAdapter<Cfg, State, Move, string> = {
  ...tally,
  app: 'tallytable',
  stake: () => 100,
  payouts: (s) => {
    const n = s.totals.length
    const sum = s.totals.reduce((a, b) => a + b, 0)
    const raw = s.totals.map((t) => t * n * 10 - sum * 10)
    const p = raw.map((x) => Math.trunc(x / n))
    p[0] -= p.reduce((a, b) => a + b, 0)
    return p
  },
  winners: (s) => {
    const p = tallyTable.payouts!(s, { playerCount: s.totals.length, names: [], seed: 0 })
    return p.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0)
  },
}
