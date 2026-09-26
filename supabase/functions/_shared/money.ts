/**
 * The money rules — the ONE place to change how a game pays out. Imported by
 * every game client and by the ledger's Edge Function, so client and server
 * always agree.
 *
 * - `casual`: winners get this much; losing costs nothing.
 * - `stakes`: the game may be played for a stake from this list; every seat
 *   locks the stake at the start and the winners split the pot.
 * - `table`: zero-sum table games (gostop, seotda). Every seat buys in for a
 *   stake from `buyIns`; the game itself computes a net cash result per seat
 *   (`payouts`, summing to zero, nobody loses more than the buy-in) and the
 *   ledger returns each escrowed buy-in plus that net.
 * A game may offer casual + stakes. Omit all and the game never settles.
 */
export interface MoneyRule {
  casual?: number
  stakes?: number[]
  table?: {
    buyIns: number[]
    /** Cash per game point, parallel to buyIns (informational for the game UI). */
    pointValues?: number[]
    /** Points beyond which the game stops counting (informational for the game UI). */
    capPoints?: number
  }
  trophies: { casual?: number; bet?: number }
  /** Minimum log length for a rewarded game (stops instant farm games). */
  minMoves: number
  minSeats: number
  maxSeats: number
  /** Co-op: everyone wins or nobody does. */
  coop?: boolean
}

export const MONEY_RULES: Record<string, MoneyRule> = {
  toybattle: { casual: 300, trophies: { casual: 10, bet: 20 }, minMoves: 8, minSeats: 2, maxSeats: 2 },
  splendor: { casual: 300, trophies: { casual: 10, bet: 20 }, minMoves: 12, minSeats: 2, maxSeats: 4 },
  harmonies: { casual: 300, trophies: { casual: 10, bet: 20 }, minMoves: 12, minSeats: 2, maxSeats: 4 },
  castlecombo: { casual: 300, trophies: { casual: 10, bet: 20 }, minMoves: 12, minSeats: 2, maxSeats: 4 },
  davincicode: { casual: 200, trophies: { casual: 10, bet: 20 }, minMoves: 8, minSeats: 2, maxSeats: 4 },
  skyteam: { casual: 300, trophies: { casual: 10 }, minMoves: 12, minSeats: 2, maxSeats: 2, coop: true },
  yachtnight: { stakes: [100, 300, 1000], trophies: { bet: 20 }, minMoves: 24, minSeats: 2, maxSeats: 4 },
  gostop: {
    table: { buyIns: [5000, 25000, 50000], pointValues: [100, 500, 1000], capPoints: 50 },
    trophies: { bet: 20 },
    minMoves: 10,
    minSeats: 2,
    maxSeats: 3,
  },
  seotda: { table: { buyIns: [5000, 10000, 20000, 50000, 100000] }, trophies: { bet: 20 }, minMoves: 12, minSeats: 2, maxSeats: 5 },
  holdem: { table: { buyIns: [5000, 10000, 20000, 50000, 100000] }, trophies: { bet: 20 }, minMoves: 12, minSeats: 2, maxSeats: 6 },
}

export const DAILY_CASH = 1000

/**
 * Cash a brand-new account starts with. Reserved for a one-edit economy
 * rebalance (table buy-ins are larger than a day's cash); not applied
 * anywhere yet — the ledger still opens every account at 0.
 */
export const STARTING_GRANT = 50000

export const CAPS = {
  /** Rewarded games per player per KST day. */
  rewardedGamesPerDay: 20,
  /** Rewarded games per identical set of seats per KST day. */
  perSeatSetPerDay: 5,
  /** A bet loser's account must be at least this old (ms). */
  loserAccountAgeMs: 24 * 60 * 60 * 1000,
}

export type Mode = 'casual' | 'bet'

/** The signed record of a finished game. No names, no per-signer fields. */
export interface Settlement {
  /** 1: casual / classic bet. 2: table settlement (carries `payouts`). */
  v: 1 | 2
  gameId: string
  app: string
  mode: Mode
  /** 0 for casual. */
  stake: number
  /** Wall-clock ms at game creation. */
  createdAt: number
  logLen: number
  finalHash: string
  seats: { player: string; seat: number }[]
  winners: number[]
  /** Table games only (v 2): net cash per seat, indexed by seat, summing to zero. */
  payouts?: number[]
}

export interface Delta {
  player: string
  cash: number
  trophies: number
}

export function modesFor(app: string): Mode[] {
  const r = MONEY_RULES[app]
  if (!r) return []
  const m: Mode[] = []
  if (r.casual !== undefined) m.push('casual')
  if (r.stakes?.length || r.table?.buyIns.length) m.push('bet')
  return m
}

/** The stakes a bet game of `app` may be locked for (classic stakes or table buy-ins). */
export function stakesFor(app: string): number[] {
  const r = MONEY_RULES[app]
  return r?.stakes ?? r?.table?.buyIns ?? []
}

export function isTableGame(app: string): boolean {
  return MONEY_RULES[app]?.table !== undefined
}

