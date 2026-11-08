/**
 * Ashfall Online basic shared-map server for itch.io and Cloudflare Workers.
 * Durable Object hibernation API, SQLite-backed on Workers Free.
 * Transports appearance, position, movement and chat only; NOT server-authoritative combat/economy.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname === '/api/guild') return new Response(null,{status:204,headers:corsHeaders});
    if (url.pathname === '/api/guild') return env.ASHFALL_ROOMS.get(env.ASHFALL_ROOMS.idFromName('guild-registry-v1')).fetch(request);
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ ok: true, game: 'Ashfall Online', multiplayer: 'presence-guilds-basic-duels', transport: 'WebSocket' }, {
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

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
const api = (data,status=200)=>Response.json(data,{status,headers:corsHeaders});
const limitText = (v, n) => String(v ?? '').slice(0, n).replace(/[\u0000-\u001f\u007f]/g, '');
const bound = (v, min, max, otherwise = 0) => Number.isFinite(+v) ? Math.max(min, Math.min(max, +v)) : otherwise;

function safePresence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const p = {
    n: limitText(raw.n, 14),
    lv: Math.trunc(bound(raw.lv, 0, 200)),
    c: limitText(raw.c, 30),
    g: /^[A-Z0-9]{2,6}$/.test(String(raw.g||''))?String(raw.g):'',
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
    this.requests = new Map();
    this.duels = new Map();
  }

  async fetch(request) {
    if (new URL(request.url).pathname === '/api/guild') return this.guildRequest(request);
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
    if (!q || typeof q !== 'object') return;
    if (q.t==='duel') { this.duelMessage(ws,q); return; }
    if (q.t !== 'p') return;
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

  sendTo(id, packet) {
    for (const ws of this.ctx.getWebSockets()) if ((ws.deserializeAttachment()||{}).id===id) {
      try { ws.send(JSON.stringify(packet)); return true; } catch { return false; }
    }
    return false;
  }
  peerNear(a,b,limit) {
    const get=id=>{for(const ws of this.ctx.getWebSockets()){const st=ws.deserializeAttachment();if(st&&st.id===id)return st.presence;}return null;};
    const A=get(a),B=get(b);
    return !!(A&&B&&Number.isFinite(A.x)&&Number.isFinite(A.y)&&Number.isFinite(B.x)&&Number.isFinite(B.y)&&Math.hypot(A.x-B.x,A.y-B.y)<=limit);
  }
  endDuel(fight,winner,reason) {
    this.duels.delete(fight.a);this.duels.delete(fight.b);
    for (const id of [fight.a,fight.b])this.sendTo(id,{t:'duel',kind:'end',winner,reason});
  }
  duelMessage(ws,q) {
    const sender=(ws.deserializeAttachment()||{}).id;if(!sender)return;
    const kind=String(q.kind||'').slice(0,20),target=String(q.target||'').slice(0,65),now=Date.now();
    if(kind==='challenge'){
      if(!target||target===sender||!this.peerNear(sender,target,20)||this.duels.has(sender))return;
      this.requests.set(target,{from:sender,t:now});
      this.sendTo(target,{t:'duel',kind:'challenge',from:sender});return;
    }
    if(kind==='accept'||kind==='decline'){
      const req=this.requests.get(sender);if(!req||req.from!==target||now-req.t>30000)return;
      this.requests.delete(sender);
      if(kind==='decline'){this.sendTo(target,{t:'duel',kind:'decline',from:sender});return;}
      if(this.duels.has(target)||this.duels.has(sender)||!this.peerNear(sender,target,20))return;
      const fight={a:target,b:sender,hp:{[sender]:100,[target]:100},last:{}};
      this.duels.set(target,fight);this.duels.set(sender,fight);
      this.sendTo(target,{t:'duel',kind:'start',with:sender,hp:fight.hp});
      this.sendTo(sender,{t:'duel',kind:'start',with:target,hp:fight.hp});return;
    }
    const fight=this.duels.get(sender);if(!fight)return;
    const other=fight.a===sender?fight.b:fight.a;
    if(kind==='forfeit'){this.endDuel(fight,other,'forfeit');return;}
    if(kind!=='attack'||now-(fight.last[sender]||0)<520||!this.peerNear(sender,other,4.5))return;
    fight.last[sender]=now;fight.hp[other]=Math.max(0,fight.hp[other]-10);
    for (const id of [fight.a,fight.b])this.sendTo(id,{t:'duel',kind:'hit',by:sender,hp:fight.hp});
    if(fight.hp[other]===0)this.endDuel(fight,sender,'ko');
  }
  async guildRequest(request) {
    if(request.method==='GET'){
      const all=await this.ctx.storage.list({prefix:'guild:'});
      return api({ok:true,guilds:[...all.values()].map(g=>({id:g.id,name:g.name,tag:g.tag,count:g.members.length,leader:g.members[0]?.name||'-'})).sort((a,b)=>b.count-a.count)});
    }
    if(request.method!=='POST')return api({ok:false,error:'Method not allowed'},405);
    const body=await request.text();if(body.length>4096)return api({ok:false,error:'Too large'},413);
    let b;try{b=JSON.parse(body);}catch{return api({ok:false,error:'Invalid JSON'},400);}
    const token=String(b.token||'');if(!/^[0-9a-f-]{36}$/.test(token))return api({ok:false,error:'Invalid player token'},400);
    const name=limitText(b.name||'ผู้เล่น',14).trim()||'ผู้เล่น',cls=limitText(b.cls,30),lv=Math.trunc(bound(b.lv,1,200,1));
    const all=await this.ctx.storage.list({prefix:'guild:'});
    let own=null,member=null;
    for(const g of all.values()){const m=g.members.find(m=>m.token===token);if(m){own=g;member=m;break;}}
    const pub=g=>g?({id:g.id,name:g.name,tag:g.tag,leaderId:g.members[0]?.id||null,members:g.members.map(m=>({id:m.id,name:m.name,cls:m.cls,lv:m.lv}))}):null;
    const respond=async()=>{const latest=await this.ctx.storage.list({prefix:'guild:'});return api({ok:true,meId:member?.id||null,guild:pub(own),guilds:[...latest.values()].map(g=>({id:g.id,name:g.name,tag:g.tag,count:g.members.length,leader:g.members[0]?.name||'-'})).sort((a,b)=>b.count-a.count)});};
    if(b.op==='me'||b.op==='list')return respond();
    if(b.op==='create'){
      if(own)return api({ok:false,error:'กรุณาออกจากกิลด์เดิมก่อน'},409);
      const n=limitText(b.guildName,24).trim(),tag=limitText(b.tag,6).trim().toUpperCase();
      if(n.length<3||!/^[A-Z0-9]{2,6}$/.test(tag))return api({ok:false,error:'กรอกชื่อกิลด์ 3–24 ตัวอักษร และแท็ก 2–6 ตัว A-Z/0-9'},400);
      if(all.size>=200||[...all.values()].some(g=>g.name.toLowerCase()===n.toLowerCase()||g.tag===tag))return api({ok:false,error:'ชื่อหรือแท็กซ้ำ หรือเซิร์ฟเวอร์เต็ม'},409);
      const player={token,id:crypto.randomUUID(),name,cls,lv};own={id:crypto.randomUUID(),name:n,tag,members:[player]};member=player;
      await this.ctx.storage.put('guild:'+own.id,own);return respond();
    }
    if(b.op==='join'){
      if(own)return api({ok:false,error:'ต้องออกจากกิลด์เดิมก่อน'},409);
      const g=all.get('guild:'+String(b.id||''));if(!g)return api({ok:false,error:'ไม่พบกิลด์'},404);
      if(g.members.length>=50)return api({ok:false,error:'กิลด์เต็ม'},409);
      const player={token,id:crypto.randomUUID(),name,cls,lv};g.members.push(player);
      await this.ctx.storage.put('guild:'+g.id,g);own=g;member=player;return respond();
    }
    if(b.op==='leave'){
      if(!own)return respond();
      own.members=own.members.filter(m=>m.token!==token);
      if(own.members.length)await this.ctx.storage.put('guild:'+own.id,own);
      else await this.ctx.storage.delete('guild:'+own.id);
      own=null;member=null;return respond();
    }
    if(b.op==='kick'){
      if(!own||own.members[0]?.token!==token)return api({ok:false,error:'เฉพาะหัวหน้ากิลด์เท่านั้น'},403);
      const id=String(b.id||'');if(id===member.id)return api({ok:false,error:'ใช้ปุ่มออกจากกิลด์'},400);
      own.members=own.members.filter(m=>m.id!==id);
      await this.ctx.storage.put('guild:'+own.id,own);return respond();
    }
    return api({ok:false,error:'Unknown operation'},400);
  }
  webSocketClose(ws) {
    const info = ws.deserializeAttachment();
    const fight=info&&this.duels.get(info.id);
    if(fight)this.endDuel(fight,fight.a===info.id?fight.b:fight.a,'disconnect');
    if (info && info.id) this.broadcast({ t: 'left', id: info.id }, ws);
    try { ws.close(1000, 'closed'); } catch {}
  }

  webSocketError(ws) {
    const info = ws.deserializeAttachment();
    const fight=info&&this.duels.get(info.id);
    if(fight)this.endDuel(fight,fight.a===info.id?fight.b:fight.a,'disconnect');
    if (info && info.id) this.broadcast({ t: 'left', id: info.id }, ws);
    try { ws.close(1011, 'error'); } catch {}
  }
}
