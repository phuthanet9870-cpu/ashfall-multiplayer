/**
 * Ashfall Online basic shared-map server for itch.io and Cloudflare Workers.
 * Durable Object hibernation API, SQLite-backed on Workers Free.
 * Supports shared presence, GM events, limited PvP/war and server-owned online economy.
 * Original local RPG stats/drops are NOT fully authoritative: public-production beta only.
 */
import { handleService, respond } from './service.js';
import { SKILLS } from './skills.js';
import { settleAuctions, ITEM_LABELS } from './economy.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname === '/api/guild') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (url.pathname === '/api/v2') {
      const stub=env.ASHFALL_ROOMS.get(env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
      return stub.fetch(request);
    }
    if (url.pathname === '/api/guild') {
      const stub = env.ASHFALL_ROOMS.get(env.ASHFALL_ROOMS.idFromName('guild-registry-v1'));
      return stub.fetch(request);
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ ok: true, game: 'Ashfall Online', multiplayer: 'shared-gm-market-auction-two-way-trade-ground-drops-pvp-guildwar-cloudsave-beta-v3', transport: 'WebSocket' }, {
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
const api = (body, status = 200) => Response.json(body, { status, headers: corsHeaders });
const limitText = (v, n) => String(v ?? '').slice(0, n).replace(/[\u0000-\u001f\u007f]/g, '');
const bound = (v, min, max, otherwise = 0) => Number.isFinite(+v) ? Math.max(min, Math.min(max, +v)) : otherwise;

function safePresence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const p = {
    n: limitText(raw.n, 14),
    lv: Math.trunc(bound(raw.lv, 0, 200)),
    c: limitText(raw.c, 30),
    g: /^[A-Z0-9]{2,6}$/.test(String(raw.g||'')) ? String(raw.g) : '',
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
    this.requests = new Map(); // 30-sec challenges; in-memory, ephemeral by design
    this.duels = new Map(); // online duel HP; expires if Durable Object restarts
    this.queues = new Map();
    this.match = null;
    this.war = null;
    this.boss = null;
    this.bossContributors = new Set();
    this.sharedMobs = null;
    this.lastMobTick = Date.now();
    this.skillTimes = new Map();
    this.gmMonsters = [];
    this.lastGmTick = 0;
    this.serverSettings={pvp:true,war:true,trade:true,market:true,ground:true,boss:true};
    this.pendingGlobal=[];
    this.groundDrops=[];this.pickupLocks=new Set();
    // Keep GM-summoned monsters after DO hibernation and for late joiners.
    this.ctx.blockConcurrencyWhile(async () => {
      const stored=await this.ctx.storage.get('gm-monsters-v1');
      this.gmMonsters=Array.isArray(stored)?stored.filter(m=>m&&m.expires>Date.now()&&m.hp>0).slice(0,36):[];
      const storedGround=await this.ctx.storage.get('world-ground-drops-v1');
      this.groundDrops=Array.isArray(storedGround)?storedGround.filter(d=>d.expires>Date.now()).slice(0,60):[];
      const config=await this.ctx.storage.get('mmo-global-settings-v1');
      if(config)this.serverSettings={...this.serverSettings,...config};
    });
  }

  async fetch(request) {
    const url=new URL(request.url);
    if(url.pathname==='/api/v2'||url.pathname==='/internal/economy'||url.pathname==='/internal/config')return handleService(this.ctx,request);
    if(url.pathname==='/internal/room-register')return this.registerInternalRoom(request);
    if(url.pathname==='/internal/gm-global-command')return this.globalCommandInternal(request);
    if(url.pathname==='/internal/gm-delivery')return this.deliverGlobal(request);
    if(url.pathname==='/internal/guild-verify')return this.verifyGuild(request);
    if(url.pathname==='/internal/castle')return this.recordCastle(request);
    if(url.pathname==='/internal/reward')return this.rewardAccounts(request);
    if(url.pathname==='/api/guild')return this.guildRequest(request);
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    // Example-room limit. For more than ~50 players per map, implement interest management and batching.
    const existing = this.ctx.getWebSockets();
    if (existing.length >= 50) return new Response('Map is full', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const id = crypto.randomUUID();
    const key=new URL(request.url).searchParams.get('room');
    server.serializeAttachment({ id, presence: {}, last: 0, room:key });
    this.ctx.waitUntil(this.registerWithGlobal(key).catch(()=>{}));
    const peers = existing.map(ws => {
      const s = ws.deserializeAttachment();
      return s && s.id ? { id: s.id, p: s.presence || {} } : null;
    }).filter(Boolean);
    server.send(JSON.stringify({ t: 'hello', id, peers }));
    if(this.boss)server.send(JSON.stringify({t:'world-boss',state:this.boss}));
    if(this.sharedMobs)server.send(JSON.stringify({t:'shared-mobs',mobs:this.sharedMobs}));
    server.send(JSON.stringify({t:'gm-mobs',mobs:this.gmMonsters}));
    server.send(JSON.stringify({t:'gm-settings',settings:this.serverSettings}));
    server.send(JSON.stringify({t:'ground-drops',drops:this.groundDrops}));
    if(this.war)server.send(JSON.stringify({t:'war',kind:'state',state:this.publicWar()}));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 2048) return;
    let q;
    try { q = JSON.parse(message); } catch { return; }
    if (!q || typeof q !== 'object') return;
    if(q.t==='gm-auth') { this.authorizeGM(ws,q); return; }
    if(q.t==='gm-global') { this.gmGlobal(ws,q); return; }
    if(q.t==='ground') { this.groundMessage(ws,q).catch(e=>this.sendError(ws,'ground',e?.message||'เกิดข้อผิดพลาด')); return; }
    if(q.t==='gm-spawn'||q.t==='gm-control') { this.gmCommand(ws,q); return; }
    if(q.t==='skill') { this.skillMessage(ws,q); return; }
    if(q.t==='team') { if(this.serverSettings.pvp!==false)this.teamMessage(ws,q);else this.sendError(ws,'gm','GM ปิด PvP ชั่วคราว'); return; }
    if(q.t==='war') { if(this.serverSettings.war!==false)this.warMessage(ws,q);else this.sendError(ws,'gm','GM ปิดกิลวอร์ชั่วคราว'); return; }
    if(q.t==='guild-auth') { this.authenticateGuild(ws,q).catch(()=>{}); return; }
    if(q.t==='account-auth') { this.authenticateAccount(ws,q).catch(()=>{}); return; }
    if(q.t==='account-logout') { const old=ws.deserializeAttachment()||{};delete old.account;delete old.accountToken;delete old.equipped;ws.serializeAttachment(old);return; }
    if (q.t === 'duel') { if(this.serverSettings.pvp!==false)this.duelMessage(ws, q);else this.sendError(ws,'gm','GM ปิด PvP ชั่วคราว'); return; }
    if (q.t !== 'p') return;
    const old = ws.deserializeAttachment() || {};
    const now = Date.now();
    // Max ~15 state updates/s/peer. Close-up demos work fine at 10/s.
    if (now - (old.last || 0) < 65) return;
    const p = safePresence(q.p);
    if(this.pendingGlobal?.length&&Number.isFinite(p.x)&&Number.isFinite(p.y)) {
      const pending=this.pendingGlobal.splice(0);for(const g of pending)this.applyGlobalSpawn(g);
    }
    if(old.guildTag)p.g=old.guildTag;else p.g='';
    ws.serializeAttachment({...old, presence: p, last: now });
    this.broadcast({ t: 'p', id: old.id, p }, ws);
    if(!this.boss && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      this.boss={id:crypto.randomUUID(),x:Math.round(p.x+4),y:Math.round(p.y),hp:1800,max:1800,deadUntil:0,level:25};
      this.broadcast({t:'world-boss',state:this.boss});
    }
    if(!this.sharedMobs && old.room!=='lobby' && Number.isFinite(p.x) && Number.isFinite(p.y)){
      this.sharedMobs=[
        {id:'m1',x:p.x+2,y:p.y-3,hp:260,max:260,body:'slime',deadUntil:0},
        {id:'m2',x:p.x-3,y:p.y-2,hp:290,max:290,body:'goblin',deadUntil:0},
        {id:'m3',x:p.x+4,y:p.y+2,hp:340,max:340,body:'skeleton',deadUntil:0}
      ];
      this.broadcast({t:'shared-mobs',mobs:this.sharedMobs});
    }
    this.tickSharedMobs();
    this.pruneGroundDrops();
    this.tickGmMonsters();
    if(this.match && now-this.match.started>8*60000){
      const winner=this.match.score[0]===this.match.score[1]?-1:(this.match.score[0]>this.match.score[1]?0:1);
      this.finishTeamMatch(winner);
    }
    if(this.war)this.tickWar();
    if(this.boss?.hp===0 && Date.now()>=this.boss.deadUntil){this.boss.hp=this.boss.max;this.boss.deadUntil=0;this.bossContributors.clear();this.broadcast({t:'world-boss',state:this.boss});}
  }

  broadcast(obj, except) {
    const message = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(message); } catch { /* socket has closed */ }
    }
  }

  peerInfo(id) {
    for(const sock of this.ctx.getWebSockets()) {
      const p=sock.deserializeAttachment();if(p?.id===id)return p;
    }
    return null;
  }
  skillMessage(ws,q) {
    const data=ws.deserializeAttachment()||{},id=data.id,p=data.presence||{},now=Date.now();
    if(this.serverSettings.pvp===false&&this.match)return;
    if(!id||!Number.isFinite(p.x)||!Number.isFinite(p.y))return;
    const i=Number(q.i),skills=SKILLS[p.c];if(!Number.isInteger(i)||i<0||i>=15||!skills)return;
    const skill=skills[i];if(!skill||p.lv<skill.unlock)return;
    const last=this.skillTimes.get(id+':'+i)||0;
    const cooldown=Math.max(350,Math.min(60000,(Number(skill.c)||0.5)*1000*0.7));
    if(now-last<cooldown)return;
    const x=Number(q.x),y=Number(q.y);
    if(!Number.isFinite(x)||!Number.isFinite(y)||Math.hypot(x-p.x,y-p.y)>Math.max(4,(skill.R||skill.r||3)+3))return;
    this.skillTimes.set(id+':'+i,now);
    this.broadcast({t:'skill',id,i,x,y,seq:now},ws);
    const targetId=String(q.target||'');
    const target=this.peerInfo(targetId);
    let dist=target?.presence ? Math.hypot(p.x-target.presence.x,p.y-target.presence.y) : Infinity;
    const range=Math.max(1.6,(skill.R||skill.r||2)+0.8);
    const gearBonus=data.equipped?.weapon?1.12:1;
    const damage=skill.dmg?Math.max(5,Math.min(34,Math.round((6+Number(skill.p||0)*4)*gearBonus))):0;
    if(target&&damage&&dist<=range&&this.match?.hp?.[id]!=null&&this.match.hp[targetId]!=null) {
      const match=this.match,all=match.teams.flat();
      if(all.includes(id)&&all.includes(targetId)&&match.teams.findIndex(a=>a.includes(id))!==match.teams.findIndex(a=>a.includes(targetId))) {
        const protection=target?.equipped?.armor?0.9:1;
        match.hp[targetId]=Math.max(0,match.hp[targetId]-Math.max(1,Math.round(damage*protection)));
        this.broadcast({t:'team',kind:'hit',by:id,target:targetId,hp:match.hp[targetId],damage});
        if(match.hp[targetId]===0) {
          match.score[match.teams.findIndex(a=>a.includes(id))]++;
          match.hp[targetId]=100;this.broadcast({t:'team',kind:'score',score:match.score,hp:match.hp});
          if(Math.max(...match.score)>=match.limit||Date.now()-match.started>8*60000) {
            const winner=match.score[0]>match.score[1]?0:1;
            this.finishTeamMatch(winner);
          }
        }
      }
    }
    // A real map boss shared by all players in this room; only accepted class skills damage it.
    const boss=this.serverSettings.boss===false?null:this.boss;
    if(boss?.hp>0&&damage&&Math.hypot(x-boss.x,y-boss.y)<2.6) {
      if(Math.hypot(p.x-boss.x,p.y-boss.y)<=range+2) {
        boss.hp=Math.max(0,boss.hp-Math.max(10,damage*2));
        if(data.account)this.bossContributors.add(data.account);
        if(!boss.hp){
          boss.deadUntil=now+120000;
          const users=[...this.bossContributors];
          const global=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
          this.ctx.waitUntil(global.fetch(new Request('https://internal/internal/reward',{method:'POST',body:JSON.stringify({users,gold:10,shards:1,item:'boss_relic',itemCount:1})})).catch(()=>{}));
          const gear=Math.random()<0.18?'guardian_plate':Math.random()<0.28?'arcane_staff':'boss_relic';
          if(gear!=='boss_relic')this.ctx.waitUntil(global.fetch(new Request('https://internal/internal/reward',{method:'POST',body:JSON.stringify({users,gold:0,shards:0,item:gear,itemCount:1})})).catch(()=>{}));
          this.broadcast({t:'boss-reward',users,gold:10,shards:1,extra:gear!=='boss_relic'?gear:null});
        }
        this.broadcast({t:'world-boss',state:boss});
      }
    } else if(boss?.hp===0&&now>=boss.deadUntil) {
      boss.hp=boss.max;boss.deadUntil=0;this.broadcast({t:'world-boss',state:boss});
    }
    // GM-monsters are server-owned replicas. The visual copies never award local drops.
    if(damage&&this.gmMonsters.length){
      let modified=false;
      for(const m of this.gmMonsters){
        if(m.hp<=0||Math.hypot(x-m.x,y-m.y)>2.2||Math.hypot(p.x-m.x,p.y-m.y)>range+1.5)continue;
        m.hp=Math.max(0,m.hp-damage*2);modified=true;
        if(m.hp===0) m.died=now;
        break;
      }
      if(modified){this.publishGmMobs();this.ctx.waitUntil(this.persistGmMobs());}
    }
    if(damage&&this.sharedMobs){
      let changed=false;
      for(const mob of this.sharedMobs){
        if(mob.hp<=0||Math.hypot(x-mob.x,y-mob.y)>1.6||Math.hypot(p.x-mob.x,p.y-mob.y)>range+1.2)continue;
        mob.hp=Math.max(0,mob.hp-damage*2);
        if(!mob.hp){mob.deadUntil=now+65000;
          if(data.account){
            const registry=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
            const roll=Math.random(),bonus=roll<0.035?'iron_blade':roll<0.07?'arcane_staff':roll<0.095?'swift_ring':roll<0.12?'wildfang_bow':'monster_core';
            this.ctx.waitUntil(registry.fetch(new Request('https://internal/internal/reward',{method:'POST',body:JSON.stringify({users:[data.account],gold:2,shards:0,item:bonus,itemCount:1})})).catch(()=>{}));
            this.sendTo(id,{t:'loot-reward',item:bonus,count:1,gold:2});
          }
        }
        changed=true;break;
      }
      if(changed)this.broadcast({t:'shared-mobs',mobs:this.sharedMobs});
    }
  }
  // Online GM permission MUST come from an unguessable Cloudflare Worker secret.
  // /gmadmin2008 unlocks local UI only, never gives server authority.
  authorizeGM(ws,q) {
    const secret=String(this.env.GM_SPAWN_KEY||'');
    const key=typeof q.key==='string'?q.key:'';
    if(secret.length<16){ws.send(JSON.stringify({t:'gm-error',error:'ผู้ดูแลต้องตั้ง Secret GM_SPAWN_KEY ใน Cloudflare ก่อน'}));return;}
    // Constant-time comparison of equal-sized strings (best effort in JS).
    let diff=key.length^secret.length;
    for(let i=0;i<Math.max(key.length,secret.length);i++)diff|=(key.charCodeAt(i)||0)^(secret.charCodeAt(i)||0);
    if(!key||key.length>256||diff){ws.send(JSON.stringify({t:'gm-error',error:'รหัส GM ออนไลน์ไม่ถูกต้อง'}));return;}
    const state=ws.deserializeAttachment()||{};
    ws.serializeAttachment({...state,gmAuthorized:true});
    ws.send(JSON.stringify({t:'gm-auth',ok:true}));
  }
  async persistGmMobs(){
    await this.ctx.storage.put('gm-monsters-v1',this.gmMonsters);
  }
  publishGmMobs(){this.broadcast({t:'gm-mobs',mobs:this.gmMonsters});}
  gmCommand(ws,q){
    const st=ws.deserializeAttachment()||{};
    if(!st.gmAuthorized){ws.send(JSON.stringify({t:'gm-error',error:'ต้องยืนยันรหัส GM ออนไลน์ก่อนเสกบอส'}));return;}
    if(st.room==='lobby'||!Number.isFinite(st.presence?.x)||!Number.isFinite(st.presence?.y)){
      ws.send(JSON.stringify({t:'gm-error',error:'กรุณาเข้าแมพและเลือกเซิร์ฟเวอร์ก่อน'}));return;
    }
    const now=Date.now();
    if(q.t==='gm-control'){
      const cmd=String(q.action||'');
      if(cmd==='clear'||cmd==='kill')this.gmMonsters=[];
      else if(cmd==='heal')for(const m of this.gmMonsters)m.hp=m.max;
      else if(cmd==='freeze')for(const m of this.gmMonsters)m.frozen=!m.frozen;
      else if(cmd==='pull')for(const m of this.gmMonsters){m.x=st.presence.x+(Math.random()*4-2);m.y=st.presence.y+(Math.random()*4-2);}
      else return;
      this.publishGmMobs();this.ctx.waitUntil(this.persistGmMobs());
      ws.send(JSON.stringify({t:'gm-ok',message:'ซิงก์คำสั่ง GM กับผู้เล่นในแมพแล้ว'}));return;
    }
    const catalog=Number(q.catalog),level=Number(q.level),count=Number(q.count);
    const grade=String(q.grade||''),name=limitText(q.name,40);
    if(!Number.isSafeInteger(catalog)||catalog<0||catalog>1000||!Number.isSafeInteger(level)||level<1||level>200||!Number.isSafeInteger(count)||count<1||count>10||!['normal','elite','champion','rare','boss','world'].includes(grade)||!name||name.length>40){
      ws.send(JSON.stringify({t:'gm-error',error:'ข้อมูลบอสไม่ถูกต้อง'}));return;
    }
    if(now-(st.lastGmSpawn||0)<800){ws.send(JSON.stringify({t:'gm-error',error:'เสกเร็วเกินไป กรุณาลองอีกครั้ง'}));return;}
    if(this.gmMonsters.length+count>36){ws.send(JSON.stringify({t:'gm-error',error:'ห้องนี้มีบอสจาก GM ครบ 36 ตัวแล้ว'}));return;}
    ws.serializeAttachment({...st,lastGmSpawn:now});
    const mult={normal:1,elite:1.5,champion:2,rare:3,boss:8,world:16}[grade];
    const max=Math.max(100,Math.round(300*mult*(1+level/20)));
    for(let i=0;i<count;i++){
      const angle=Math.random()*Math.PI*2,r=2+Math.random()*2;
      this.gmMonsters.push({id:crypto.randomUUID(),catalog,grade,name,level,hp:max,max,
        x:+(st.presence.x+Math.cos(angle)*r).toFixed(2),y:+(st.presence.y+Math.sin(angle)*r).toFixed(2),
        fx:1,moving:false,ally:!!q.ally,dummy:!!q.dummy,frozen:false,
        created:now,expires:now+60*60*1000});
    }
    this.publishGmMobs();this.ctx.waitUntil(this.persistGmMobs());
    ws.send(JSON.stringify({t:'gm-ok',message:'เสก '+name+' ×'+count+' ให้ผู้เล่นในแมพเดียวกันเห็นแล้ว'}));
  }
  tickGmMonsters(){
    const now=Date.now();if(now-this.lastGmTick<350)return;
    const dt=Math.min(0.35,(now-(this.lastGmTick||now))/1000);this.lastGmTick=now;
    const before=this.gmMonsters.length;
    this.gmMonsters=this.gmMonsters.filter(m=>m.expires>now&&m.hp>0);
    let changed=before!==this.gmMonsters.length;
    for(const m of this.gmMonsters){
      m.moving=false;
      if(m.dummy||m.ally||m.frozen)continue;
      let best=null,dist=Infinity;
      for(const socket of this.ctx.getWebSockets()){
        const p=socket.deserializeAttachment()?.presence;
        if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y))continue;
        const d=Math.hypot(m.x-p.x,m.y-p.y);if(d<dist){dist=d;best=p;}
      }
      if(best&&dist>1.7&&dist<10){
        const step=Math.min(dist-1.7,0.85*dt);m.x+=((best.x-m.x)/dist)*step;m.y+=((best.y-m.y)/dist)*step;
        m.fx=best.x<m.x?-1:1;m.moving=true;changed=true;
      }
      // Cosmetic attack cue, not client-authoritative damage.
      if(best&&dist<=2&&now-(m.lastAttack||0)>2200){
        m.lastAttack=now;
        this.broadcast({t:'gm-attack',id:m.id,x:m.x,y:m.y});
      }
    }
    if(changed){this.publishGmMobs();if(before!==this.gmMonsters.length)this.ctx.waitUntil(this.persistGmMobs());}
  }
  finishTeamMatch(winner) {
    const match=this.match;if(!match)return;
    this.broadcast({t:'team',kind:'end',score:match.score,winner});
    const players=match.teams[winner]||[];
    const users=[...new Set(players.map(id=>this.peerInfo(id)?.account).filter(Boolean))];
    if(users.length){
      const global=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
      this.ctx.waitUntil(global.fetch(new Request('https://internal/internal/reward',{method:'POST',body:JSON.stringify({users,gold:5,shards:0,item:'arena_medal',itemCount:1})})).catch(()=>{}));
    }
    this.match=null;
  }
  tickSharedMobs() {
    if(!this.sharedMobs)return;
    const now=Date.now();if(now-this.lastMobTick<220)return;
    const dt=Math.min(0.25,(now-this.lastMobTick)/1000);this.lastMobTick=now;
    let changed=false;
    for(const m of this.sharedMobs){
      if(!m.hp){if(now>=m.deadUntil){m.hp=m.max;m.deadUntil=0;changed=true;}continue;}
      let best=null,dist=Infinity;
      for(const sock of this.ctx.getWebSockets()){
        const p=sock.deserializeAttachment()?.presence;
        if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y))continue;
        const d=Math.hypot(m.x-p.x,m.y-p.y);
        if(d<dist){best=p;dist=d;}
      }
      if(best&&dist>1.3&&dist<7){const speed=0.9*dt;m.x+=((best.x-m.x)/dist)*speed;m.y+=((best.y-m.y)/dist)*speed;changed=true;}
    }
    if(changed)this.broadcast({t:'shared-mobs',mobs:this.sharedMobs});
  }
  teamMessage(ws,q) {
    const id=(ws.deserializeAttachment()||{}).id,mode=String(q.mode||'');
    const max={ '3v3':3,'5v5':5,'15v15':15 }[mode];if(!id||!max)return;
    if(q.kind==='leave'){for(const a of this.queues.values()){const idx=a.indexOf(id);if(idx>=0)a.splice(idx,1);}return;}
    if(q.kind!=='queue'||this.match)return;
    for(const a of this.queues.values())if(a.includes(id))return;
    const queue=this.queues.get(mode)||[];
    queue.push(id);this.queues.set(mode,queue);
    this.broadcast({t:'team',kind:'queue',mode,count:queue.length,needed:max*2});
    if(queue.length>=max*2) {
      const players=queue.splice(0,max*2);
      const teams=[players.slice(0,max),players.slice(max)];
      const hp=Object.fromEntries(players.map(id=>[id,100]));
      this.match={mode,teams,hp,score:[0,0],limit:max*3,started:Date.now()};
      this.broadcast({t:'team',kind:'start',mode,teams,hp,score:[0,0]});
    }
  }
  async authenticateAccount(ws,q) {
    const token=String(q.token||'');if(token.length!==72)return;
    const registry=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
    const res=await registry.fetch(new Request('https://internal/api/v2',{method:'POST',body:JSON.stringify({op:'me',token})}));
    if(!res.ok)return;const account=await res.json();if(!account.ok||!account.user)return;
    const previous=ws.deserializeAttachment()||{};
    const owned=account.onlineItems||{},equipped={};
    for(const [slot,item] of Object.entries(account.onlineEquipped||{}))if(owned[item]>=1)equipped[slot]=item;
    ws.serializeAttachment({...previous,account:account.user,accountToken:token,equipped});
    ws.send(JSON.stringify({t:'account-auth',user:account.user}));
  }
  async rewardAccounts(request) {
    const b=await request.json(),users=[...new Set(Array.isArray(b.users)?b.users:[])].slice(0,50);
    for(const user of users){
      if(!/^[a-z0-9_]{3,20}$/.test(user))continue;
      const key='acct:'+user;
      await this.ctx.storage.transaction(async st=>{
        const a=await st.get(key);if(!a)return;
        a.onlineGold+=Math.min(30,Math.max(0,Math.trunc(b.gold)||0));
        a.onlineShards+=Math.min(3,Math.max(0,Math.trunc(b.shards)||0));
        a.onlineItems=a.onlineItems||{};
        if(b.item&&Object.hasOwn(ITEM_LABELS,b.item))a.onlineItems[b.item]=Math.min(1000000,(a.onlineItems[b.item]||0)+Math.min(3,Math.max(0,Math.trunc(b.itemCount)||1)));
        await st.put(key,a);
      });
    }
    return respond({ok:true,count:users.length});
  }
  async authenticateGuild(ws,q) {
    const token=String(q.token||'');if(!/^(?:[0-9a-f-]{36}|[0-9a-f-]{72})$/.test(token))return;
    const service=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('guild-registry-v1'));
    const res=await service.fetch(new Request('https://internal/internal/guild-verify',{method:'POST',body:JSON.stringify({token})}));
    if(!res.ok)return;const value=await res.json();if(!value.guildId)return;
    const info=ws.deserializeAttachment()||{};
    ws.serializeAttachment({...info,guildId:value.guildId,guildTag:value.tag});
    ws.send(JSON.stringify({t:'guild-auth',tag:value.tag}));
  }
  async verifyGuild(request) {
    const body=await request.json();const token=String(body.token||'');
    const all=await this.ctx.storage.list({prefix:'guild:'});
    const identity=await this.guildIdentity(token);
    if(!identity)return respond({guildId:null});
    for(const g of all.values())if(g.members.some(m=>m.key===identity.key||m.token===token))return respond({guildId:g.id,tag:g.tag});
    return respond({guildId:null});
  }
  async recordCastle(request) {
    const b=await request.json();if(!/^[0-9a-f-]{36}$/.test(String(b.guildId||'')))return respond({ok:false},400);
    const data={guildId:b.guildId,tag:String(b.tag||'').slice(0,6),wonAt:Date.now()};
    await this.ctx.storage.put('castle:main',data);return respond({ok:true,castle:data});
  }
  publicWar() {const w=this.war;return w?{guilds:w.guilds.map(g=>g.tag),score:w.score,capture:w.capture,owner:w.owner,x:w.x,y:w.y}:null;}
  warMessage(ws,q) {
    if(q.kind!=='join'&&q.kind!=='leave')return;
    const info=ws.deserializeAttachment()||{},id=info.id;if(!id)return;
    if(q.kind==='leave'){if(this.war)delete this.war.participants[id];return;}
    if(!info.guildId)return ws.send(JSON.stringify({t:'war',kind:'error',error:'กรุณาเข้ากิลด์ออนไลน์แล้วรีเฟรชก่อน'}));
    if(!this.war){const pos=info.presence||{};this.war={guilds:[{id:info.guildId,tag:info.guildTag}],score:[0,0],capture:0,owner:null,x:Number(pos.x)||12,y:Number(pos.y)||12,participants:{},last:Date.now()};}
    const w=this.war;let team=w.guilds.findIndex(g=>g.id===info.guildId);
    if(team<0&&w.guilds.length<2){team=1;w.guilds.push({id:info.guildId,tag:info.guildTag});}
    if(team<0)return ws.send(JSON.stringify({t:'war',kind:'error',error:'สนามนี้มีกิลด์สองฝ่ายแล้ว'}));
    w.participants[id]=team;
    this.broadcast({t:'war',kind:'state',state:this.publicWar()});
  }
  tickWar() {
    const w=this.war;if(!w||w.guilds.length<2||w.owner!=null)return;
    const now=Date.now();if(now-w.last<1000)return;
    const near=[0,0];
    for(const [id,team] of Object.entries(w.participants)) {
      const p=this.peerInfo(id)?.presence;if(p&&Number.isFinite(p.x)&&Math.hypot(p.x-w.x,p.y-w.y)<3)near[team]++;
    }
    if((near[0]>0)!==(near[1]>0)) {
      const winner=near[0]>0?0:1;
      w.score[winner]++;w.capture=Math.min(100,w.score[winner]*2);
      if(w.score[winner]>=50) {
        w.owner=winner;
        const guild=w.guilds[winner];
        const stub=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('guild-registry-v1'));
        this.ctx.waitUntil(stub.fetch(new Request('https://internal/internal/castle',{method:'POST',body:JSON.stringify({guildId:guild.id,tag:guild.tag})})).catch(()=>{}));
      }
    }
    w.last=now;this.broadcast({t:'war',kind:'state',state:this.publicWar()});
  }
  sendTo(peerId, packet) {
    for(const ws of this.ctx.getWebSockets()) {
      const info=ws.deserializeAttachment() || {};
      if(info.id===peerId) { try { ws.send(JSON.stringify(packet)); return true; } catch { return false; } }
    }
    return false;
  }

  duelMessage(ws, q) {
    const sender=(ws.deserializeAttachment()||{}).id;
    if(!sender) return;
    const kind=String(q.kind||'').slice(0,20);
    const target=String(q.target||'').slice(0,65);
    const now=Date.now();
    if(kind==='challenge') {
      if(!target || target===sender || !this.peerNear(sender,target,20) || this.duels.has(sender)) return;
      this.requests.set(target,{from:sender,t:now});
      this.sendTo(target,{t:'duel',kind:'challenge',from:sender});
      return;
    }
    if(kind==='accept'||kind==='decline') {
      const req=this.requests.get(sender);
      if(!req || req.from!==target || now-req.t>30000) return;
      this.requests.delete(sender);
      if(kind==='decline'){this.sendTo(target,{t:'duel',kind:'decline',from:sender});return;}
      if(this.duels.has(target)||this.duels.has(sender)||!this.peerNear(sender,target,20))return;
      const fight={a:target,b:sender,hp:{[sender]:100,[target]:100},last:{}};
      this.duels.set(target,fight);this.duels.set(sender,fight);
      this.sendTo(target,{t:'duel',kind:'start',with:sender,hp:fight.hp});
      this.sendTo(sender,{t:'duel',kind:'start',with:target,hp:fight.hp});
      return;
    }
    const fight=this.duels.get(sender);
    if(!fight)return;
    const other=fight.a===sender?fight.b:fight.a;
    if(kind==='forfeit') {this.endDuel(fight,other,'forfeit');return;}
    if(kind!=='attack')return;
    if(now-(fight.last[sender]||0)<520 || !this.peerNear(sender,other,4.5))return;
    fight.last[sender]=now;
    fight.hp[other]=Math.max(0,fight.hp[other]-10);
    for(const peer of [fight.a,fight.b]) this.sendTo(peer,{t:'duel',kind:'hit',by:sender,hp:fight.hp});
    if(!fight.hp[other])this.endDuel(fight,sender,'ko');
  }
  peerNear(a,b,maxRange) {
    const get=id=>{for(const ws of this.ctx.getWebSockets()){const s=ws.deserializeAttachment();if(s&&s.id===id)return s.presence;}return null;};
    const A=get(a), B=get(b);
    return A && B && Number.isFinite(A.x) && Number.isFinite(B.x) && Math.hypot(A.x-B.x,A.y-B.y)<=maxRange;
  }
  endDuel(fight,winner,reason){
    this.duels.delete(fight.a);this.duels.delete(fight.b);
    for(const id of [fight.a,fight.b])this.sendTo(id,{t:'duel',kind:'end',winner,reason});
  }

  async guildIdentity(token) {
    if(/^[0-9a-f-]{36}$/.test(token))return {key:'guest:'+token,user:null};
    if(!/^[0-9a-f-]{72}$/.test(token))return null;
    const stub=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
    const res=await stub.fetch(new Request('https://internal/internal/verify-token',{method:'POST',body:JSON.stringify({token})}));
    if(!res.ok)return null;
    const data=await res.json();
    return data.ok&&/^[a-z0-9_]{3,20}$/.test(data.user)?{key:'account:'+data.user,user:data.user}:null;
  }
  async guildRequest(request){
    if(request.method==='GET'){
      const all=await this.ctx.storage.list({prefix:'guild:'});
      const castle=await this.ctx.storage.get('castle:main');
      return api({ok:true,castle:castle||null,guilds:[...all.values()].map(g=>({id:g.id,name:g.name,tag:g.tag,count:g.members.length,leader:g.members[0]?.name||'-'})).sort((a,b)=>b.count-a.count)});
    }
    if(request.method!=='POST')return api({ok:false,error:'Method not allowed'},405);
    const textBody=await request.text();
    if(textBody.length>4096)return api({ok:false,error:'Too large'},413);
    let b;
    try{b=JSON.parse(textBody);}catch{return api({ok:false,error:'Invalid JSON'},400);}
    const token=String(b.token||'');
    const identity=await this.guildIdentity(token);
    if(!identity)return api({ok:false,error:'ลงชื่อเข้าบัญชีคลาวด์ใหม่หรือรีเฟรชหน้าเกม'},401);
    const name=limitText(b.name||'ผู้เล่น',14).trim()||'ผู้เล่น';
    const cls=limitText(b.cls,30);const lv=Math.trunc(bound(b.lv,1,200,1));
    const all=await this.ctx.storage.list({prefix:'guild:'});
    let own=null;let member=null;
    for(const g of all.values()){const m=g.members.find(m=>m.key===identity.key||(identity.key.startsWith('guest:')&&m.token===token));if(m){own=g;member=m;break;}}
    const publicGuild=g=>g?({id:g.id,name:g.name,tag:g.tag,leaderId:g.members[0]?.id||null,members:g.members.map(m=>({id:m.id,name:m.name,cls:m.cls,lv:m.lv}))}):null;
    const respond=async()=>{
      const latest=await this.ctx.storage.list({prefix:'guild:'});
      return api({ok:true,meId:member?.id||null,guild:publicGuild(own),guilds:[...latest.values()].map(g=>({id:g.id,name:g.name,tag:g.tag,count:g.members.length,leader:g.members[0]?.name||'-'})).sort((a,b)=>b.count-a.count)});
    };
    if(b.op==='me'||b.op==='list')return respond();
    if(b.op==='create'){
      if(own)return api({ok:false,error:'กรุณาออกจากกิลด์เดิมก่อน'},409);
      const n=limitText(b.guildName,24).trim(),tag=limitText(b.tag,6).trim().toUpperCase();
      if(n.length<3||!/^[A-Z0-9]{2,6}$/.test(tag))return api({ok:false,error:'กรอกชื่อกิลด์ 3–24 ตัวอักษร และแท็ก 2–6 ตัว A-Z/0-9'},400);
      if(all.size>=200 || [...all.values()].some(g=>g.name.toLowerCase()===n.toLowerCase()||g.tag===tag))return api({ok:false,error:'ชื่อหรือแท็กซ้ำ หรือเซิร์ฟเวอร์เต็ม'},409);
      const player={key:identity.key,...(identity.user?{}:{token}),id:crypto.randomUUID(),name:identity.user||name,cls,lv};
      own={id:crypto.randomUUID(),name:n,tag,members:[player]};member=player;
      await this.ctx.storage.put('guild:'+own.id,own);
      return respond();
    }
    if(b.op==='join'){
      if(own)return api({ok:false,error:'ต้องออกจากกิลด์เดิมก่อน'},409);
      const g=all.get('guild:'+String(b.id||''));
      if(!g)return api({ok:false,error:'ไม่พบกิลด์'},404);
      if(g.members.length>=50)return api({ok:false,error:'กิลด์เต็ม'},409);
      const player={key:identity.key,...(identity.user?{}:{token}),id:crypto.randomUUID(),name:identity.user||name,cls,lv};g.members.push(player);
      await this.ctx.storage.put('guild:'+g.id,g);own=g;member=player;return respond();
    }
    if(b.op==='leave'){
      if(!own)return respond();
      own.members=own.members.filter(m=>m.key!==identity.key&&m.token!==token);
      if(own.members.length) await this.ctx.storage.put('guild:'+own.id,own);
      else await this.ctx.storage.delete('guild:'+own.id);
      own=null;member=null;return respond();
    }
    if(b.op==='kick'){
      if(!own||(own.members[0]?.key!==identity.key&&own.members[0]?.token!==token))return api({ok:false,error:'เฉพาะหัวหน้ากิลด์เท่านั้น'},403);
      const id=String(b.id||'');
      if(id===member.id)return api({ok:false,error:'ใช้ปุ่มออกจากกิลด์'},400);
      own.members=own.members.filter(m=>m.id!==id);
      await this.ctx.storage.put('guild:'+own.id,own);
      return respond();
    }
    return api({ok:false,error:'Unknown operation'},400);
  }


  sendError(ws,type,message){try{ws.send(JSON.stringify({t:type+'-error',error:String(message).slice(0,180)}));}catch{}}
  globalStub(){return this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('gm-global-hub-v1'));}
  async registerWithGlobal(room){
    if(!/^(?:lobby|s[1-4]-[a-z0-9_.-]{1,30})$/.test(room))return;
    const response=await this.globalStub().fetch(new Request('https://internal/internal/room-register',{method:'POST',body:JSON.stringify({room})}));
    if(!response.ok)return;
    const data=await response.json();this.serverSettings={...this.serverSettings,...(data.settings||{})};
    await this.ctx.storage.put('mmo-global-settings-v1',this.serverSettings);
    this.broadcast({t:'gm-settings',settings:this.serverSettings});
    // Ground items are recovered from the account ledger after room hibernation.
    if(room!=='lobby')try{const reg=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
      const rs=await reg.fetch(new Request('https://internal/internal/economy',{method:'POST',body:JSON.stringify({op:'ground.list',room})}));
      if(rs.ok){const v=await rs.json();this.groundDrops=v.drops||[];
        await this.ctx.storage.put('world-ground-drops-v1',this.groundDrops);this.broadcast({t:'ground-drops',drops:this.groundDrops});}
    }catch{}
    for(const spawn of data.spawns||[])this.applyGlobalSpawn(spawn);
  }
  async registerInternalRoom(req){
    const b=await req.json(),room=String(b.room||'');
    if(!/^(?:lobby|s[1-4]-[a-z0-9_.-]{1,30})$/.test(room))return api({ok:false},400);
    const rooms=await this.ctx.storage.get('mmo-global-rooms-v1')||{};
    const now=Date.now();for(const [id,exp] of Object.entries(rooms))if(exp<now)delete rooms[id];
    rooms[room]=now+2*3600000;await this.ctx.storage.put('mmo-global-rooms-v1',rooms);
    return api({ok:true,settings:await this.ctx.storage.get('mmo-global-settings-v1')||this.serverSettings,
      spawns:(await this.ctx.storage.get('mmo-global-spawns-v1')||[]).filter(a=>a.expires>now)});
  }
  gmGlobal(ws,q){
    const st=ws.deserializeAttachment()||{};
    if(!st.gmAuthorized){this.sendError(ws,'gm','ต้องยืนยัน GM ออนไลน์ก่อน');return;}
    const action=String(q.action||''),payload={action,from:st.presence?.n||'GM'};
    if(action==='announce'){
      payload.message=limitText(q.message,150).trim();if(!payload.message){this.sendError(ws,'gm','กรุณาใส่ประกาศ');return;}
    } else if(action==='toggle'){
      payload.key=String(q.key||'');payload.value=!!q.value;
      if(!['pvp','war','trade','market','ground','boss'].includes(payload.key))return;
    } else if(action==='spawn'){
      payload.catalog=Math.trunc(Number(q.catalog));payload.count=Math.trunc(Number(q.count||1));payload.level=Math.trunc(Number(q.level||1));
      payload.grade=String(q.grade||'');payload.name=limitText(q.name,40);payload.ally=!!q.ally;payload.dummy=!!q.dummy;
      if(!Number.isInteger(payload.catalog)||payload.catalog<0||payload.catalog>1000||!Number.isInteger(payload.count)||payload.count<1||payload.count>3||!Number.isInteger(payload.level)||payload.level<1||payload.level>200||!['normal','elite','champion','rare','boss','world'].includes(payload.grade)||!payload.name)return this.sendError(ws,'gm','ข้อมูลบอสไม่ถูกต้อง');
      payload.id=crypto.randomUUID();payload.expires=Date.now()+3600000;
    } else if(action!=='clear'&&action!=='heal'&&action!=='freeze')return;
    this.ctx.waitUntil(this.globalStub().fetch(new Request('https://internal/internal/gm-global-command',{method:'POST',body:JSON.stringify(payload)})).then(async r=>{
      const v=await r.json();if(v.ok)ws.send(JSON.stringify({t:'gm-ok',message:'คำสั่ง GM ส่งถึง '+v.rooms+' แมพแล้ว'}));
      else this.sendError(ws,'gm','ไม่สามารถส่งคำสั่ง GM ทั่วเซิร์ฟเวอร์');
    }).catch(()=>this.sendError(ws,'gm','ส่งคำสั่ง GM ล้มเหลว')));
  }
  async globalCommandInternal(req){
    const b=await req.json(),now=Date.now();
    let settings=await this.ctx.storage.get('mmo-global-settings-v1')||this.serverSettings;
    if(b.action==='toggle'){
      if(!['pvp','war','trade','market','ground','boss'].includes(b.key))return api({ok:false},400);
      settings={...settings,[b.key]:!!b.value};
      await this.ctx.storage.put('mmo-global-settings-v1',settings);
      const global=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
      await global.fetch(new Request('https://internal/internal/config',{method:'POST',body:JSON.stringify({settings})}));
    }
    if(b.action==='spawn'){
      const saved=await this.ctx.storage.get('mmo-global-spawns-v1')||[];
      saved.push(b);await this.ctx.storage.put('mmo-global-spawns-v1',saved.filter(g=>g.expires>now).slice(-30));
    }
    if(b.action==='clear')await this.ctx.storage.put('mmo-global-spawns-v1',[]);
    const active=await this.ctx.storage.get('mmo-global-rooms-v1')||{};
    const ids=Object.entries(active).filter(([,exp])=>exp>now).map(([id])=>id).slice(0,200);
    let delivered=0;
    for(const id of ids){try{
      const stub=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName(id));
      const response=await stub.fetch(new Request('https://internal/internal/gm-delivery',{method:'POST',body:JSON.stringify(b)}));
      if(response.ok)delivered++;
    }catch{}}
    return api({ok:true,rooms:delivered});
  }
  async deliverGlobal(req){
    const b=await req.json();
    if(b.action==='announce')this.broadcast({t:'gm-global',kind:'notice',message:limitText(b.message,150),from:limitText(b.from,20)});
    else if(b.action==='toggle'){
      if(!['pvp','war','trade','market','ground','boss'].includes(b.key))return api({ok:false},400);
      this.serverSettings={...this.serverSettings,[b.key]:!!b.value};
      await this.ctx.storage.put('mmo-global-settings-v1',this.serverSettings);
      this.broadcast({t:'gm-settings',settings:this.serverSettings});
      if(b.key==='pvp'&&b.value===false){if(this.match)this.finishTeamMatch(-1);this.queues.clear();}
      if(b.key==='war'&&b.value===false){this.war=null;this.broadcast({t:'war',kind:'state',state:null});}
      if(b.key==='boss')this.broadcast({t:'world-boss',state:b.value?this.boss:null});
    } else if(b.action==='spawn')this.applyGlobalSpawn(b);
    else if(['clear','heal','freeze'].includes(b.action)){
      if(b.action==='clear')this.gmMonsters=[];
      if(b.action==='heal')for(const m of this.gmMonsters)m.hp=m.max;
      if(b.action==='freeze')for(const m of this.gmMonsters)m.frozen=!m.frozen;
      this.publishGmMobs();await this.persistGmMobs();
    }
    return api({ok:true});
  }
  applyGlobalSpawn(b){
    if(this.gmMonsters.some(m=>m.globalId===b.id))return;
    const now=Date.now();if(!b||b.expires<=now)return;
    const peer=this.ctx.getWebSockets().map(w=>w.deserializeAttachment()?.presence).find(p=>Number.isFinite(p?.x));
    if(!peer){if(!this.pendingGlobal.some(p=>p.id===b.id))this.pendingGlobal.push(b);return;}
    if(this.gmMonsters.length+Math.min(3,b.count)>36)return;
    const mult={normal:1,elite:1.5,champion:2,rare:3,boss:8,world:16}[b.grade]||1;
    const max=Math.round(300*mult*(1+b.level/20));
    for(let i=0;i<Math.min(b.count,3);i++)this.gmMonsters.push({
      id:crypto.randomUUID(),globalId:b.id,catalog:b.catalog,grade:b.grade,name:b.name,level:b.level,
      hp:max,max,x:peer.x+(i%3-1)*2,y:peer.y+3+Math.floor(i/3)*2,
      fx:1,moving:false,ally:!!b.ally,dummy:!!b.dummy,frozen:false,created:now,expires:b.expires
    });
    this.publishGmMobs();this.ctx.waitUntil(this.persistGmMobs());
  }
  async groundMessage(ws,q){
    const st=ws.deserializeAttachment()||{},p=st.presence||{},id=st.id;
    if(!st.account||!st.accountToken||!Number.isFinite(p.x)||!Number.isFinite(p.y))return this.sendError(ws,'ground','กรุณาล็อกอินบัญชีออนไลน์ในแมพก่อน');
    const identity=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
    const verified=await identity.fetch(new Request('https://internal/internal/verify-token',{method:'POST',body:JSON.stringify({token:st.accountToken})}));
    if(!verified.ok||(await verified.json()).user!==st.account)return this.sendError(ws,'ground','เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
    if(this.serverSettings.ground===false)return this.sendError(ws,'ground','GM ปิดระบบทิ้งของชั่วคราว');
    const action=String(q.action||''),now=Date.now();
    if(action==='drop'){
      if(now-(st.lastDrop||0)<1200)return;
      const item=String(q.item||''),qty=Math.trunc(Number(q.qty));
      if(!Object.hasOwn(ITEM_LABELS,item)||!Number.isSafeInteger(qty)||qty<1||qty>20)return;
      if(this.groundDrops.length>=60)return this.sendError(ws,'ground','ของบนพื้นเต็ม');
      ws.serializeAttachment({...st,lastDrop:now});
      const groundId=crypto.randomUUID();
      const stub=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
      const response=await stub.fetch(new Request('https://internal/internal/economy',{method:'POST',body:JSON.stringify({op:'ground.drop',room:st.room,id:groundId,user:st.account,item,qty,x:p.x,y:p.y})}));
      if(!response.ok)return this.sendError(ws,'ground','ไอเทมออนไลน์ในกระเป๋าไม่พอ');
      const result=await response.json();this.groundDrops.push(result.drop);
      await this.ctx.storage.put('world-ground-drops-v1',this.groundDrops);
      this.broadcast({t:'ground-drops',drops:this.groundDrops});
      ws.send(JSON.stringify({t:'ground-ok',message:'ทิ้งไอเทมออนไลน์ลงแมพแล้ว'}));
      return;
    }
    if(action==='pickup'){
      const groundId=String(q.id||'');if(!/^[0-9a-f-]{36}$/.test(groundId)||this.pickupLocks.has(groundId))return;
      const drop=this.groundDrops.find(d=>d.id===groundId);
      if(!drop||drop.expires<=now||Math.hypot(drop.x-p.x,drop.y-p.y)>3.8)return this.sendError(ws,'ground','ต้องอยู่ใกล้ไอเทมบนพื้น');
      this.pickupLocks.add(groundId);
      try{
        const stub=this.env.ASHFALL_ROOMS.get(this.env.ASHFALL_ROOMS.idFromName('account-registry-v2'));
        const response=await stub.fetch(new Request('https://internal/internal/economy',{method:'POST',body:JSON.stringify({op:'ground.pick',room:st.room,id:groundId,user:st.account})}));
        if(!response.ok){if(response.status===404){this.groundDrops=this.groundDrops.filter(d=>d.id!==groundId);await this.ctx.storage.put('world-ground-drops-v1',this.groundDrops);this.broadcast({t:'ground-drops',drops:this.groundDrops});}return this.sendError(ws,'ground','เก็บไอเทมล้มเหลวหรือมีคนเก็บไปก่อน');}
        this.groundDrops=this.groundDrops.filter(d=>d.id!==groundId);
        await this.ctx.storage.put('world-ground-drops-v1',this.groundDrops);
        this.broadcast({t:'ground-drops',drops:this.groundDrops});
        ws.send(JSON.stringify({t:'ground-ok',message:'เก็บ '+ITEM_LABELS[drop.item]+' ×'+drop.qty+' แล้ว'}));
      }finally{this.pickupLocks.delete(groundId);}
    }
  }
  pruneGroundDrops(){
    const now=Date.now();if(!this.groundDrops.some(d=>d.expires<=now))return;
    this.groundDrops=this.groundDrops.filter(d=>d.expires>now);
    this.ctx.waitUntil(this.ctx.storage.put('world-ground-drops-v1',this.groundDrops));
    this.broadcast({t:'ground-drops',drops:this.groundDrops});
  }
  async alarm(){await settleAuctions(this.ctx);}

  webSocketClose(ws) {
    const info = ws.deserializeAttachment();
    if(info?.id){
      if(this.match?.teams?.some(t=>t.includes(info.id))){
        const lost=this.match.teams.findIndex(t=>t.includes(info.id));
        this.finishTeamMatch(lost===0?1:0);
      }
      for(const a of this.queues.values()){const j=a.indexOf(info.id);if(j>=0)a.splice(j,1);}if(this.war)delete this.war.participants[info.id];}
    const fight = info && this.duels.get(info.id);
    if(fight)this.endDuel(fight,fight.a===info.id?fight.b:fight.a,'disconnect');
    if (info && info.id) this.broadcast({ t: 'left', id: info.id }, ws);
    try { ws.close(1000, 'closed'); } catch {}
  }

  webSocketError(ws) {
    const info = ws.deserializeAttachment();
    const fight = info && this.duels.get(info.id);
    if(fight)this.endDuel(fight,fight.a===info.id?fight.b:fight.a,'disconnect');
    if (info && info.id) this.broadcast({ t: 'left', id: info.id }, ws);
    try { ws.close(1011, 'error'); } catch {}
  }
}
