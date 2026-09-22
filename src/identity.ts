import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { signedBytes, type Domain } from './canonical'
import { localKV, type KV } from './kv'

// noble's sync API needs a sha512 implementation wired in once
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m))

export const IDENTITY_KEY = 'yujungame:identity'
export const NAME_KEY = 'yujungame:name'

/** A platform-wide player identity: one Ed25519 keypair per browser, shared by every game. */
export interface Identity {
  /** Public key, base64url — the player id everywhere (beacons, ledger, leaderboard). */
  id: string
  pub: Uint8Array
  seed: Uint8Array
}

export function toBase64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes')
  const pub = ed.getPublicKey(seed)
  return { id: toBase64url(pub), pub, seed }
}

/** Load the browser's identity, creating one on first use. */
export function loadIdentity(kv: KV = localKV): Identity {
  const stored = kv.get(IDENTITY_KEY)
  if (stored) {
    try {
      return identityFromSeed(fromBase64url(stored))
    } catch {
      /* corrupt → regenerate */
    }
  }
  const seed = ed.utils.randomPrivateKey()
  kv.set(IDENTITY_KEY, toBase64url(seed))
  return identityFromSeed(seed)
}

/** The 43-character link code that moves this identity to another device. */
export function exportSeed(id: Identity): string {
  return toBase64url(id.seed)
}

/** Adopt an identity from a link code (replaces the current one). */
export function importSeed(code: string, kv: KV = localKV): Identity {
  const id = identityFromSeed(fromBase64url(code.trim()))
  kv.set(IDENTITY_KEY, toBase64url(id.seed))
  return id
}

export function loadPlatformName(kv: KV = localKV): string {
  return kv.get(NAME_KEY) ?? ''
}

export function savePlatformName(name: string, kv: KV = localKV): void {
  kv.set(NAME_KEY, name.trim().slice(0, 32))
}

/** Sign a canonical string under a domain tag; returns base64url. */
export function sign(id: Identity, domain: Domain, canonical: string): string {
  return toBase64url(ed.sign(signedBytes(domain, canonical), id.seed))
}

export function verify(playerId: string, domain: Domain, canonical: string, sig: string): boolean {
  try {
    return ed.verify(fromBase64url(sig), signedBytes(domain, canonical), fromBase64url(playerId))
  } catch {
    return false
  }
}
