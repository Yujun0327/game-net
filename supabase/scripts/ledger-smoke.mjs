/**
 * Exercise a deployed ledger end to end with throwaway identities.
 *
 *   node supabase/scripts/ledger-smoke.mjs --url=https://<ref>.supabase.co --key=<anon key>
 *
 * hello → claim (twice) → a 2-seat casual settlement signed by both seats →
 * rejected cases (bad signature, replay with a different result, short game).
 */
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
