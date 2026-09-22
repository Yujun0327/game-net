import { canonicalize } from './canonical'
import { type Identity } from './identity'
import { Ledger } from './ledger'
import { computeDeltas, MONEY_RULES, modesFor, validateSettlement, type Delta, type Mode } from './money'
import type { Attestation } from './protocol'
import { BeaconSession } from './session'
import { buildLock, buildSettlement, signLock, signSettlement } from './settlement'

export type PayoutStatus = 'none' | 'signing' | 'pending' | 'settled' | 'void' | 'rejected'

export interface Payout {
  status: PayoutStatus
  /** My own cash / trophy change once settled. */
  cash: number
  trophies: number
  /** Seats that have signed so far (keys). */
  attested: string[]
  seatCount: number
  error?: string
}

export interface LockState {
  status: 'none' | 'locking' | 'locked' | 'void'
  locked: string[]
  error?: string
}

/**
 * Attaches wallet behaviour to a BeaconSession: locks the stake when a bet
 * game starts, signs and posts the settlement when the game ends, and
 * reports the outcome. Each seat posts only its OWN signature; the ledger
 * completes the settlement when every seat has spoken.
 */
export class WalletSession<Cfg, State, Move, Priv> {
  payout: Payout = { status: 'none', cash: 0, trophies: 0, attested: [], seatCount: 0 }
  lock: LockState = { status: 'none', locked: [] }
  private listeners = new Set<() => void>()
  private gameId = ''
  private overSeen = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private lockTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: () => void

  constructor(
    private readonly core: BeaconSession<Cfg, State, Move, Priv>,
    private readonly app: string,
    private readonly identity: Identity,
    private readonly ledger: Ledger,
    private readonly now: () => number = Date.now,
  ) {
    this.unsubscribe = core.subscribe(() => this.sync())
    this.sync()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  destroy(): void {
    this.unsubscribe()
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.lockTimer) clearTimeout(this.lockTimer)
  }

  /** Is this game one the ledger will pay for? */
  get eligible(): boolean {
    const core = this.core
    if (!core.snapshot || core.seat === null) return false
    const rule = MONEY_RULES[this.app]
    if (!rule) return false
    const keys = Object.keys(core.snapshot.seats)
    return keys.length >= 2 && new Set(keys).size === keys.length && keys.includes(this.identity.id)
  }

  get mode(): Mode | null {
    if (!this.core.snapshot) return null
    const stake = this.core.adapter.stake?.(this.core.snapshot.cfg) ?? 0
    const modes = modesFor(this.app)
    if (stake > 0 && modes.includes('bet')) return 'bet'
    return modes.includes('casual') ? 'casual' : null
  }

  get stake(): number {
    return this.mode === 'bet' ? (this.core.adapter.stake?.(this.core.snapshot!.cfg) ?? 0) : 0
  }

  private sync(): void {
    const core = this.core
    const snap = core.snapshot
    if (!snap) return
    if (snap.gameId !== this.gameId) {
      this.gameId = snap.gameId
      this.overSeen = false
      this.payout = { status: 'none', cash: 0, trophies: 0, attested: [], seatCount: Object.keys(snap.seats).length }
      this.lock = { status: 'none', locked: [] }
      if (this.eligible && this.mode === 'bet') void this.startLock()
      // a restored game may already carry our settlement signature
      if (core.attest?.gameId === snap.gameId && core.attest.kind === 'settle') {
        this.overSeen = true
        this.payout.status = core.attest.posted ? 'pending' : 'signing'
        if (!core.attest.posted) void this.postSettle(core.attest)
        else this.poll()
      }
    }
    if (this.mode === 'bet') this.lock.locked = Object.keys(core.attestations('lock'))
    this.payout.attested = Object.keys(core.attestations('settle'))
    if (!this.overSeen && core.adapter.isOver(core.state)) {
      this.overSeen = true
      if (this.eligible && this.mode) void this.settle()
    }
    this.notify()
  }

  private async startLock(): Promise<void> {
    const core = this.core
    const snap = core.snapshot!
    this.lock = { status: 'locking', locked: [] }
    const { msg, sig } = signLock(this.identity, buildLock(snap, this.app, this.stake))
    core.setAttest({ gameId: snap.gameId, kind: 'lock', sig })
    const reply = await this.ledger.lock(this.identity, msg, sig)
    if (!reply.ok) {
      this.lock = { status: 'void', locked: this.lock.locked, error: reply.error ?? 'lock failed' }
    } else if (reply.status === 'locked') {
      this.lock.status = 'locked'
    }
    this.notify()
    this.lockTimer = setTimeout(() => {
      if (this.lock.status !== 'locked' || this.lock.locked.length < this.payout.seatCount) {
        if (this.lock.status !== 'void') this.lock = { ...this.lock, status: 'void', error: 'not every seat locked in time' }
        this.notify()
      }
    }, 30_000)
  }

  private async settle(): Promise<void> {
    const core = this.core
    const snap = core.snapshot!
    const winners = core.adapter.winners?.(core.state) ?? []
    const settlement = buildSettlement(snap, this.app, this.mode!, this.stake, winners, core.adapter.hash(core.state))
    const problem = validateSettlement(settlement, this.now())
    if (problem) {
      this.payout = { ...this.payout, status: 'rejected', error: problem }
      this.notify()
      return
    }
    const { sig } = signSettlement(this.identity, settlement)
    const attest: Attestation = { gameId: snap.gameId, kind: 'settle', sig, posted: false }
    this.payout.status = 'signing'
    core.setAttest(attest)
    await this.postSettle(attest, canonicalize(settlement))
  }

  private async postSettle(attest: Attestation, msg?: string): Promise<void> {
    const core = this.core
    const snap = core.snapshot!
    if (!msg) {
      // rebuilt after a reload: recompute the exact same canonical settlement
      const winners = core.adapter.winners?.(core.state) ?? []
      msg = canonicalize(buildSettlement(snap, this.app, this.mode ?? 'casual', this.stake, winners, core.adapter.hash(core.state)))
    }
    const reply = await this.ledger.settle(this.identity, msg, attest.sig)
    if (!reply.ok) {
      this.payout = { ...this.payout, status: 'rejected', error: reply.error ?? 'settle failed' }
      this.notify()
      return
    }
    core.setAttest({ ...attest, posted: true })
    if (reply.status === 'settled' || reply.status === 'void') {
      this.finish(reply.status)
    } else {
      this.payout.status = 'pending'
      this.notify()
      this.poll()
    }
  }

  private poll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(async () => {
      const view = await this.ledger.readSettlement(this.gameId)
      if (view && view.status !== 'pending') this.finish(view.status, view.deltas)
      else if (this.payout.status === 'pending') this.poll()
    }, 3000)
  }

  private finish(status: 'settled' | 'void', deltas?: Delta[] | null): void {
    const core = this.core
    let mine: Delta | undefined = deltas?.find((d) => d.player === this.identity.id)
    if (!mine && status === 'settled' && core.snapshot) {
      const winners = core.adapter.winners?.(core.state) ?? []
      const s = buildSettlement(core.snapshot, this.app, this.mode ?? 'casual', this.stake, winners, core.adapter.hash(core.state))
      mine = computeDeltas(s, { escrowed: true, overCap: false }).find((d) => d.player === this.identity.id)
    }
    this.payout = { ...this.payout, status, cash: mine?.cash ?? 0, trophies: mine?.trophies ?? 0 }
    this.notify()
  }
}
