import { canonicalize } from './canonical'
import { sign, type Identity } from './identity'
import type { Delta } from './money'
import { LEDGER, type LedgerConfig } from './ledger-config'

export interface Profile {
  id: string
  name: string
  balance: number
  trophies: number
}

export interface LeaderRow extends Profile {
  rank: number
}

export type SettlementStatus = 'pending' | 'settled' | 'void'

export interface SettlementView {
  gameId: string
  status: SettlementStatus
  deltas: Delta[] | null
  attested: string[]
}

export interface LedgerReply {
  ok: boolean
  status?: string
  balance?: number
  trophies?: number
  /** Ms since epoch on the server, so the UI can explain a skewed clock. */
  serverTime?: number
  nextClaimAt?: number
  error?: string
}

/** Client for the hosted ledger: signed writes through the Edge Function, reads through REST. */
export class Ledger {
  constructor(
    readonly cfg: LedgerConfig,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private get rest() {
    return `${this.cfg.url}/rest/v1`
  }

  private get fn() {
    return `${this.cfg.url}/functions/v1/ledger`
  }

  private headers(): Record<string, string> {
    return { apikey: this.cfg.anonKey, Authorization: `Bearer ${this.cfg.anonKey}`, 'Content-Type': 'application/json' }
  }

  private async post(action: string, id: Identity, msg: string, sig: string): Promise<LedgerReply> {
    const res = await this.fetchImpl(this.fn, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ action, player: id.id, ts: Date.now(), msg, sig }),
    })
    const body = (await res.json().catch(() => ({}))) as LedgerReply
    return { ...body, ok: res.ok && body.ok !== false }
  }

  /** Register or rename; returns the profile. */
  hello(id: Identity, name: string): Promise<LedgerReply> {
    const msg = canonicalize({ name: name.trim().slice(0, 32), ts: Date.now() })
    return this.post('hello', id, msg, sign(id, 'hello', msg))
  }

  claimDaily(id: Identity): Promise<LedgerReply> {
    const msg = canonicalize({ ts: Date.now() })
    return this.post('claim', id, msg, sign(id, 'claim', msg))
  }

  lock(id: Identity, msg: string, sig: string): Promise<LedgerReply> {
    return this.post('lock', id, msg, sig)
  }

  settle(id: Identity, msg: string, sig: string): Promise<LedgerReply> {
    return this.post('settle', id, msg, sig)
  }

  async readPlayer(playerId: string): Promise<Profile | null> {
    const rows = await this.get<Profile[]>(`players?select=id,name,balance,trophies&id=eq.${encodeURIComponent(playerId)}`)
    return rows?.[0] ?? null
  }

  async readLeaderboard(limit = 20): Promise<LeaderRow[]> {
    return (await this.get<LeaderRow[]>(`leaderboard?select=rank,id,name,trophies,balance&order=rank.asc&limit=${limit}`)) ?? []
  }

  async readRank(playerId: string): Promise<LeaderRow | null> {
    const rows = await this.get<LeaderRow[]>(`leaderboard?select=rank,id,name,trophies,balance&id=eq.${encodeURIComponent(playerId)}`)
    return rows?.[0] ?? null
  }

  async readSettlement(gameId: string): Promise<SettlementView | null> {
    const rows = await this.get<{ game_id: string; status: SettlementStatus; deltas: Delta[] | null; attested: string[] }[]>(
      `settlements?select=game_id,status,deltas,attested&game_id=eq.${encodeURIComponent(gameId)}`,
    )
    const r = rows?.[0]
    return r ? { gameId: r.game_id, status: r.status, deltas: r.deltas, attested: r.attested ?? [] } : null
  }

  private async get<T>(path: string): Promise<T | null> {
    try {
      const res = await this.fetchImpl(`${this.rest}/${path}`, { headers: this.headers() })
      if (!res.ok) return null
      return (await res.json()) as T
    } catch {
      return null
    }
  }
}

/** The configured ledger, or null when this build has no wallet. */
export function defaultLedger(): Ledger | null {
  return LEDGER ? new Ledger(LEDGER) : null
}
