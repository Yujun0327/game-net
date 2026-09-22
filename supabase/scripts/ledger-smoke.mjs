/**
 * Exercise a deployed ledger end to end with throwaway identities.
 *
 *   node supabase/scripts/ledger-smoke.mjs --url=https://<ref>.supabase.co --key=<anon key>
 *
 * hello → claim (twice) → a 2-seat casual settlement signed by both seats →
 * rejected cases (bad signature, replay with a different result, short game)
 * → a 3-seat gostop table (lock ×3, settle ×3 with payouts).
 *
 * Fresh identities have 1,000 cash and are seconds old, while a table buy-in
 * is 5,000 and losers must be a day old, so the table part needs
 * `--prepare`: it tops up and backdates the three table identities through
 * `npx supabase db query --linked` (the project must be linked). Without it
 * the table part runs anyway and shows the 'insufficient' / void path.
 *
 * Clean up afterwards with `npx supabase db query --linked --file supabase/scripts/smoke-clean.sql`.
 */
import { execFileSync } from 'node:child_process'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { canonicalize, signedBytes } from '../../src/canonical.ts'

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m))
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? '').split('=')[1]
const URL = arg('url'), KEY = arg('key')
if (!URL || !KEY) throw new Error('need --url and --key')

const b64 = (b) => Buffer.from(b).toString('base64url')
const mk = () => { const seed = ed.utils.randomPrivateKey(); return { seed, id: b64(ed.getPublicKey(seed)) } }
const sign = (who, domain, msg) => b64(ed.sign(signedBytes(domain, msg), who.seed))
async function post(action, who, msg, sig = sign(who, action, msg)) {
  const res = await fetch(`${URL}/functions/v1/ledger`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, player: who.id, ts: Date.now(), msg, sig }),
  })
  return { http: res.status, ...(await res.json()) }
}
const show = (label, r) => console.log(label.padEnd(34), r.http, r.status ?? '', r.balance ?? '', r.error ?? '')
const PREPARE = process.argv.includes('--prepare')
const dbQuery = (sql) => execFileSync('npx', ['supabase', 'db', 'query', '--linked', sql], { stdio: ['ignore', 'pipe', 'inherit'] }).toString()

const a = mk(), b = mk()
show('hello A', await post('hello', a, canonicalize({ name: 'Smoke A', ts: Date.now() })))
show('hello B', await post('hello', b, canonicalize({ name: 'Smoke B', ts: Date.now() })))
show('claim A', await post('claim', a, canonicalize({ ts: Date.now() })))
show('claim A again (already)', await post('claim', a, canonicalize({ ts: Date.now() })))

const settlement = {
  v: 1, gameId: `SMOKE-${Math.random().toString(36).slice(2, 10)}`, app: 'toybattle', mode: 'casual', stake: 0,
  createdAt: Date.now() - 60_000, logLen: 20, finalHash: 'abc',
  seats: [{ player: a.id, seat: 0 }, { player: b.id, seat: 1 }], winners: [0],
}
const msg = canonicalize(settlement)
show('settle by A (pending)', await post('settle', a, msg))
show('settle by A again (idempotent)', await post('settle', a, msg))
show('settle by B (settled)', await post('settle', b, msg))
show('A profile after win', await post('hello', a, canonicalize({ name: 'Smoke A', ts: Date.now() })))
show('bad signature', await post('settle', b, msg, sign(a, 'settle', msg)))
show('same game, other winner', await post('settle', b, canonicalize({ ...settlement, winners: [1] })))
show('too short', await post('settle', a, canonicalize({ ...settlement, gameId: settlement.gameId + 'x', logLen: 2 })))
console.log('\nExpected: 200 ok / claimed / already / pending / pending / settled / balance +300, then 401, 409, 400.')

// ---------------------------------------------------------------- 3-seat table (gostop)
console.log('\n-- table settlement (gostop, 3 seats, buy-in 5000, payouts +3000 / -1000 / -2000)')
const t = [mk(), mk(), mk()]
const names = ['Smoke T0', 'Smoke T1', 'Smoke T2']
for (let i = 0; i < 3; i++) show(`hello T${i}`, await post('hello', t[i], canonicalize({ name: names[i], ts: Date.now() })))
if (PREPARE) {
  const ids = t.map((x) => `'${x.id}'`).join(',')
  dbQuery(`update players set balance = balance + 10000, created_at = now() - interval '2 days' where id in (${ids})`)
  console.log('prepared: +10000 cash, accounts backdated 2 days')
}
const before = []
for (let i = 0; i < 3; i++) before[i] = (await post('hello', t[i], canonicalize({ name: names[i], ts: Date.now() }))).balance
console.log('balances before lock'.padEnd(34), before.join(' / '))
const gameId = `SMOKE-T-${Math.random().toString(36).slice(2, 10)}`
const lockMsg = canonicalize({ v: 1, gameId, app: 'gostop', stake: 5000, players: t.map((x) => x.id).sort() })
const afterLock = []
for (let i = 0; i < 3; i++) {
  const r = await post('lock', t[i], lockMsg)
  show(`lock T${i}`, r)
  afterLock[i] = r.balance
}
const tableSettlement = {
  v: 2, gameId, app: 'gostop', mode: 'bet', stake: 5000,
  createdAt: Date.now() - 60_000, logLen: 12, finalHash: 'tbl',
  seats: t.map((x, seat) => ({ player: x.id, seat })), winners: [0], payouts: [3000, -1000, -2000],
}
const tmsg = canonicalize(tableSettlement)
show('table: not zero-sum (400)', await post('settle', t[0], canonicalize({ ...tableSettlement, payouts: [3000, -1000, -1000] })))
for (let i = 0; i < 3; i++) show(`settle T${i}`, await post('settle', t[i], tmsg))
// the first two replies were 'pending' (balance still escrowed): read every balance after the last signature
const after = []
for (let i = 0; i < 3; i++) after[i] = (await post('hello', t[i], canonicalize({ name: names[i], ts: Date.now() }))).balance
console.log('balances after lock'.padEnd(34), afterLock.join(' / '))
console.log('balances after settle'.padEnd(34), after.join(' / '))
const moved = after.map((b, i) => (b ?? 0) - (afterLock[i] ?? 0))
console.log('delta vs after-lock'.padEnd(34), moved.join(' / '), '(expected 8000 / 4000 / 3000 = stake back + payout)')
const net = after.map((b, i) => (b ?? 0) - (before[i] ?? 0))
console.log('delta vs before-lock'.padEnd(34), net.join(' / '), '(expected 3000 / -1000 / -2000)')
const ok = PREPARE && moved.join() === '8000,4000,3000' && net.join() === '3000,-1000,-2000'
console.log(PREPARE ? (ok ? 'PASS  table settlement moved the cash as specified' : 'FAIL  table settlement') : 'note: run with --prepare to fund the table seats')
if (PREPARE && !ok) process.exitCode = 1
