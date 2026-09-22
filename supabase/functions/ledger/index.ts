// yujungame ledger — the only writer of wallets and trophies.
// Every request is a signed envelope { action, player, ts, msg, sig }; the
// Ed25519 signature over `<domain>\n<msg>` proves who is speaking, and the
// SQL functions decide what happens (see ../../migrations/0001_ledger.sql).
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { createClient } from '@supabase/supabase-js'
import { canonicalize, DOMAIN, signedBytes, type Domain } from '../_shared/canonical.ts'
import { CAPS, DAILY_CASH, MONEY_RULES, computeDeltas, validateSettlement, type Settlement } from '../_shared/money.ts'

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m))

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify({ serverTime: Date.now(), ...(body as object) }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
const fail = (error: string, status = 400) => json({ ok: false, error }, status)

function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

function verify(player: string, domain: Domain, msg: string, sig: string): boolean {
  try {
    return ed.verify(fromBase64url(sig), signedBytes(domain, msg), fromBase64url(player))
  } catch {
    return false
  }
}

// cheap per-player rate cap: signature checks cost CPU and the function is public
const rate = new Map<string, { n: number; until: number }>()
function overRate(player: string): boolean {
  const now = Date.now()
  const r = rate.get(player)
  if (!r || r.until < now) {
    rate.set(player, { n: 1, until: now + 60_000 })
    return false
  }
  return ++r.n > 60
}

interface Envelope {
  action: string
  player: string
  ts: number
  msg: string
  sig: string
}

let lastSweep = 0

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return fail('POST only', 405)
  let env: Envelope
  try {
    env = (await req.json()) as Envelope
  } catch {
    return fail('bad json')
  }
  const { action, player, ts, msg, sig } = env
  if (!(action in DOMAIN)) return fail('unknown action')
  if (typeof player !== 'string' || player.length !== 43) return fail('bad player')
  if (typeof msg !== 'string' || msg.length > 16_000 || typeof sig !== 'string') return fail('bad envelope')
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300_000) return fail('clock skew: check your device time')
  if (overRate(player)) return fail('too many requests', 429)
  if (!verify(player, action as Domain, msg, sig)) return fail('bad signature', 401)

  let parsed: unknown
  try {
    parsed = JSON.parse(msg)
  } catch {
    return fail('bad msg')
  }
  if (canonicalize(parsed) !== msg) return fail('msg not canonical')

  // lazily refund stakes of games nobody finished
  if (Date.now() - lastSweep > 3_600_000) {
    lastSweep = Date.now()
    await supabase.rpc('ledger_refund_stale_escrow', { p_older_than: '7 days' })
  }

  switch (action) {
    case 'hello': {
      const { name, ts: mts } = parsed as { name: string; ts: number }
      if (typeof name !== 'string' || Math.abs(Date.now() - mts) > 300_000) return fail('bad hello')
      const { data, error } = await supabase.rpc('ledger_hello', { p_id: player, p_name: name })
      if (error) return fail(error.message, 500)
      return json({ ok: true, status: 'ok', balance: data.balance, trophies: data.trophies, name: data.name })
    }
    case 'claim': {
      const { ts: mts } = parsed as { ts: number }
      if (Math.abs(Date.now() - mts) > 300_000) return fail('bad claim')
      const { data, error } = await supabase.rpc('ledger_claim', { p_id: player, p_amount: DAILY_CASH })
      if (error) return fail(error.message, 500)
      const row = data[0]
      return json({ ok: true, status: row.status, balance: row.balance, trophies: row.trophies, nextClaimAt: nextKstMidnight() })
    }
    case 'lock': {
      const l = parsed as { v: number; gameId: string; app: string; stake: number; players: string[] }
      const rule = MONEY_RULES[l.app]
      if (l.v !== 1 || !rule || !rule.stakes?.includes(l.stake)) return fail('bad lock')
      if (!Array.isArray(l.players) || !l.players.includes(player) || new Set(l.players).size !== l.players.length) return fail('bad lock players')
      if (l.players.length < rule.minSeats || l.players.length > rule.maxSeats) return fail('bad lock seats')
      const { data, error } = await supabase.rpc('ledger_lock', {
        p_id: player,
        p_game_id: l.gameId,
        p_app: l.app,
        p_stake: l.stake,
        p_players: [...l.players].sort(),
      })
      if (error) return fail(error.message, 500)
      const row = data[0]
      return json({ ok: row.status === 'locked', status: row.status, balance: row.balance, trophies: row.trophies, error: row.status === 'locked' ? undefined : row.status })
    }
    case 'settle': {
      const s = parsed as Settlement
      const problem = validateSettlement(s, Date.now())
      if (problem) return fail(problem)
      if (!s.seats.some((x) => x.player === player)) return fail('not seated')
      const deltas = computeDeltas(s, { escrowed: true, overCap: false })
      const { data, error } = await supabase.rpc('ledger_settle', {
        p_id: player,
        p_sig: sig,
        p_settlement: s,
        p_deltas: deltas,
        p_cap_games: CAPS.rewardedGamesPerDay,
        p_cap_seat_set: CAPS.perSeatSetPerDay,
        p_loser_age: `${Math.round(CAPS.loserAccountAgeMs / 3_600_000)} hours`,
      })
      if (error) return fail(error.message, 500)
      const row = data[0]
      if (row.status === 'mismatch') return fail('settlement differs from the one already recorded', 409)
      return json({ ok: true, status: row.status, balance: row.balance, trophies: row.trophies })
    }
  }
  return fail('unreachable')
})

function nextKstMidnight(): number {
  const kst = new Date(Date.now() + 9 * 3_600_000)
  const next = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1) - 9 * 3_600_000
  return next
}
