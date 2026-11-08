/**
 * Ashfall Online basic shared-map server for itch.io and Cloudflare Workers.
 * Durable Object hibernation API, SQLite-backed on Workers Free.
 * Transports appearance, position, movement and chat only; NOT server-authoritative combat/economy.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ ok: true, game: 'Ashfall Online', multiplayer: 'presence-only', transport: 'WebSocket' }, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      });
    }
    if (url.pathname !== '/ws' || (request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('Not found', { status: 404 });
    }
    const room = url.searchParams.get('room') || '';
    if (!/^(?:lobby|s[1-4]-[a-z0-9_.-]{1,30})$/.test(room)) {
      return new Response('Bad room', { status: 400 });
    }
    const stub = env.ASHFALL_ROOMS.get(env.ASHFALL_ROOMS.idFromName(room));
    return stub.fetch(request);
  },
};

const limitText = (v, n) => String(v ?? '').slice(0, n).replace(/[\u0000-\u001f\u007f]/g, '');
const bound = (v, min, max, otherwise = 0) => Number.isFinite(+v) ? Math.max(min, Math.min(max, +v)) : otherwise;

function safePresence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const p = {
    n: limitText(raw.n, 14),
    lv: Math.trunc(bound(raw.lv, 0, 200)),
    c: limitText(raw.c, 30),
  };
  if ('srv' in raw) {
    p.srv = /^(s1|s2|s3|s4)$/.test(raw.srv) ? raw.srv : 's1';
    p.map = limitText(raw.map, 30);
  }
  if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
    p.x = bound(raw.x, -100000, 100000);
    p.y = bound(raw.y, -100000, 100000);
    p.fx = raw.fx < 0 ? -1 : 1;
    p.fy = bound(raw.fy, -1, 1);
    p.mv = raw.mv ? 1 : 0;
    p.dead = raw.dead ? 1 : 0;
    p.hp = Math.round(bound(raw.hp, 0, 100, 100));
    p.say = limitText(raw.say, 80);
    p.sid = bound(raw.sid, 0, 9e15);
    if (Array.isArray(raw.w) && raw.w.length === 4) {
      p.w = [Math.trunc(bound(raw.w[0], 0, 100)), limitText(raw.w[1], 9), limitText(raw.w[2], 9), Math.trunc(bound(raw.w[3], 0, 100))];
    }
  }
  return p;
}

export class AshfallRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    // Example-room limit. For more than ~50 players per map, implement interest management and batching.
    const existing = this.ctx.getWebSockets();
    if (existing.length >= 50) return new Response('Map is full', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const id = crypto.randomUUID();
    server.serializeAttachment({ id, presence: {}, last: 0 });
    const peers = existing.map(ws => {
      const s = ws.deserializeAttachment();
      return s && s.id ? { id: s.id, p: s.presence || {} } : null;
    }).filter(Boolean);
    server.send(JSON.stringify({ t: 'hello', id, peers }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 2048) return;
    let q;
    try { q = JSON.parse(message); } catch { return; }
    if (!q || q.t !== 'p') return;
    const old = ws.deserializeAttachment() || {};
    const now = Date.now();
    // Max ~15 state updates/s/peer. Close-up demos work fine at 10/s.
    if (now - (old.last || 0) < 65) return;
    const p = safePresence(q.p);
    ws.serializeAttachment({ id: old.id, presence: p, last: now });
    this.broadcast({ t: 'p', id: old.id, p }, ws);
  }

  broadcast(obj, except) {
    const message = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(message); } catch { /* socket has closed */ }
    }
  }

  webSocketClose(ws) {
    const info = ws.deserializeAttachment();
    if (info && info.id) this.broadcast({ t: 'left', id: info.id }, ws);
    try { ws.close(1000, 'closed'); } catch {}
  }

  webSocketError(ws) {
    const info = ws.deserializeAttachment();
    if (info && info.id) this.broadcast({ t: 'left', id: info.id }, ws);
    try { ws.close(1011, 'error'); } catch {}
  }
}
