import { localKV, type KV } from './kv'
export { localKV, memoryKV } from './kv'
export type { KV } from './kv'
import { loadIdentity, loadPlatformName, savePlatformName } from './identity'

/**
 * Persistent identity per browser: the platform-wide Ed25519 public key
 * (see identity.ts), shared by every game on the origin. Reconnecting with
 * the same key reclaims the same seat whatever the new tab/connection is.
 */
export function playerKey(app: string, kv: KV = localKV): string {
  void app
  return loadIdentity(kv).id
}

/** Platform name first; a name saved by an older build of this game is the fallback. */
export function loadPlayerName(app: string, kv: KV = localKV): string {
  return loadPlatformName(kv) || (kv.get(`${app}:player-name`) ?? '')
}

export function savePlayerName(app: string, name: string, kv: KV = localKV): void {
  void app
  savePlatformName(name, kv)
}
