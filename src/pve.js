/* Server-authoritative shared PvE world. This handles ONLINE encounters only. */
import {MONSTER_CATALOG} from './catalog.js';
const FARM=Object.fromEntries(MONSTER_CATALOG.farms.map(m=>[m.id,m]));
const DUNGEON=Object.fromEntries(MONSTER_CATALOG.dungeons.map(m=>[m.id,m]));
export const roomPreset = key=>{
 const p=/^s[1-4]-(.+)$/.exec(String(key||''));if(!p)return null;
 const id=p[1];if(FARM[id])return {kind:'farm',map:FARM[id],floor:0,room:key};
 const d=/^d-(armory|sanctum|vault|jewel)([1-9][0-9]{0,3})$/.exec(id);
 if(d){const f=Number(d[2]);if(f>1000)return null;
  const dungeon=DUNGEON[d[1]];return {kind:'dungeon',map:MONSTER_CATALOG.farms[Math.min(19,Math.floor((f-1)/5))],floor:f,dungeon,room:key};}
 return null;
};
function seed(s){let a=2166136261;for(const c of s){a^=c.charCodeAt(0);a=Math.imul(a,16777619);}return ()=>{a+=0x6d2b79f5;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
export function spawnPve(room){
 const preset=roomPreset(room);if(!preset)return null;
 const R=seed(room+':pve-v4'),farm=preset.kind==='farm',base=preset.map;
 const max=farm?30:Math.min(18,7+Math.floor(preset.floor/7));
 const lv=farm?Math.round((base.lv[0]+base.lv[1])/2):Math.min(250,Math.round(preset.floor*.6+3));
 const mobs=[];
 const mk=(i,grade,slot,pt)=>{
  const md=grade==='boss'?base.boss:grade==='world'?base.world:grade==='rare'?base.rare:grade==='champion'?base.champ:base.mobs[slot%base.mobs.length];
  const hpScale={normal:1,elite:5,champion:15,rare:20,boss:60,world:320}[grade]||1;
  const mult=farm?1:(1+preset.floor/60)*(1+Math.max(0,preset.floor-300)/250)*.32;
  const maxHp=Math.max(50,Math.round((100+lv*7)*hpScale*mult));
  const x=Number(pt.x.toFixed(2)),y=Number(pt.y.toFixed(2));
  mobs.push({id:'pve-'+i,grade,slot,lv,name:md.n,body:md.body,c:md.c,c2:md.c2,x,y,hx:x,hy:y,hp:maxHp,max:maxHp,deadUntil:0,version:4,room});
 };
 const coord=()=>farm?{x:8+R()*70,y:7+R()*70}:{x:4+R()*25,y:3+R()*20};
 if(farm){for(let i=0;i<max;i++)mk(i,i%11===0?'elite':'normal',Math.floor(R()*base.mobs.length),coord());
  mk(max,'champion',0,{x:30,y:21});mk(max+1,'rare',0,{x:64,y:32});mk(max+2,'boss',0,{x:69,y:48});mk(max+3,'world',0,{x:45,y:42});
 } else if(preset.floor%10===0){mk(0,preset.floor===1000?'world':'boss',0,{x:16.5,y:12});
  for(let i=1;i<4;i++)mk(i,'normal',Math.floor(R()*base.mobs.length),coord());
 } else {for(let i=0;i<max;i++)mk(i,preset.floor%5===0&&i===0?'champion':i%9===0?'elite':'normal',Math.floor(R()*base.mobs.length),coord());}
 return mobs;
}
export function pveMove(mobs,peers,now,last){
 const dt=Math.min(.25,Math.max(.001,(now-last)/1000));let changed=false;
 for(const m of mobs){if(m.hp<=0){if(m.deadUntil>0&&now>=m.deadUntil){m.hp=m.max;m.deadUntil=0;m.x=m.hx;m.y=m.hy;changed=true;}continue;}
  let best=null,dist=Infinity;
  for(const p of peers){if(!Number.isFinite(p?.x)||!Number.isFinite(p?.y))continue;
   const d=Math.hypot(m.x-p.x,m.y-p.y);if(d<dist){dist=d;best=p;}}
  if(best&&dist>1.5&&dist<7){const speed=.82*dt;m.x+=((best.x-m.x)/dist)*speed;m.y+=((best.y-m.y)/dist)*speed;changed=true;}
  else if(dist>=7&&Math.hypot(m.x-m.hx,m.y-m.hy)>4){m.x+=(m.hx-m.x)*Math.min(.2,dt);m.y+=(m.hy-m.y)*Math.min(.2,dt);changed=true;}
 }
 return changed;
}
