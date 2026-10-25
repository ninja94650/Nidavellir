'use strict';

const ALLOWED_DEBUG_METHODS = new Set([
  'Runtime.enable', 'Debugger.enable', 'Debugger.resume', 'Debugger.pause',
  'Debugger.stepOver', 'Debugger.stepInto', 'Debugger.stepOut',
  'Debugger.setBreakpointByUrl', 'Debugger.removeBreakpoint',
  'Debugger.evaluateOnCallFrame', 'Runtime.getProperties'
]);
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

function normalizeBreakpointLines(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Breakpoints must be an array of up to 200 line numbers.');
  const unique = new Set();
  for (const line of value) {
    if (!Number.isInteger(line) || line < 1 || line > 1000000) throw new Error('Breakpoint lines must be positive integers.');
    unique.add(line);
  }
  return [...unique].sort((a,b) => a-b);
}

class NodeInspectorClient {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async connect(address) {
    let parsed;
    try { parsed = new URL(address); } catch { throw new Error('Node Inspector returned an invalid WebSocket URL.'); }
    if (parsed.protocol !== 'ws:' || !['127.0.0.1','localhost','::1'].includes(parsed.hostname)) {
      throw new Error('For safety, the debugger only connects to a localhost Node Inspector endpoint.');
    }
    if (typeof globalThis.WebSocket !== 'function') {
      throw new Error('This Electron runtime does not expose WebSocket. In-app debugging is unavailable; update to a supported runtime.');
    }
    const socket = new globalThis.WebSocket(parsed.href);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to the Node Inspector.')), 10000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Could not connect to the Node Inspector WebSocket.')); };
      socket.onclose = () => {
        if (!this.closed) this._failPending(new Error('Node Inspector connection closed.'));
      };
      socket.onmessage = event => this._handleMessage(event.data);
    }).catch(error => {
      this.close();
      throw error;
    });
    return { connected: true };
  }

  async send(method, params = {}, timeoutMs = 8000) {
    if (!ALLOWED_DEBUG_METHODS.has(method)) throw new Error('Debugger command is not allowed.');
    if (!this.socket || this.socket.readyState !== globalThis.WebSocket.OPEN || this.closed) throw new Error('Debugger is not connected.');
    const id = this.nextId++;
    const body = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('Debugger message exceeds the size limit.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Debugger command timed out: ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(body); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _handleMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message && Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || pending.method + ' failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (message && typeof message.method === 'string') {
      try { this.onEvent(message); } catch {}
    }
  }

  _failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._failPending(new Error('Debugger stopped.'));
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
  }
}

module.exports = { NodeInspectorClient, ALLOWED_DEBUG_METHODS, normalizeBreakpointLines };
