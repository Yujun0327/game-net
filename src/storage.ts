/** Minimal key/value store; the default wraps localStorage and never throws. */
export interface KV {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export const localKV: KV = {
  get(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* storage full or blocked — refresh-resume just won't work */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  },
}

export const memoryKV = (): KV => {
  const m = new Map<string, string>()
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  }
}

/**
 * Persistent identity per browser: reconnecting with the same key reclaims
 * the same seat whatever the new tab/connection is.
 */
export function playerKey(app: string, kv: KV = localKV): string {
  const k = `${app}:player-key`
  let key = kv.get(k)
  if (!key) {
    key = crypto.randomUUID()
    kv.set(k, key)
  }
  return key
}

export function loadPlayerName(app: string, kv: KV = localKV): string {
  return kv.get(`${app}:player-name`) ?? ''
}

export function savePlayerName(app: string, name: string, kv: KV = localKV): void {
  kv.set(`${app}:player-name`, name)
}
