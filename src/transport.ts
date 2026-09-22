import mqtt, { type MqttClient } from 'mqtt'

/**
 * A lossy, low-rate broadcast channel. That is all the beacon protocol
 * needs: no P2P, no addressing, no delivery guarantees. Every message goes
 * to everyone in the room (including, after echo filtering, nobody twice).
 */
export interface Transport<M = unknown> {
  send(msg: M): void
  onMessage(fn: (msg: M) => void): void
  /** A channel (broker connection) came up — a good moment to re-announce. */
  onUp(fn: (channel: string) => void): void
  close(): void
  /** Number of currently-open channels. */
  channelCount(): number
  /** Every channel with its current state, for diagnostics screens. */
  channels(): { url: string; up: boolean }[]
  /** Nudge any dropped channels to reconnect right now. */
  wake(): void
}

export type Broker = string | { url: string; username?: string; password?: string }

/**
 * Public brokers, used as fallbacks. Shared with the whole internet, so
 * they throttle and go down for maintenance — put a broker you own first
 * (see `brokersFromEnv`).
 */
export const DEFAULT_BROKERS: Broker[] = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081',
]

/**
 * Build the broker list from Vite-style env vars: VITE_MQTT_URL (+ optional
 * VITE_MQTT_USERNAME / VITE_MQTT_PASSWORD) is placed first, public brokers
 * follow as fallbacks. Credentials shipped in a static site are public by
 * nature — only use a broker whose credentials you are happy to expose.
 */
export function brokersFromEnv(env: Record<string, string | undefined>): Broker[] {
  const url = env.VITE_MQTT_URL?.trim()
  if (!url) return DEFAULT_BROKERS
  const own: Broker = { url, username: env.VITE_MQTT_USERNAME, password: env.VITE_MQTT_PASSWORD }
  return [own, ...DEFAULT_BROKERS]
}

export interface MqttOptions {
  /** Topic namespace, e.g. 'splendor'. */
  app: string
  /** Wire protocol version — part of the topic so incompatible builds never meet. */
  protocol: number
  room: string
  brokers?: Broker[]
  log?: (text: string) => void
  /** Warn above this payload size (public brokers cap around 64–256 KB). */
  maxBytes?: number
}

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Broadcast transport over MQTT (plain WebSocket pub/sub). Every message is
 * published to ALL brokers and received on all of them: any single live
 * broker suffices, duplicates are dropped here (same payload within 3s),
 * and mqtt.js's keepalive + auto-reconnect handle stale sockets.
 *
 * Privacy: topics on public brokers are world-readable. Send only what
 * every player may see.
 */
export function connectMqtt<M = unknown>(opts: MqttOptions): Transport<M> {
  const brokers = opts.brokers ?? DEFAULT_BROKERS
  const log = opts.log ?? (() => {})
  const topic = `${opts.app}/v${opts.protocol}/${opts.room.toUpperCase()}`
  const tag = randHex(6) // per-instance: filters our own echoes
  const maxBytes = opts.maxBytes ?? 60_000

  const messageHandlers: ((msg: M) => void)[] = []
  const upHandlers: ((channel: string) => void)[] = []

  const seen = new Map<string, number>()
  const isDuplicate = (payload: string): boolean => {
    const now = Date.now()
    if (seen.size > 64) for (const [k, t] of seen) if (now - t > 3000) seen.delete(k)
    const t = seen.get(payload)
    seen.set(payload, now)
    return t !== undefined && now - t < 3000
  }

  const clients: MqttClient[] = brokers.map((b, i) => {
    const spec = typeof b === 'string' ? { url: b } : b
    const client = mqtt.connect(spec.url, {
      // random per-connection id — public brokers kick duplicate client ids
      clientId: `${opts.app}_${tag}_${i}_${randHex(3)}`,
      username: spec.username,
      password: spec.password,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 2000,
      connectTimeout: 10_000,
      protocolVersion: 4,
      resubscribe: true,
    })
    client.on('connect', () => {
      client.subscribe(topic, { qos: 0 })
      log(`broker up: ${spec.url}`)
      for (const fn of upHandlers) fn(spec.url)
    })
    client.on('close', () => log(`broker down: ${spec.url}`))
    client.on('error', (err) => log(`broker error ${spec.url}: ${err.message}`))
    client.on('message', (t, payload) => {
      if (t !== topic) return
      const text = payload.toString()
      try {
        const env = JSON.parse(text) as { s: string; m: M }
        if (env.s === tag || env.m === undefined) return
        if (isDuplicate(text)) return
        for (const fn of messageHandlers) fn(env.m)
      } catch {
        /* foreign/garbled payload on a public topic — ignore */
      }
    })
    return client
  })

  return {
    send: (msg) => {
      const payload = JSON.stringify({ s: tag, m: msg })
      if (payload.length > maxBytes) log(`oversized message: ${payload.length}B`)
      for (const client of clients) if (client.connected) client.publish(topic, payload, { qos: 0 })
    },
    onMessage: (fn) => void messageHandlers.push(fn),
    onUp: (fn) => void upHandlers.push(fn),
    close: () => {
      for (const client of clients) client.end(true)
    },
    channelCount: () => clients.filter((c) => c.connected).length,
    channels: () =>
      clients.map((c, i) => {
        const b = brokers[i]
        return { url: typeof b === 'string' ? b : b.url, up: c.connected }
      }),
    wake: () => {
      for (const client of clients) {
        if (client.connected) continue
        try {
          client.reconnect()
        } catch {
          /* mid-reconnect already */
        }
      }
    },
  }
}

/** Six characters, no 0/O/1/I/L. */
export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}
