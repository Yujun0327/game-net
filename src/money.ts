/**
 * The money rules — the ONE place to change how a game pays out. Imported by
 * every game client and by the ledger's Edge Function, so client and server
 * always agree.
 *
 * - `casual`: winners get this much; losing costs nothing.
 * - `stakes`: the game may be played for a stake from this list; every seat
 *   locks the stake at the start and the winners split the pot.
 * A game may offer both. Omit both and the game never settles.
 */
export interface MoneyRule {
  casual?: number
  stakes?: number[]
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
}

export const DAILY_CASH = 1000

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
  v: 1
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
  if (r.stakes?.length) m.push('bet')
  return m
}

/** Structural and rule validation shared by client and server. Returns a reason or null. */
export function validateSettlement(s: Settlement, now: number): string | null {
  if (s?.v !== 1) return 'bad version'
  const rule = MONEY_RULES[s.app]
  if (!rule) return 'unknown app'
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
    if (!rule.stakes?.includes(s.stake)) return 'stake not allowed'
  } else return 'bad mode'
  if (!Array.isArray(s.winners) || new Set(s.winners).size !== s.winners.length) return 'bad winners'
  if (!s.winners.every((w) => Number.isInteger(w) && w >= 0 && w < n)) return 'winner not seated'
  if (rule.coop) {
    if (s.winners.length !== 0 && s.winners.length !== n) return 'coop: all or none'
  } else if (s.winners.length < 1 || s.winners.length >= n) return 'need 1..n-1 winners'
  if (!Number.isSafeInteger(s.createdAt) || s.createdAt < now - 7 * 86_400_000 || s.createdAt > now + 300_000) {
    return 'createdAt out of range'
  }
  if (!Number.isSafeInteger(s.logLen) || s.logLen < rule.minMoves) return 'game too short'
  if (typeof s.finalHash !== 'string' || s.finalHash.length > 128) return 'bad hash'
  return null
}

/**
 * Cash and trophy deltas for a valid settlement. For bets the stakes were
 * already taken into escrow, so only the pot is paid out here; `escrowed`
 * false means the game is void (nothing moves). `overCap` keeps the game
 * closed but pays nothing.
 */
export function computeDeltas(s: Settlement, opts: { escrowed: boolean; overCap: boolean }): Delta[] {
  const rule = MONEY_RULES[s.app]
  const zero = s.seats.map((x) => ({ player: x.player, cash: 0, trophies: 0 }))
  if (!rule || opts.overCap) return zero
  const byPlayer = new Map(zero.map((d) => [d.player, d]))
  const winnerKeys = s.winners.map((w) => s.seats.find((x) => x.seat === w)!.player)
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
    const d = byPlayer.get(s.seats.find((x) => x.seat === w)!.player)!
    d.cash += share + (w === lowestWinner ? remainder : 0)
    d.trophies += rule.trophies.bet ?? 0
  }
  return [...byPlayer.values()]
}
