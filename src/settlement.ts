import { canonicalize, sha256hex } from './canonical'
import { sign, type Identity } from './identity'
import type { Mode, Settlement } from './money'
import type { GameSnapshot } from './protocol'

export function buildSettlement<Cfg, Move>(
  snapshot: GameSnapshot<Cfg, Move>,
  app: string,
  mode: Mode,
  stake: number,
  winners: number[],
  finalHash: string,
): Settlement {
  return {
    v: 1,
    gameId: snapshot.gameId,
    app,
    mode,
    stake: mode === 'bet' ? stake : 0,
    createdAt: snapshot.createdAt,
    logLen: snapshot.log.length,
    finalHash,
    seats: Object.entries(snapshot.seats)
      .map(([player, seat]) => ({ player, seat }))
      .sort((a, b) => a.seat - b.seat),
    winners: [...winners].sort((a, b) => a - b),
  }
}

export function settlementId(s: Settlement): string {
  return sha256hex(canonicalize(s))
}

export function signSettlement(id: Identity, s: Settlement): { msg: string; sig: string } {
  const msg = canonicalize(s)
  return { msg, sig: sign(id, 'settle', msg) }
}

/** The lock message every seat signs at the start of a bet game. */
export interface LockMsg {
  v: 1
  gameId: string
  app: string
  stake: number
  players: string[]
}

export function buildLock<Cfg, Move>(snapshot: GameSnapshot<Cfg, Move>, app: string, stake: number): LockMsg {
  return { v: 1, gameId: snapshot.gameId, app, stake, players: Object.keys(snapshot.seats).sort() }
}

export function signLock(id: Identity, lock: LockMsg): { msg: string; sig: string } {
  const msg = canonicalize(lock)
  return { msg, sig: sign(id, 'lock', msg) }
}
