/**
 * The hosted ledger (Supabase project). The anon key is public by design —
 * it only grants what row-level security allows (read-only views). Set to
 * null to run the games with the wallet features hidden.
 */
export interface LedgerConfig {
  url: string
  anonKey: string
}

export const LEDGER: LedgerConfig | null = {
  url: 'https://rcwudjlufgkkcdkolfdp.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjd3Vkamx1Zmdra2Nka29sZmRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MDY4NTYsImV4cCI6MjEwNTM4Mjg1Nn0.wAhiz4oYgPAUKYtmxRz1uhVlhznHCKHMSTTxXj6t5W0',
}
