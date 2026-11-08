'use strict';
/* Adapt Cloudflare WebSocket rooms to Ashfall Online's existing peer/presence rendering.
   No account or combat authentication is provided by this starter transport. */
(function () {
  const raw = String(window.ASHFALL_WS_URL || '');
  if (!/^wss:\/\/[a-z0-9.-]+(?::\d+)?(?:\/)?$/i.test(raw) || /YOUR-WORKER|YOUR-SUBDOMAIN/i.test(raw)) {
    console.warn('[Ashfall] Multiplayer is not configured. Set window.ASHFALL_WS_URL in js/net_config.js.');
    return;
  }
  const endpoint = raw.replace(/\/$/, '') + '/ws';

  class Connection {
    constructor(key) {
      this.key = key;
      this.ws = null;
      this.me = '';
      this.peersById = new Map();
      this.peerHandlers = [];
      this.connectHandlers = [];
      this.closed = false;
      this.connected = false;
      this.pending = null;
      this.retry = 750;
      this.open();
    }
    open() {
      if (this.closed) return;
      let ws;
      try { ws = new WebSocket(endpoint + '?room=' + encodeURIComponent(this.key)); }
      catch (err) { console.warn('[Ashfall] WebSocket setup error', err); this.scheduleReconnect(); return; }
      this.ws = ws;
      ws.addEventListener('open', () => {
        if (this.closed) { ws.close(); return; }
        this.connected = true; this.retry = 750;
        for (const cb of this.connectHandlers) cb(true);
        if (this.pending) this.send(this.pending);
      });
      ws.addEventListener('message', ev => {
        let q;
        try { q = JSON.parse(ev.data); } catch { return; }
        if (q.t === 'hello') {
          this.me = q.id; this.peersById.clear();
          for (const peer of q.peers || []) if (peer.id !== this.me) this.peersById.set(peer.id, peer.p || {});
          this.notify();
        } else if (q.t === 'p' && q.id && q.id !== this.me) {
          this.peersById.set(q.id, q.p || {}); this.notify();
        } else if (q.t === 'left') { this.peersById.delete(q.id); this.notify(); }
      });
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.connected = false; this.me = ''; this.peersById.clear(); this.notify();
        for (const cb of this.connectHandlers) cb(false);
        this.scheduleReconnect();
      });
      ws.addEventListener('error', () => { /* close event will reconnect */ });
    }
    scheduleReconnect() {
      if (this.closed) return;
      const delay = this.retry;
      this.retry = Math.min(this.retry * 1.5, 10000);
      setTimeout(() => this.open(), delay);
    }
    send(data) {
      const value = { t: 'p', p: data };
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify(value)); } catch {}
      }
    }
    presence(data) { this.pending = data; this.send(data); return Promise.resolve(); }
    peers() { const others = [...this.peersById.entries()].map(([peer, presence]) => ({ peer, presence, kind: 'viewer', isMe: false, guest: true })); return this.me ? [{ peer: this.me, presence: this.pending || {}, kind: 'viewer', isMe: true, guest: false }, ...others] : others; }
    notify() {
      const peers = this.peers();
      for (const cb of this.peerHandlers) { try { cb({ peers }); } catch (e) { console.error('[Ashfall] Peer handler error:', e); } }
    }
    onPeers(fn) { this.peerHandlers.push(fn); fn({ peers: this.peers() }); }
    onConnection(fn) { this.connectHandlers.push(fn); fn(this.connected); }
    leave() {
      this.closed = true; this.connected = false;
      this.peerHandlers.length = 0;
      if (this.ws) this.ws.close(1000, 'room change');
      return Promise.resolve();
    }
  }

  const lobby = new Connection('lobby');
  window.ASHFALL_NET = {
    async use(kind) {
      if (kind !== 'room') return null;
      return {
        onConnection: fn => lobby.onConnection(fn),
        onPeers: fn => lobby.onPeers(fn),
        peers: () => lobby.peers(),
        presence: data => lobby.presence(data),
        join: async key => new Connection(key),
      };
    },
  };
})();
