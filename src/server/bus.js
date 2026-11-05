/**
 * A tiny pub/sub hub. Everything the office wants the browser to know about
 * (agent status changes, streamed assistant text, approvals, messages) is
 * published here, and each connected SSE client gets a copy.
 */
import { EventEmitter } from 'node:events';

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.clients = new Set();
    this.seq = 0;
  }

  /** Register an SSE response stream. Returns an unsubscribe function. */
  addClient(res) {
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  /**
   * Broadcast an event to every connected browser.
   * @param {string} type  e.g. 'agent.status', 'agent.activity', 'approval.new'
   * @param {object} data
   */
  emitEvent(type, data) {
    const payload = { type, data, seq: ++this.seq, at: Date.now() };
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
    this.emit(type, data);
    this.emit('*', payload);
  }
}

export const bus = new Bus();
