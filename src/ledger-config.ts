/**
 * The hosted ledger (Supabase project). The anon key is public by design —
 * it only grants what row-level security allows (read-only views). Set to
 * null to run the games with the wallet features hidden.
 */
export interface LedgerConfig {
  url: string
  anonKey: string
}

export const LEDGER: LedgerConfig | null = null
