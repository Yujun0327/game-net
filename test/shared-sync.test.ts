import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('edge function shared modules', () => {
  it('match the client sources (run `node scripts/sync-shared.mjs` after editing)', () => {
    for (const f of ['canonical.ts', 'money.ts']) {
      expect(readFileSync(`supabase/functions/_shared/${f}`, 'utf8')).toBe(readFileSync(`src/${f}`, 'utf8'))
    }
  })
})
