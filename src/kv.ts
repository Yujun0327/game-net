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
