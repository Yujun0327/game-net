// The Edge Function bundle only sees files under supabase/functions, so the
// modules it shares with the clients are copied there. Run after editing
// src/canonical.ts or src/money.ts; the test suite fails if they drift.
import { copyFileSync, mkdirSync } from 'node:fs'
mkdirSync('supabase/functions/_shared', { recursive: true })
for (const f of ['canonical.ts', 'money.ts']) copyFileSync(`src/${f}`, `supabase/functions/_shared/${f}`)
console.log('synced canonical.ts, money.ts')
