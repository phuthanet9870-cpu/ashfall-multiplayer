import { ITEM_LABELS, economyAction, internalEconomy } from './economy.js';
// Cloudflare Durable Object single-shard account service for small playable beta.
// Online wallet is completely separate from the local game save's gold/items.
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Cache-Control':'no-store'};
export const respond=(data,status=200)=>Response.json(data,{status,headers:CORS});
const enc=new TextEncoder();
const hex=b=>[...new Uint8Array(b)].map(v=>v.toString(16).padStart(2,'0')).join('');
const digest=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
async function passhash(password,salt) {
  const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(salt),iterations:120000,hash:'SHA-256'},key,256));
}
const validName=s=>typeof s==='string'&&/^[a-z0-9_]{3,20}$/.test(s);
const validPass=s=>typeof s==='string'&&s.length>=8&&s.length<=128;
const reasonableSave=s=>s&&typeof s==='object'&&!Array.isArray(s)&&typeof s.cls==='string'&&typeof s.name==='string'&&Array.isArray(s.inv);
const safeQty=v=>Number.isSafeInteger(v)&&v>=0&&v<=1000000;
// Server-side items only: drops from shared monsters and boss / PvP medals.
export const ONLINE_ITEM_NAMES=ITEM_LABELS;
const safeItems=v=>{
  if(v==null)return {};
  if(typeof v!=='object'||Array.isArray(v))return null;
  const entries=Object.entries(v);
  if(entries.length>12)return null;
  const out={};
  for(const [k,n] of entries){if(!Object.hasOwn(ONLINE_ITEM_NAMES,k)||!Number.isSafeInteger(n)||n<1||n>100)return null;out[k]=n;}
  return out;
};
const walletItems=acct=>({...Object.fromEntries(Object.keys(ONLINE_ITEM_NAMES).map(k=>[k,0])),...(acct.onlineItems||{})});


