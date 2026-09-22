import { describe, expect, it } from 'vitest'
import { memoryKV } from '../src/kv'
import { canonicalize, sha256hex } from '../src/canonical'
import { exportSeed, identityFromSeed, importSeed, loadIdentity, sign, verify, type Identity } from '../src/identity'
import { computeDeltas, losersOf, modesFor, stakesFor, validateSettlement, type Settlement } from '../src/money'
import { BeaconSession } from '../src/session'
import { Mesh } from '../src/mesh'
import { Ledger, type LedgerReply } from '../src/ledger'
import { WalletSession } from '../src/wallet'
import { tally, tallyTable, type Cfg, type Move, type State } from './tally'

describe('canonical', () => {
  it('sorts keys, keeps arrays, rejects floats and undefined', () => {
    expect(canonicalize({ b: 1, a: [3, { z: 'x', y: null }] })).toBe('{"a":[3,{"y":null,"z":"x"}],"b":1}')
    expect(canonicalize({ a: undefined, b: true })).toBe('{"b":true}')
    expect(() => canonicalize({ a: 1.5 })).toThrow()
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('identity', () => {
  it('creates once, exports and imports the seed, signs and verifies under a domain', () => {
    const kv = memoryKV()
    const a = loadIdentity(kv)
    expect(loadIdentity(kv).id).toBe(a.id)
    expect(a.id.length).toBe(43)
    const kv2 = memoryKV()
    const b = importSeed(exportSeed(a), kv2)
    expect(b.id).toBe(a.id)
    const sig = sign(a, 'settle', '{"x":1}')
    expect(verify(a.id, 'settle', '{"x":1}', sig)).toBe(true)
    expect(verify(a.id, 'lock', '{"x":1}', sig)).toBe(false) // domain separation
    expect(verify(a.id, 'settle', '{"x":2}', sig)).toBe(false)
  })
})

const ids: Identity[] = [1, 2, 3, 4].map((n) => identityFromSeed(new Uint8Array(32).fill(n)))

function settlement(over: Partial<Settlement> = {}): Settlement {
  return {
    v: 1,
    gameId: 'ROOM-abcdef12',
    app: 'splendor',
    mode: 'casual',
    stake: 0,
    createdAt: 1_000_000,
    logLen: 30,
    finalHash: 'h',
    seats: [0, 1, 2].map((seat) => ({ player: ids[seat].id, seat })),
    winners: [1],
    ...over,
  }
}

describe('money rules', () => {
  const now = 1_000_000 + 60_000
  it('accepts a good casual settlement and pays the winner only', () => {
    expect(validateSettlement(settlement(), now)).toBeNull()
    const d = computeDeltas(settlement(), { escrowed: false, overCap: false })
    expect(d.map((x) => x.cash)).toEqual([0, 300, 0])
    expect(d.map((x) => x.trophies)).toEqual([0, 10, 0])
  })
  it('rejects the cheap cheats', () => {
    expect(validateSettlement(settlement({ app: 'nope' }), now)).toBe('unknown app')
    expect(validateSettlement(settlement({ logLen: 3 }), now)).toBe('game too short')
    expect(validateSettlement(settlement({ winners: [0, 1, 2] }), now)).toBe('need 1..n-1 winners')
    expect(validateSettlement(settlement({ seats: [{ player: ids[0].id, seat: 0 }, { player: ids[0].id, seat: 1 }, { player: ids[2].id, seat: 2 }] }), now)).toBe('duplicate players')
    expect(validateSettlement(settlement({ stake: 100 }), now)).toBe('casual stake must be 0')
    expect(validateSettlement(settlement({ app: 'yachtnight', mode: 'bet', stake: 250 }), now)).toBe('stake not allowed')
    expect(validateSettlement(settlement({ app: 'yachtnight', mode: 'casual' }), now)).toBe('casual not allowed')
    expect(validateSettlement(settlement({ createdAt: now + 600_000 }), now)).toBe('createdAt out of range')
  })
  it('splits a bet pot among tied winners, remainder to the lowest seat', () => {
    const s = settlement({ app: 'yachtnight', mode: 'bet', stake: 100, winners: [0, 2] })
    expect(validateSettlement(s, now)).toBeNull()
    const d = computeDeltas(s, { escrowed: true, overCap: false })
    expect(d.map((x) => x.cash)).toEqual([150, 0, 150])
    expect(d.map((x) => x.trophies)).toEqual([20, 0, 20])
    const odd = computeDeltas(settlement({ app: 'yachtnight', mode: 'bet', stake: 100, winners: [1, 2], seats: [0, 1, 2].map((seat) => ({ player: ids[seat].id, seat })) }), { escrowed: true, overCap: false })
    expect(odd.map((x) => x.cash)).toEqual([0, 150, 150])
    expect(computeDeltas(s, { escrowed: false, overCap: false }).every((x) => x.cash === 0)).toBe(true)
    expect(computeDeltas(s, { escrowed: true, overCap: true }).every((x) => x.cash === 0)).toBe(true)
  })
  const table = (over: Partial<Settlement> = {}) =>
    settlement({ v: 2, app: 'gostop', mode: 'bet', stake: 5000, payouts: [3000, -1000, -2000], winners: [0], ...over })
  it('table games: zero-sum payouts bounded by the stake, winners = seats paid', () => {
    expect(modesFor('gostop')).toEqual(['bet'])
    expect(stakesFor('gostop')).toEqual([5000, 25000, 50000])
    expect(validateSettlement(table(), now)).toBeNull()
    expect(validateSettlement(table({ v: 1 }), now)).toBe('bad version')
    expect(validateSettlement(table({ payouts: undefined }), now)).toBe('table: payouts must cover every seat')
    expect(validateSettlement(table({ payouts: [3000, -1000] }), now)).toBe('table: payouts must cover every seat')
    expect(validateSettlement(table({ payouts: [3000, -1000, -1000] }), now)).toBe('table: payouts must sum to zero')
    expect(validateSettlement(table({ payouts: [7000, -1000, -6000] }), now)).toBe('table: loss exceeds stake')
    expect(validateSettlement(table({ payouts: [3000.5, -1000.5, -2000] }), now)).toBe('table: payouts must be integers')
    expect(validateSettlement(table({ winners: [1] }), now)).toBe('table: winners must be the seats paid')
    expect(validateSettlement(table({ winners: [] }), now)).toBe('table: winners must be the seats paid')
    expect(validateSettlement(table({ payouts: [2000, 1000, -3000], winners: [0, 1] }), now)).toBeNull()
    expect(validateSettlement(table({ payouts: [0, 0, 0], winners: [] }), now)).toBeNull()
    expect(validateSettlement(table({ stake: 7000 }), now)).toBe('stake not allowed')
    expect(validateSettlement(table({ mode: 'casual', stake: 0 }), now)).toBe('casual not allowed')
    expect(validateSettlement(table({ app: 'seotda', stake: 20000, logLen: 20 }), now)).toBeNull()
    expect(validateSettlement(table({ seats: [0, 1, 2, 3].map((seat) => ({ player: ids[seat].id, seat })) }), now)).toBe('bad seat count')
    // non-table games must not carry payouts, and v 2 is reserved for tables
    expect(validateSettlement(settlement({ payouts: [300, 0, 0] }), now)).toBe('payouts only for table games')
    expect(validateSettlement(settlement({ v: 2 }), now)).toBe('bad version')
    expect(validateSettlement(settlement({ app: 'yachtnight', mode: 'bet', stake: 100 }), now)).toBeNull()
  })
  it('table deltas: escrowed stake back plus the net; a cap returns the stake; void moves nothing', () => {
    const d = computeDeltas(table(), { escrowed: true, overCap: false })
    expect(d.map((x) => x.cash)).toEqual([8000, 4000, 3000])
    expect(d.map((x) => x.trophies)).toEqual([20, 0, 0])
    const capped = computeDeltas(table(), { escrowed: true, overCap: true })
    expect(capped.map((x) => x.cash)).toEqual([5000, 5000, 5000])
    expect(capped.map((x) => x.trophies)).toEqual([0, 0, 0])
    expect(computeDeltas(table(), { escrowed: false, overCap: false }).every((x) => x.cash === 0 && x.trophies === 0)).toBe(true)
    expect(losersOf(table())).toEqual([ids[1].id, ids[2].id])
    expect(losersOf(table({ payouts: [0, 0, 0], winners: [] }))).toEqual([])
    expect(losersOf(settlement({ app: 'yachtnight', mode: 'bet', stake: 100, winners: [0, 2] }))).toEqual([ids[1].id])
  })
  it('coop: everyone or nobody', () => {
    const two = [0, 1].map((seat) => ({ player: ids[seat].id, seat }))
    expect(validateSettlement(settlement({ app: 'skyteam', seats: two, winners: [0, 1] }), now)).toBeNull()
    expect(validateSettlement(settlement({ app: 'skyteam', seats: two, winners: [] }), now)).toBeNull()
    expect(validateSettlement(settlement({ app: 'skyteam', seats: two, winners: [0] }), now)).toBe('coop: all or none')
  })
})

/** Records posts and completes a settlement once every seat has signed. */
class FakeLedger extends Ledger {
  posts: { action: string; player: string; msg: string; sig: string }[] = []
  settled = new Map<string, { status: 'pending' | 'settled'; players: Set<string> }>()
  constructor() {
    super({ url: 'http://fake', anonKey: 'x' }, async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { action: string; player: string; msg: string; sig: string }
        this.posts.push(body)
        if (body.action === 'settle') {
          if (!verify(body.player, 'settle', body.msg, body.sig)) return json({ ok: false, error: 'bad sig' }, 400)
          const s = JSON.parse(body.msg) as Settlement
          const entry = this.settled.get(s.gameId) ?? { status: 'pending' as const, players: new Set<string>() }
          entry.players.add(body.player)
          if (entry.players.size === s.seats.length) entry.status = 'settled'
          this.settled.set(s.gameId, entry)
          return json({ ok: true, status: entry.status })
        }
        if (body.action === 'lock') return json({ ok: true, status: 'locked' })
        return json({ ok: true })
      }
      const m = url.match(/settlements\?.*game_id=eq\.([^&]+)/)
      if (m) {
        const e = this.settled.get(decodeURIComponent(m[1]))
        return json(e ? [{ game_id: m[1], status: e.status, deltas: null, attested: [...e.players] }] : [])
      }
      return json([])
    })
  }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('wallet session', () => {
  let clock = 1_000_000
  const now = () => clock
  const kv = memoryKV()
  function seat(mesh: Mesh<never>, i: number, ledger: FakeLedger, creator = false) {
    const core = new BeaconSession(tally, {
      room: 'WROOM',
      creator,
      identity: { key: ids[i].id, name: `P${i}` },
      transport: mesh.peer(`peer-${i}`),
      kv,
      now,
      timers: false,
      log: () => {},
    })
    const wallet = new WalletSession(core, 'tally', ids[i], ledger, now)
    return { core, wallet }
  }

  it('every seat signs and posts its own settlement; the ledger completes it', async () => {
    const mesh = new Mesh<never>()
    const ledger = new FakeLedger()
    // tally is not a money game; borrow splendor's rules by aliasing the app name
    const { MONEY_RULES } = await import('../src/money')
    MONEY_RULES.tally = { casual: 300, trophies: { casual: 10 }, minMoves: 6, minSeats: 2, maxSeats: 4 }
    const a = seat(mesh, 0, ledger, true)
    const b = seat(mesh, 1, ledger)
    const step = () => {
      clock += 1000
      a.core.tick()
      b.core.tick()
      mesh.flush()
    }
    step()
    step()
    a.core.setReady(true)
    b.core.setReady(true)
    mesh.flush()
    a.core.startGame()
    mesh.flush()
    for (let i = 0; i < 6; i++) {
      const actor = [a, b].find((x) => x.core.seat === x.core.state.turn)!
      actor.core.submit({ add: actor.core.seat === 0 ? 2 : 1 } as Move)
      step()
    }
    expect(a.core.state.over).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    step()
    expect(a.wallet.payout.error).toBeUndefined()
    const settles = ledger.posts.filter((p) => p.action === 'settle')
    expect(settles.map((p) => p.player).sort()).toEqual([ids[0].id, ids[1].id].sort())
    expect(settles[0].msg).toBe(settles[1].msg) // identical canonical settlement from both sides
    expect(ledger.settled.get(a.core.snapshot!.gameId)?.status).toBe('settled')
    expect(a.wallet.payout.attested.length).toBe(2) // seen through beacons too
    await new Promise((r) => setTimeout(r, 10))
    expect(['pending', 'settled']).toContain(a.wallet.payout.status)
    a.wallet.destroy()
    b.wallet.destroy()
    void ({} as State)
    void ({} as Cfg)
  })

  it('table game: locks the buy-in, then both seats sign one v2 settlement carrying payouts', async () => {
    const mesh = new Mesh<never>()
    const ledger = new FakeLedger()
    const { MONEY_RULES } = await import('../src/money')
    MONEY_RULES.tallytable = { table: { buyIns: [100] }, trophies: { bet: 20 }, minMoves: 6, minSeats: 2, maxSeats: 4 }
    const mk = (i: number, creator = false) => {
      const core = new BeaconSession(tallyTable, {
        room: 'TROOM',
        creator,
        identity: { key: ids[i].id, name: `P${i}` },
        transport: mesh.peer(`tpeer-${i}`),
        kv: memoryKV(),
        now,
        timers: false,
        log: () => {},
      })
      return { core, wallet: new WalletSession(core, 'tallytable', ids[i], ledger, now) }
    }
    const a = mk(0, true)
    const b = mk(1)
    const step = () => {
      clock += 1000
      a.core.tick()
      b.core.tick()
      mesh.flush()
    }
    step()
    step()
    a.core.setReady(true)
    b.core.setReady(true)
    mesh.flush()
    a.core.startGame()
    mesh.flush()
    expect(a.wallet.mode).toBe('bet')
    expect(a.wallet.stake).toBe(100)
    await new Promise((r) => setTimeout(r, 10))
    expect(ledger.posts.filter((p) => p.action === 'lock').map((p) => p.player).sort()).toEqual([ids[0].id, ids[1].id].sort())
    expect(a.wallet.lock.status).toBe('locked')
    for (let i = 0; i < 6; i++) {
      const actor = [a, b].find((x) => x.core.seat === x.core.state.turn)!
      actor.core.submit({ add: actor.core.seat === 0 ? 2 : 1 } as Move)
      step()
    }
    expect(a.core.state.over).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    step()
    expect(a.wallet.payout.error).toBeUndefined()
    expect(b.wallet.payout.error).toBeUndefined()
    const settles = ledger.posts.filter((p) => p.action === 'settle')
    expect(settles.length).toBe(2)
    expect(settles[0].msg).toBe(settles[1].msg)
    const s = JSON.parse(settles[0].msg) as Settlement
    expect(s.v).toBe(2)
    expect(s.mode).toBe('bet')
    expect(s.stake).toBe(100)
    expect(s.payouts).toEqual([15, -15]) // totals 6 vs 3, mean 4.5 → ±1.5 points × 10
    expect(s.winners).toEqual([0])
    expect(validateSettlement(s, now())).toBeNull()
    expect(ledger.settled.get(a.core.snapshot!.gameId)?.status).toBe('settled')
    await new Promise((r) => setTimeout(r, 10))
    // the FakeLedger reports no deltas, so finish() falls back to computeDeltas with payouts
    if (a.wallet.payout.status === 'settled') expect(a.wallet.payout.cash).toBe(115)
    if (b.wallet.payout.status === 'settled') expect(b.wallet.payout.cash).toBe(85)
    a.wallet.destroy()
    b.wallet.destroy()
  })
})