/** Structural and rule validation shared by client and server. Returns a reason or null. */
export function validateSettlement(s: Settlement, now: number): string | null {
  const rule = s ? MONEY_RULES[s.app] : undefined
  if (!rule) return s?.v === 1 || s?.v === 2 ? 'unknown app' : 'bad version'
  const table = rule.table
  if (table ? s.v !== 2 : s.v !== 1) return 'bad version'
  if (typeof s.gameId !== 'string' || s.gameId.length < 6 || s.gameId.length > 64) return 'bad gameId'
  const n = s.seats?.length ?? 0
  if (n < rule.minSeats || n > rule.maxSeats) return 'bad seat count'
  const seatNums = s.seats.map((x) => x.seat).sort((a, b) => a - b)
  if (!seatNums.every((v, i) => v === i)) return 'seats must be 0..n-1'
  const keys = s.seats.map((x) => x.player)
  if (new Set(keys).size !== n) return 'duplicate players'
  if (!keys.every((k) => typeof k === 'string' && k.length === 43)) return 'bad player id'
  if (s.mode === 'casual') {
    if (rule.casual === undefined) return 'casual not allowed'
    if (s.stake !== 0) return 'casual stake must be 0'
  } else if (s.mode === 'bet') {
    if (!stakesFor(s.app).includes(s.stake)) return 'stake not allowed'
  } else return 'bad mode'
  if (!Array.isArray(s.winners) || new Set(s.winners).size !== s.winners.length) return 'bad winners'
  if (!s.winners.every((w) => Number.isInteger(w) && w >= 0 && w < n)) return 'winner not seated'
  if (table) {
    const p = s.payouts
    if (!Array.isArray(p) || p.length !== n) return 'table: payouts must cover every seat'
    if (!p.every((x) => Number.isSafeInteger(x))) return 'table: payouts must be integers'
    if (p.reduce((a, b) => a + b, 0) !== 0) return 'table: payouts must sum to zero'
    if (p.some((x) => x < -s.stake)) return 'table: loss exceeds stake'
    const expected = p.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0)
    const sorted = [...s.winners].sort((a, b) => a - b)
    if (sorted.length !== expected.length || !sorted.every((w, i) => w === expected[i])) return 'table: winners must be the seats paid'
  } else {
    if (s.payouts !== undefined) return 'payouts only for table games'
    if (rule.coop) {
      if (s.winners.length !== 0 && s.winners.length !== n) return 'coop: all or none'
    } else if (s.winners.length < 1 || s.winners.length >= n) return 'need 1..n-1 winners'
  }
  if (!Number.isSafeInteger(s.createdAt) || s.createdAt < now - 7 * 86_400_000 || s.createdAt > now + 300_000) {
    return 'createdAt out of range'
  }
  if (!Number.isSafeInteger(s.logLen) || s.logLen < rule.minMoves) return 'game too short'
  if (typeof s.finalHash !== 'string' || s.finalHash.length > 128) return 'bad hash'
  return null
}

/**
 * Cash and trophy deltas for a valid settlement. For bets the stakes were
 * already taken into escrow, so classic bets pay only the pot here, while
 * table games pay each seat its escrowed stake plus its net payout.
 * `escrowed` false means the game is void (nothing moves). `overCap` keeps
 * the game closed but pays nothing — except a table game's escrow, which is
 * always returned (a stake is never lost to a cap).
 */
export function computeDeltas(s: Settlement, opts: { escrowed: boolean; overCap: boolean }): Delta[] {
  const rule = MONEY_RULES[s.app]
  const zero = s.seats.map((x) => ({ player: x.player, cash: 0, trophies: 0 }))
  if (!rule) return zero
  const byPlayer = new Map(zero.map((d) => [d.player, d]))
  const playerAt = (seat: number) => s.seats.find((x) => x.seat === seat)!.player
  if (rule.table && s.mode === 'bet') {
    if (!opts.escrowed) return zero
    for (const x of s.seats) byPlayer.get(x.player)!.cash = s.stake + (opts.overCap ? 0 : (s.payouts?.[x.seat] ?? 0))
    if (!opts.overCap) for (const w of s.winners) byPlayer.get(playerAt(w))!.trophies += rule.trophies.bet ?? 0
    return [...byPlayer.values()]
  }
  if (opts.overCap) return zero
  const winnerKeys = s.winners.map(playerAt)
  if (s.mode === 'casual') {
    for (const k of winnerKeys) {
      const d = byPlayer.get(k)!
      d.cash += rule.casual ?? 0
      d.trophies += rule.trophies.casual ?? 0
    }
    return [...byPlayer.values()]
  }
  if (!opts.escrowed || winnerKeys.length === 0) return zero
  const pot = s.stake * s.seats.length
  const share = Math.floor(pot / winnerKeys.length)
  const remainder = pot - share * winnerKeys.length
  const lowestWinner = s.winners.slice().sort((a, b) => a - b)[0]
  for (const w of s.winners) {
    const d = byPlayer.get(playerAt(w))!
    d.cash += share + (w === lowestWinner ? remainder : 0)
    d.trophies += rule.trophies.bet ?? 0
  }
  return [...byPlayer.values()]
}

/**
 * The seats whose accounts the ledger age-checks before paying: table games
 * — whoever ends the game down; classic bets — every non-winner.
 */
export function losersOf(s: Settlement): string[] {
  const table = MONEY_RULES[s.app]?.table
  return s.seats
    .filter((x) => (table ? (s.payouts?.[x.seat] ?? 0) < 0 : !s.winners.includes(x.seat)))
    .map((x) => x.player)
}