export async function handleService(ctx, request) {
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
  if(request.method!=='POST')return respond({ok:false,error:'POST required'},405);
  const txt=await request.text();if(txt.length>260000)return respond({ok:false,error:'Payload too large'},413);
  let b;try{b=JSON.parse(txt)}catch{return respond({ok:false,error:'Bad JSON'},400)}
  if(!b||typeof b!=='object')return respond({ok:false,error:'Bad request'},400);
  const op=String(b.op||'');
  const storage=ctx.storage;
  const fail=(err,code=400)=>respond({ok:false,error:err},code);
  // This route is reachable only through the account Durable Object stub.
  // The public Worker fetch does not route /internal/verify-token.
  if(new URL(request.url).pathname==='/internal/economy') return internalEconomy(ctx,b);
  if(new URL(request.url).pathname==='/internal/config'){await storage.put('mmo-global-config-v1',b.settings||{});return respond({ok:true});}
  if(new URL(request.url).pathname==='/internal/verify-token') {
    const token=String(b.token||'');if(token.length!==72)return fail('Invalid token',401);
    const session=await storage.get('sess:'+await digest(token));
    return session?.expires>Date.now()?respond({ok:true,user:session.user}):fail('Session expired',401);
  }
  if(op==='register'||op==='login') {
    const name=String(b.user||'').toLowerCase().trim(),password=b.password;
    if(!validName(name)||!validPass(password))return fail('Username: 3–20 lowercase letters/numbers/_. Password: 8–128 characters');
    const k='acct:'+name;let a=await storage.get(k);
    if(op==='register'){
      if(a)return fail('Username already exists',409);
      const salt=crypto.randomUUID();a={user:name,salt,hash:await passhash(password,salt),revision:0,save:null,onlineGold:100,onlineShards:5,onlineItems:{},onlineEquipped:{},created:Date.now()};
      await storage.put(k,a);
    } else {
      if(!a)return fail('Invalid username or password',401);
      const h=await passhash(password,a.salt);
      if(h!==a.hash)return fail('Invalid username or password',401);
    }
    const token=crypto.randomUUID()+crypto.randomUUID(),tokenHash=await digest(token);
    await storage.put('sess:'+tokenHash,{user:name,expires:Date.now()+7*86400000});
    return respond({ok:true,user:name,token,revision:a.revision});
  }
  const token=String(b.token||'');
  if(token.length!==72)return fail('Login required',401);
  const hash=await digest(token),session=await storage.get('sess:'+hash);
  if(!session||session.expires<Date.now())return fail('Session expired; login again',401);
  const user=session.user,acctKey='acct:'+user;
  const acc=await storage.get(acctKey);
  if(!acc)return fail('Account not found',404);
  if(op==='logout'){await storage.delete('sess:'+hash);return respond({ok:true});}
  if(op==='me'||op==='wallet')return respond({ok:true,user,onlineGold:acc.onlineGold,onlineShards:acc.onlineShards,onlineItems:walletItems(acc),onlineEquipped:acc.onlineEquipped||{},itemNames:ONLINE_ITEM_NAMES,revision:acc.revision,saveExists:!!acc.save});
  if(op==='equip.set'){
    const slot=String(b.slot||''),item=String(b.item||'');
    const slots={weapon:['iron_blade','arcane_staff','wildfang_bow'],armor:['guardian_plate'],accessory:['swift_ring']};
    if(!Object.hasOwn(slots,slot)||(!slots[slot].includes(item)&&item!==''))return fail('ช่องหรืออุปกรณ์ไม่ถูกต้อง');
    const equipped=await storage.transaction(async t=>{
      const a=await t.get(acctKey);if(!a)return null;
      if(item&&((a.onlineItems||{})[item]||0)<1)return null;
      a.onlineEquipped=a.onlineEquipped||{};
      if(item)a.onlineEquipped[slot]=item;else delete a.onlineEquipped[slot];
      await t.put(acctKey,a);return a.onlineEquipped;
    });
    return equipped?respond({ok:true,onlineEquipped:equipped}):fail('ยังไม่มีอุปกรณ์ออนไลน์ชิ้นนี้',409);
  }
  if(op==='save.get')return respond({ok:true,user,save:acc.save,revision:acc.revision});
  if(op==='save.put'){
    if(!reasonableSave(b.save)||JSON.stringify(b.save).length>220000)return fail('Invalid or oversized save',400);
    if(b.revision!==acc.revision)return respond({ok:false,error:'Cloud save has changed on another device. Reload before overwriting.',revision:acc.revision},409);
    // Cloud saves are backups, NOT validated server-authoritative economy/inventory.
    acc.save=JSON.parse(JSON.stringify(b.save));acc.revision++;acc.savedAt=Date.now();
    await storage.put(acctKey,acc);return respond({ok:true,revision:acc.revision});
  }
  if(op.startsWith('market.')) {const settings=await storage.get('mmo-global-config-v1')||{};if(settings.market===false)return fail('GM ปิดตลาดออนไลน์ชั่วคราว',403);return economyAction(ctx,user,b);}
  if(op.startsWith('trade.')){const settings=await storage.get('mmo-global-config-v1')||{};if(settings.trade===false)return fail('GM ปิดระบบเทรดชั่วคราว',403);}
  if(op==='trade.offer') {
    const target=String(b.to||'').trim().toLowerCase();const gold=Number(b.gold),shards=Number(b.shards),items=safeItems(b.items);
    const wantGold=Number(b.wantGold||0),wantShards=Number(b.wantShards||0),wantItems=safeItems(b.wantItems);
    if(!validName(target)||target===user||!safeQty(gold)||!safeQty(shards)||!items||!safeQty(wantGold)||!safeQty(wantShards)||!wantItems||(gold===0&&shards===0&&!Object.keys(items).length&&wantGold===0&&wantShards===0&&!Object.keys(wantItems).length))return fail('Invalid trade details');
    const pending=[...(await storage.list({prefix:'offer:'})).values()]
      .filter(o=>o.from===user&&o.status==='open').length;
    if(pending>=10)return fail('มีข้อเสนอเทรดค้างครบ 10 รายการแล้ว กรุณายกเลิกบางรายการก่อน',409);
    const receiver=await storage.get('acct:'+target);
    if(!receiver)return fail('Recipient has no online account',404);
    if(acc.onlineGold<gold||acc.onlineShards<shards||Object.entries(items).some(([key,n])=>((acc.onlineItems||{})[key]||0)<n))return fail('Insufficient server wallet balance or items');
    const id=crypto.randomUUID();
    const reserved=await storage.transaction(async txn=>{
      const mine=await txn.get(acctKey);
      if(!mine||mine.onlineGold<gold||mine.onlineShards<shards||Object.entries(items).some(([key,n])=>((mine.onlineItems||{})[key]||0)<n))return false;
      mine.onlineGold-=gold;mine.onlineShards-=shards;
      mine.onlineItems=walletItems(mine);for(const [k,n] of Object.entries(items))mine.onlineItems[k]-=n;
      await txn.put(acctKey,mine);
      await txn.put('offer:'+id,{id,from:user,to:target,gold,shards,items,wantGold,wantShards,wantItems,status:'open',created:Date.now()});
      return true;
    });
    return reserved?respond({ok:true,id}):fail('Balance changed; reload wallet',409);
  }
  if(op==='trade.inbox') {
    const offers=[...(await storage.list({prefix:'offer:'})).values()];
    return respond({ok:true,offers:offers.filter(o=>(o.to===user||o.from===user)).sort((a,b)=>b.created-a.created).slice(0,40),onlineGold:acc.onlineGold,onlineShards:acc.onlineShards,onlineItems:walletItems(acc),itemNames:ONLINE_ITEM_NAMES});
  }
  if(op==='trade.respond') {
    const id=String(b.id||'');const action=String(b.action||'');
    if(!/^[0-9a-f-]{36}$/.test(id)||!['accept','decline','cancel'].includes(action))return fail('Invalid trade response');
    const o=await storage.get('offer:'+id);if(!o||o.status!=='open')return fail('Trade already closed',409);
    if(action==='cancel'&&o.from!==user)return fail('Sender only',403);
    if(action!=='cancel'&&o.to!==user)return fail('Recipient only',403);
    // Durable Object storage transaction prevents duplicate acceptance/return.
    const result=await storage.transaction(async txn=>{
      const deal=await txn.get('offer:'+id);if(!deal||deal.status!=='open')return null;
      if(action==='accept'){
        const buyer=await txn.get('acct:'+deal.to),seller=await txn.get('acct:'+deal.from);
        if(!buyer||!seller)return null;
        const reqItems=deal.wantItems||{};
        const reqGold=deal.wantGold||0,reqShards=deal.wantShards||0;
        if(buyer.onlineGold<reqGold||buyer.onlineShards<reqShards||Object.entries(reqItems).some(([k,n])=>((buyer.onlineItems||{})[k]||0)<n))return 'insufficient';
        buyer.onlineGold=buyer.onlineGold-reqGold+deal.gold;buyer.onlineShards=buyer.onlineShards-reqShards+deal.shards;
        seller.onlineGold+=reqGold;seller.onlineShards+=reqShards;
        buyer.onlineItems=walletItems(buyer);seller.onlineItems=walletItems(seller);
        for(const [k,n] of Object.entries(deal.items||{}))buyer.onlineItems[k]+=n;
        for(const [k,n] of Object.entries(reqItems)){buyer.onlineItems[k]-=n;seller.onlineItems[k]+=n;}
        await txn.put('acct:'+deal.to,buyer);await txn.put('acct:'+deal.from,seller);
      }else{
        const sender=await txn.get('acct:'+deal.from);if(!sender)return null;
        sender.onlineGold+=deal.gold;sender.onlineShards+=deal.shards;
        sender.onlineItems=walletItems(sender);
        for(const [k,n] of Object.entries(deal.items||{}))sender.onlineItems[k]+=n;
        await txn.put('acct:'+deal.from,sender);
      }
      deal.status=action;deal.closed=Date.now();await txn.put('offer:'+id,deal);
      return deal;
    });
    return result==='insufficient'?fail('ผู้รับมีเครดิต/ไอเทมออนไลน์ไม่พอสำหรับข้อแลกเปลี่ยน',409):result?respond({ok:true,offer:result}):fail('Trade no longer available',409);
  }
  return fail('Unknown request',404);
}
