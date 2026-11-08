// Server-only auction house. All prices and stock are settled in the account Durable Object.
export const ITEM_LABELS=Object.freeze({
 monster_core:'แกนมอนสเตอร์',boss_relic:'ตราบอส',arena_medal:'เหรียญประลอง',
 iron_blade:'ดาบเหล็กออนไลน์',arcane_staff:'คทาเวทออนไลน์',guardian_plate:'เกราะผู้พิทักษ์',
 swift_ring:'แหวนว่องไว',wildfang_bow:'ธนูเขี้ยวป่า'
});
const accountKey=user=>'acct:'+user;
const iCount=(value,max=1000000)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const validItem=k=>Object.hasOwn(ITEM_LABELS,k);
const getItems=acc=>Object.fromEntries(Object.keys(ITEM_LABELS).map(k=>[k,Math.max(0,acc.onlineItems?.[k]||0)]));
const addItems=(acc,key,n)=>{acc.onlineItems=getItems(acc);acc.onlineItems[key]=Math.max(0,acc.onlineItems[key]+n);};
const goodUser=user=>/^[a-z0-9_]{3,20}$/.test(String(user));
const api=(body,status=200)=>Response.json(body,{status,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Cache-Control':'no-store'}});
const nope=(why,code=400)=>api({ok:false,error:why},code);
const MS_DAY=86400000;

// Auction expiry is settled even without visitors, using a DO storage alarm.
export async function settleAuctions(ctx){
 const storage=ctx.storage,now=Date.now(),all=await storage.list({prefix:'auction:'});
 let next=0;
 for(const [key,lot] of all){
  if(lot.status!=='active')continue;
  if(lot.expires>now){if(!next||lot.expires<next)next=lot.expires;continue;}
  await storage.transaction(async t=>{
   const l=await t.get(key);if(!l||l.status!=='active'||l.expires>Date.now())return;
   if(l.bidder){
    const buyer=await t.get(accountKey(l.bidder)),seller=await t.get(accountKey(l.seller));
    if(!buyer||!seller)return;
    addItems(buyer,l.item,l.qty);
    seller.onlineGold+=Math.floor(l.bid*0.95);
    await t.put(accountKey(l.bidder),buyer);await t.put(accountKey(l.seller),seller);
    l.status='sold';l.soldTo=l.bidder;l.finalPrice=l.bid;
   } else {
    const seller=await t.get(accountKey(l.seller));if(!seller)return;
    addItems(seller,l.item,l.qty);await t.put(accountKey(l.seller),seller);
    l.status='expired';
   }
   l.closed=Date.now();await t.put(key,l);
  });
 }
 if(next){await storage.setAlarm(Math.max(Date.now()+1000,next));}
}

export async function economyAction(ctx,user,b){
 const storage=ctx.storage,op=String(b.op||'');
 if(op==='market.list'){
  await settleAuctions(ctx);
  const all=[...(await storage.list({prefix:'auction:'})).values()];
  return api({ok:true,lots:all.filter(a=>a.status==='active').sort((a,b)=>a.expires-b.expires).slice(0,80),
    mine:all.filter(a=>a.seller===user||a.bidder===user).sort((a,b)=>b.created-a.created).slice(0,30),items:ITEM_LABELS});
 }
 if(op==='market.sell'){
  const item=String(b.item||''),qty=Number(b.qty),minBid=Number(b.minBid),buyout=Number(b.buyout);
  if(!validItem(item)||!iCount(qty,100)||qty<1||!iCount(minBid)||minBid<1||!iCount(buyout)||buyout<minBid)return nope('ข้อมูลขายไม่ถูกต้อง');
  const id=crypto.randomUUID(),now=Date.now();
  const result=await storage.transaction(async t=>{
   const active=[...(await t.list({prefix:'auction:'})).values()].filter(o=>o.seller===user&&o.status==='active');
   if(active.length>=10)return false;
   const acc=await t.get(accountKey(user));if(!acc||getItems(acc)[item]<qty)return false;
   addItems(acc,item,-qty);await t.put(accountKey(user),acc);
   await t.put('auction:'+id,{id,item,qty,seller:user,minBid,buyout,bid:0,bidder:null,created:now,expires:now+MS_DAY,status:'active'});
   return true;
  });
  if(!result)return nope('ไอเทมออนไลน์ไม่พอ หรือมีรายการขายครบ 10 รายการแล้ว',409);
  await storage.setAlarm(Math.max(now+1000,Math.min((await storage.getAlarm())||Infinity,now+MS_DAY)));
  return api({ok:true,id});
 }
 if(op==='market.bid'){
  const id=String(b.id||''),price=Number(b.price);
  if(!/^[0-9a-f-]{36}$/.test(id)||!iCount(price)||price<=0)return nope('ข้อมูลประมูลไม่ถูกต้อง');
  const result=await storage.transaction(async t=>{
   const lot=await t.get('auction:'+id);if(!lot||lot.status!=='active'||lot.expires<=Date.now()||lot.seller===user)return 'closed';
   if(price<Math.max(lot.minBid,lot.bid+1)||price>=lot.buyout)return 'low';
   const me=await t.get(accountKey(user));const delta=lot.bidder===user?price-lot.bid:price;
   if(!me||me.onlineGold<delta)return 'money';
   me.onlineGold-=delta;await t.put(accountKey(user),me);
   if(lot.bidder&&lot.bidder!==user){const prior=await t.get(accountKey(lot.bidder));if(prior){prior.onlineGold+=lot.bid;await t.put(accountKey(lot.bidder),prior);}}
   lot.bid=price;lot.bidder=user;await t.put('auction:'+id,lot);return 'ok';
  });
  return result==='ok'?api({ok:true}):nope({closed:'รายการนี้ปิดแล้ว',low:'ราคาประมูลต่ำเกินไป',money:'เครดิตออนไลน์ไม่พอ'}[result]||'บันทึกไม่สำเร็จ',409);
 }
 if(op==='market.buy'){
  const id=String(b.id||'');if(!/^[0-9a-f-]{36}$/.test(id))return nope('รหัสรายการผิด');
  const result=await storage.transaction(async t=>{
   const lot=await t.get('auction:'+id);if(!lot||lot.status!=='active'||lot.expires<=Date.now()||lot.seller===user)return 'closed';
   const me=await t.get(accountKey(user)),seller=await t.get(accountKey(lot.seller));
   if(!me||!seller||me.onlineGold<lot.buyout)return 'money';
   me.onlineGold-=lot.buyout;addItems(me,lot.item,lot.qty);
   seller.onlineGold+=Math.floor(lot.buyout*.95);
   if(lot.bidder){const prior=await t.get(accountKey(lot.bidder));if(prior){prior.onlineGold+=lot.bid;await t.put(accountKey(lot.bidder),prior);}}
   lot.status='sold';lot.soldTo=user;lot.finalPrice=lot.buyout;lot.closed=Date.now();
   await t.put(accountKey(user),me);await t.put(accountKey(lot.seller),seller);await t.put('auction:'+id,lot);
   return 'ok';
  });
  return result==='ok'?api({ok:true}):nope(result==='money'?'เครดิตออนไลน์ไม่พอ':'รายการนี้ไม่มีแล้ว',409);
 }
 if(op==='market.cancel'){
  const id=String(b.id||'');if(!/^[0-9a-f-]{36}$/.test(id))return nope('รหัสรายการผิด');
  const result=await storage.transaction(async t=>{
   const lot=await t.get('auction:'+id);if(!lot||lot.seller!==user||lot.status!=='active'||lot.bidder)return false;
   const seller=await t.get(accountKey(user));if(!seller)return false;
   addItems(seller,lot.item,lot.qty);lot.status='cancelled';lot.closed=Date.now();
   await t.put(accountKey(user),seller);await t.put('auction:'+id,lot);return true;
  });
  return result?api({ok:true}):nope('ยกเลิกไม่ได้ (อาจมีผู้ประมูลแล้ว)',409);
 }
 return nope('Unknown market operation',404);
}

// INTERNAL ONLY: the public worker never forwards /internal/economy to a DO.
// Called by authenticated room servers after checking websocket/session ownership.
export async function internalEconomy(ctx,b){
 const room=String(b.room||'');
 if(String(b.op||'').startsWith('ground.')){
  if(!/^s[1-4]-[a-z0-9_.-]{1,30}$/.test(room))return nope('Invalid map');
  const prefix='ground:'+room+':';
  if(b.op==='ground.list'){
   const items=await ctx.storage.list({prefix});
   return api({ok:true,drops:[...items.values()].filter(d=>d.expires>Date.now()).slice(0,60)});
  }
  const id=String(b.id||''),user=String(b.user||'');
  if(!/^[0-9a-f-]{36}$/.test(id)||!goodUser(user))return nope('Bad ground request');
  if(b.op==='ground.drop'){
   const item=String(b.item||''),qty=Number(b.qty),x=Number(b.x),y=Number(b.y);
   if(!validItem(item)||!iCount(qty,20)||qty<1||!Number.isFinite(x)||!Number.isFinite(y))return nope('Bad ground item');
   const created=await ctx.storage.transaction(async t=>{
    if(await t.get(prefix+id))return null;
    const current=await t.list({prefix});if(current.size>=60)return null;
    const a=await t.get(accountKey(user));if(!a||getItems(a)[item]<qty)return null;
    addItems(a,item,-qty);
    const drop={id,item,qty,x,y,owner:user,room,created:Date.now(),expires:Date.now()+12*3600000};
    await t.put(accountKey(user),a);await t.put(prefix+id,drop);return drop;
   });
   return created?api({ok:true,drop:created}):nope('ไอเทมออนไลน์ไม่พอ หรือของบนพื้นเต็ม',409);
  }
  if(b.op==='ground.pick'){
   const result=await ctx.storage.transaction(async t=>{
    const drop=await t.get(prefix+id);if(!drop||drop.expires<Date.now())return null;
    const a=await t.get(accountKey(user));if(!a)return null;
    addItems(a,drop.item,drop.qty);await t.put(accountKey(user),a);await t.delete(prefix+id);
    return drop;
   });
   return result?api({ok:true,drop:result}):nope('ไอเทมบนพื้นถูกรับไปแล้ว',404);
  }
  return nope('Invalid ground action');
 }
 const user=String(b.user||''),item=String(b.item||''),qty=Number(b.qty);
 if(!goodUser(user)||!validItem(item)||!iCount(qty,100)||qty<1)return nope('Invalid item or account');
 const give=b.op==='credit',debit=b.op==='debit';if(!give&&!debit)return nope('Invalid action');
 const receiptId=String(b.receipt||'');if(!/^[0-9a-f-]{36}$/.test(receiptId))return nope('Invalid receipt');
 const changed=await ctx.storage.transaction(async t=>{
  const receiptKey='econ:'+b.op+':'+receiptId;
  if(await t.get(receiptKey))return true;
  const acc=await t.get(accountKey(user));if(!acc)return false;
  if(debit&&getItems(acc)[item]<qty)return false;
  addItems(acc,item,give?qty:-qty);await t.put(accountKey(user),acc);await t.put(receiptKey,{user,item,qty,at:Date.now()});return true;
 });
 return changed?api({ok:true}):nope('Not enough online inventory',409);
}
