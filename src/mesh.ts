import type { Transport } from './transport'

/**
 * Deterministic in-memory broadcast standing in for MQTT: messages queue
 * centrally and deliver on flush(); a filter hook drops or observes
 * deliveries; peers can drop out to exercise reconnect flows.
 */
export class Mesh<M = unknown> {
  private peers = new Map<string, MeshPeer<M>>()
  private queue: { from: string; to: string; msg: M }[] = []
  /** Return false to drop a delivery (loss/reorder tests). */
  filter: (msg: M, from: string, to: string) => boolean = () => true

  peer(id: string): Transport<M> {
    const p = new MeshPeer<M>(this, id)
    this.peers.set(id, p)
    return p
  }

  drop(id: string): void {
    this.peers.delete(id)
    this.queue = this.queue.filter((d) => d.to !== id && d.from !== id)
  }

  enqueue(from: string, msg: M): void {
    for (const to of this.peers.keys()) if (to !== from) this.queue.push({ from, to, msg })
  }

  /** Deliver every queued message, including ones enqueued while flushing. */
  flush(): void {
    while (this.queue.length > 0) {
      const d = this.queue.shift()!
      if (!this.filter(d.msg, d.from, d.to)) continue
      this.peers.get(d.to)?.deliver(d.msg)
    }
  }
}

class MeshPeer<M> implements Transport<M> {
  private handlers: ((msg: M) => void)[] = []
  constructor(
    private mesh: Mesh<M>,
    readonly id: string,
  ) {}
  send(msg: M): void {
    // JSON round-trip like the real wire, so nothing structurally shared leaks
    this.mesh.enqueue(this.id, JSON.parse(JSON.stringify(msg)) as M)
  }
  onMessage(fn: (msg: M) => void): void {
    this.handlers.push(fn)
  }
  onUp(): void {}
  close(): void {
    this.mesh.drop(this.id)
  }
  channelCount(): number {
    return 1
  }
  channels(): { url: string; up: boolean }[] {
    return [{ url: 'mesh', up: true }]
  }
  wake(): void {}
  deliver(msg: M): void {
    for (const fn of this.handlers) fn(msg)
  }
}
