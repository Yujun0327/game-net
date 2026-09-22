import { sha256 } from '@noble/hashes/sha2.js'

/**
 * Deterministic JSON: object keys sorted, arrays in order, integers only.
 * Everyone who signs the same value must produce the same bytes, so anything
 * ambiguous (undefined, floats, NaN, functions) is rejected instead of guessed.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error(`canonicalize: non-integer number ${value}`)
      return String(value)
    case 'object':
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
      return `{${Object.keys(value as object)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
        .join(',')}}`
    default:
      throw new Error(`canonicalize: unsupported ${typeof value}`)
  }
}

export function sha256hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)))
}

export function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** Domain tags keep a signature over one kind of message from ever passing as another. */
export const DOMAIN = {
  hello: 'yujungame/hello/v1',
  claim: 'yujungame/claim/v1',
  lock: 'yujungame/lock/v1',
  settle: 'yujungame/settle/v1',
} as const

export type Domain = keyof typeof DOMAIN

export function signedBytes(domain: Domain, canonical: string): Uint8Array {
  return new TextEncoder().encode(`${DOMAIN[domain]}\n${canonical}`)
}
