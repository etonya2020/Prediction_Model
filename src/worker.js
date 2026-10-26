import BUNDLED from "./data.json";
// Ettylinks Matchday Prediction Model: server side (Cloudflare Pages Functions + D1).
const J=(o,s=200,h={})=>new Response(JSON.stringify(o),{status:s,headers:{"content-type":"application/json","cache-control":"no-store",...h}});
const enc=new TextEncoder();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
const rnd=n=>hex(crypto.getRandomValues(new Uint8Array(n)));
async function pbk(pw,salt){const k=await crypto.subtle.importKey("raw",enc.encode(pw),"PBKDF2",false,["deriveBits"]);return hex(await crypto.subtle.deriveBits({name:"PBKDF2",salt:enc.encode(salt),iterations:100000,hash:"SHA-256"},k,256))}
function eq(a,b){a=String(a);b=String(b);if(a.length!==b.length)return false;let r=0;for(let i=0;i<a.length;i++)r|=a.charCodeAt(i)^b.charCodeAt(i);return r===0}
let ready=false;
async function ensure(db){if(ready)return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,email TEXT UNIQUE,salt TEXT,hash TEXT,status TEXT,mpesa TEXT UNIQUE,created INTEGER,phone TEXT)"),
  db.prepare("CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid INTEGER,role TEXT,exp INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS saves(id INTEGER PRIMARY KEY AUTOINCREMENT,uid INTEGER,data TEXT,created INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT)"),
  db.prepare("CREATE TABLE IF NOT EXISTS fails(k TEXT PRIMARY KEY,n INTEGER,t INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS ai_use(uid INTEGER,day TEXT,n INTEGER,PRIMARY KEY(uid,day))"),
  db.prepare("CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT,uid INTEGER,plan TEXT,amount INTEGER,mpesa TEXT UNIQUE,status TEXT,created INTEGER,decided INTEGER)")]);
 for(const c of ["phone TEXT","plan TEXT","expires INTEGER","pending_ms INTEGER","lifetime INTEGER","last_login INTEGER"]){try{await db.prepare("ALTER TABLE users ADD COLUMN "+c).run()}catch{}}
 // one-time upgrade of accounts made before plans existed: old approved members become permanent, old payments are recorded
 if(!(await db.prepare("SELECT 1 FROM settings WHERE k='plans_migrated'").first())){
  await db.batch([
   db.prepare("UPDATE users SET plan='legacy',lifetime=1 WHERE status='approved' AND plan IS NULL"),
   db.prepare("INSERT OR IGNORE INTO payments(uid,plan,amount,mpesa,status,created,decided) SELECT u.id,'legacy',30,u.mpesa,CASE u.status WHEN 'approved' THEN 'confirmed' WHEN 'rejected' THEN 'rejected' ELSE 'pending' END,u.created,u.created FROM users u WHERE u.mpesa IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.uid=u.id)"),
   db.prepare("INSERT INTO settings(k,v) VALUES('plans_migrated','1') ON CONFLICT(k) DO NOTHING")])}
 ready=true}
async function sess(db,env,req){
 const m=(req.headers.get("cookie")||"").match(/(?:^|;\s*)mm=([a-f0-9]{48})/);if(!m)return null;
 const s=await db.prepare("SELECT uid,role,exp FROM sessions WHERE token=?").bind(m[1]).first();
 if(!s||s.exp<Date.now())return null;
 if(s.role==="admin")return{role:"admin",uid:0,name:"Developer",email:String(env.ADMIN_EMAIL||""),active:true};
 const v=await userView(db,s.uid);if(!v||v.status!=="approved")return null;
 return{...v,uid:s.uid}}
const blocked=async(db,k)=>{const r=await db.prepare("SELECT n,t FROM fails WHERE k=?").bind(k).first();return !!r&&r.n>=8&&Date.now()-r.t<9e5};
const fail=(db,k)=>db.prepare("INSERT INTO fails(k,n,t) VALUES(?1,1,?2) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN ?2-t>900000 THEN 1 ELSE n+1 END,t=?2").bind(k,Date.now()).run();
async function fd(env,path){const key=String(env.FOOTBALL_DATA_KEY||"").trim();let r;try{r=await fetch("https://api.football-data.org/v4"+path,{headers:{"X-Auth-Token":key}})}catch{return{ok:false,status:0}}let j=null;if(r.ok){try{j=await r.json()}catch{}}return{ok:r.ok&&!!j,status:r.status,j}}
async function cached(db,key,ttl,make){
 const c=await db.prepare("SELECT v FROM settings WHERE k=?").bind(key).first();let old=null;
 if(c){try{old=JSON.parse(c.v);if(Date.now()-old.at<ttl)return{out:old.out}}catch{old=null}}
 const o=await make();
 if(!o.ok){if(old)return{out:{...old.out,stale:true}};return{err:o.status===429?"rate":"api",status:o.status}}
 await db.prepare("INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=?2").bind(key,JSON.stringify({at:Date.now(),out:o.out})).run();return{out:o.out}}
const nm=x=>x||{};
const mapMatch=x=>({id:x.id,t:x.utcDate,s:x.status,m:typeof x.minute==="number"?x.minute:null,c:nm(x.competition).code,cn:nm(x.competition).name,h:nm(x.homeTeam).id,a:nm(x.awayTeam).id,hn:nm(x.homeTeam).shortName||nm(x.homeTeam).name,an:nm(x.awayTeam).shortName||nm(x.awayTeam).name,hs:x.score?.fullTime?.home??null,as:x.score?.fullTime?.away??null});
const clip=(v,n)=>String(v??"").slice(0,n);
const PLAN_DEF={day:{name:"24 hours",ms:864e5,price:30},week:{name:"Weekly (7 days)",ms:6048e5,price:150},month:{name:"Monthly (30 days)",ms:2592e6,price:500},year:{name:"Yearly (365 days)",ms:31536e6,price:4500},life:{name:"Permanent member",ms:0,price:10000}};
async function getPlans(db){const r=await db.prepare("SELECT v FROM settings WHERE k='plans'").first();let o={};try{o=r?JSON.parse(r.v):{}}catch{}
 const P={};for(const [id,d] of Object.entries(PLAN_DEF)){const s=o[id]||{},pr=Math.round(+s.price);P[id]={id,name:d.name,ms:d.ms,perm:id==="life",price:pr>0&&pr<=1e6?pr:d.price,on:s.on!==false}}return P}
// starts the clock the first time a user is seen after approval, so approval delays never eat into their time
async function userView(db,uid){
 const u=await db.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();if(!u)return null;const now=Date.now();
 if(u.pending_ms>0){u.expires=now+u.pending_ms;await db.prepare("UPDATE users SET expires=?,pending_ms=0 WHERE id=?").bind(u.expires,uid).run()}
 return{role:"user",name:u.name,email:u.email,status:u.status,plan:u.plan,lifetime:!!u.lifetime,expires:u.lifetime?null:(u.expires||null),active:!!(u.lifetime||(u.expires&&u.expires>now))}}
async function grant(db,uid,planId,P){
 const u=await db.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();if(!u)return;const now=Date.now();
 if(planId==="life"||planId==="legacy"){await db.prepare("UPDATE users SET status='approved',plan=?,lifetime=1,expires=NULL,pending_ms=0 WHERE id=?").bind(planId,uid).run();return}
 const ms=P[planId]?P[planId].ms:0;if(!ms)return;
 if(u.lifetime){await db.prepare("UPDATE users SET status='approved' WHERE id=?").bind(uid).run();return}
 if(u.expires&&u.expires>now)await db.prepare("UPDATE users SET status='approved',plan=?,expires=expires+? WHERE id=?").bind(planId,ms,uid).run();
 else await db.prepare("UPDATE users SET status='approved',plan=?,pending_ms=COALESCE(pending_ms,0)+? WHERE id=?").bind(planId,ms,uid).run()}
async function codeUsed(db,code){return !!(await db.prepare("SELECT 1 FROM users WHERE mpesa=?").bind(code).first())||!!(await db.prepare("SELECT 1 FROM payments WHERE mpesa=?").bind(code).first())}
async function handle(request,env){
 if(!env.DB)return J({error:"no_db"},503);
 await ensure(env.DB);const db=env.DB;
 const FK=String(env.FOOTBALL_DATA_KEY||"").trim(),AE=String(env.ADMIN_EMAIL||"").trim().toLowerCase(),AP=String(env.ADMIN_PASSWORD||"").trim();
 const url=new URL(request.url),p=url.pathname.replace(/^\/api\/?/,"").replace(/\/$/,""),m=request.method;
 if(m!=="GET"){const o=request.headers.get("origin");if(o&&new URL(o).host!==url.host)return J({error:"forbidden"},403)}
 let b={};if(m==="POST"){try{b=await request.json()}catch{b={}}}
 const me=await sess(db,env,request);
 if(p==="plans"&&m==="GET"){const P=await getPlans(db);return J({plans:Object.values(P).filter(x=>x.on).map(({id,name,price,perm,ms})=>({id,name,price,perm,ms}))})}
 if(p==="register"&&m==="POST"){
  const name=clip(b.name,60).trim(),email=clip(b.email,120).trim().toLowerCase(),pw=String(b.password||""),code=clip(b.code,10).trim().toUpperCase();let ph=clip(b.phone,20).replace(/[\s\-()]/g,"").replace(/^\+/,"");if(/^0[17]\d{8}$/.test(ph))ph="254"+ph.slice(1);
  const P=await getPlans(db),plan=P[String(b.plan||"")];
  if(name.length<2)return J({error:"bad_name"},400);
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return J({error:"bad_email"},400);
  if(pw.length<8||pw.length>200)return J({error:"bad_password"},400);
  if(!plan||!plan.on)return J({error:"bad_plan"},400);
  if(!/^[A-Z0-9]{10}$/.test(code))return J({error:"bad_code"},400);
  if(!/^254[17]\d{8}$/.test(ph))return J({error:"bad_phone"},400);
  if(await db.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first())return J({error:"email_taken"},409);
  if(await codeUsed(db,code))return J({error:"code_used"},409);
  const salt=rnd(16);
  try{await db.batch([db.prepare("INSERT INTO users(name,email,salt,hash,status,mpesa,created,phone) VALUES(?,?,?,?,?,?,?,?)").bind(name,email,salt,await pbk(pw,salt),"pending",code,Date.now(),ph),
   db.prepare("INSERT INTO payments(uid,plan,amount,mpesa,status,created) SELECT id,?1,?2,?3,'pending',?4 FROM users WHERE email=?5").bind(plan.id,plan.price,code,Date.now(),email)])}catch{return J({error:"email_taken"},409)}
  return J({ok:true})}
 if(p==="login"&&m==="POST"){
  const em=clip(b.email,120).trim().toLowerCase(),pw=String(b.password||"").slice(0,200);
  if(await blocked(db,em))return J({error:"slow"},429);
  let role,uid=0;
  if(AE&&AP&&eq(em,AE)&&eq(pw.trim(),AP)){role="admin"}
  else{const u=await db.prepare("SELECT * FROM users WHERE email=?").bind(em).first();
   if(!u||!eq(await pbk(pw,u.salt),u.hash)){await fail(db,em);return J({error:"bad",admin_set:!!(AE&&AP)},401)}
   if(u.status!=="approved"){const lp=await db.prepare("SELECT plan,amount FROM payments WHERE uid=? ORDER BY id DESC LIMIT 1").bind(u.id).first()||{};return J({error:u.status,name:u.name,code:u.mpesa,plan:lp.plan,amount:lp.amount},403)}
   role="user";uid=u.id}
  await db.prepare("DELETE FROM fails WHERE k=?").bind(em).run();
  await db.prepare("DELETE FROM sessions WHERE exp<?").bind(Date.now()).run();
  const tok=rnd(24);await db.prepare("INSERT INTO sessions(token,uid,role,exp) VALUES(?,?,?,?)").bind(tok,uid,role,Date.now()+2592e6).run();
  if(role==="user")await db.prepare("UPDATE users SET last_login=? WHERE id=?").bind(Date.now(),uid).run();
  const who=role==="admin"?{role,name:"Developer",email:AE,active:true}:await userView(db,uid);
  return J(who,200,{"set-cookie":`mm=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`})}
 if(p==="logout"&&m==="POST"){
  const c=(request.headers.get("cookie")||"").match(/(?:^|;\s*)mm=([a-f0-9]{48})/);if(c)await db.prepare("DELETE FROM sessions WHERE token=?").bind(c[1]).run();
  return J({ok:true},200,{"set-cookie":"mm=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"})}
 if(!me)return J({error:"login"},401);
 if(me.role==="user"&&!me.active&&!["me","renew","mypayments"].includes(p))return J({error:"expired"},402);
 if(p==="me"){const o={role:me.role,name:me.name,email:me.email,active:me.active,plan:me.plan||null,lifetime:!!me.lifetime,expires:me.expires||null};
  if(me.role==="user")o.pending=(await db.prepare("SELECT COUNT(*) c FROM payments WHERE uid=? AND status='pending'").bind(me.uid).first()).c;return J(o)}
 if(p==="mypayments"&&m==="GET"){if(me.role!=="user")return J({items:[]});const r=await db.prepare("SELECT id,plan,amount,mpesa,status,created,decided FROM payments WHERE uid=? ORDER BY id DESC LIMIT 20").bind(me.uid).all();return J({items:r.results||[]})}
 if(p==="renew"&&m==="POST"){
  if(me.role!=="user")return J({error:"forbidden"},403);
  if(me.lifetime)return J({error:"already_permanent"},400);
  const P=await getPlans(db),plan=P[String(b.plan||"")];if(!plan||!plan.on)return J({error:"bad_plan"},400);
  const code=clip(b.code,10).trim().toUpperCase();if(!/^[A-Z0-9]{10}$/.test(code))return J({error:"bad_code"},400);
  if(await codeUsed(db,code))return J({error:"code_used"},409);
  const n=await db.prepare("SELECT COUNT(*) c FROM payments WHERE uid=? AND status='pending'").bind(me.uid).first();if(n.c>=3)return J({error:"too_many_pending"},429);
  try{await db.prepare("INSERT INTO payments(uid,plan,amount,mpesa,status,created) VALUES(?,?,?,?,'pending',?)").bind(me.uid,plan.id,plan.price,code,Date.now()).run()}catch{return J({error:"code_used"},409)}
  return J({ok:true})}
 if(p==="data"){const r=await db.prepare("SELECT v FROM settings WHERE k='data'").first();return new Response(r?r.v:JSON.stringify(BUNDLED),{headers:{"content-type":"application/json","cache-control":"no-store"}})}
const AI_SYS="You are a careful football analyst checking a statistical model's pre-match forecast. You receive JSON for one match, or for a list of picks (kind top10), with the model's probabilities, recent form and rest flags. For a list, name the shakiest pick in risks. You cannot see line-ups, injuries or live news unless they are in the JSON, so never invent them. Judge only whether the model's double-chance, favourite-win and both-teams-to-score picks look sound or fragile, and why (rotation, fixture congestion, derby or cup context, thin data, mismatch in league strength). Reply with ONLY a JSON object: {\"stance\":\"agree|caution|disagree\",\"confidence\":\"high|medium|low\",\"summary\":\"max 60 words\",\"risks\":[\"short risk\"]} with at most 4 risks. Never claim certainty and never give staking advice.";
 if(p==="ai"&&m==="POST"){
  const AK=String(env.ANTHROPIC_API_KEY||"").trim();if(!AK)return J({error:"no_ai_key"});
  const ctx=JSON.stringify(b.ctx||{});if(ctx.length<20||ctx.length>8000)return J({error:"bad_ctx"},400);
  const key="ai:"+hex(await crypto.subtle.digest("SHA-256",enc.encode(ctx)));
  const c=await db.prepare("SELECT v FROM settings WHERE k=?").bind(key).first();
  if(c){try{const o=JSON.parse(c.v);if(Date.now()-o.at<216e5)return J({...o.out,cached:true})}catch{}}
  const day=new Date().toISOString().slice(0,10),cap=+env.AI_PER_USER||15,gcap=+env.AI_DAILY_CAP||300;
  const u=await db.prepare("SELECT n FROM ai_use WHERE uid=? AND day=?").bind(me.uid,day).first(),tot=await db.prepare("SELECT COALESCE(SUM(n),0) s FROM ai_use WHERE day=?").bind(day).first();
  if((u?u.n:0)>=cap)return J({error:"user_limit",limit:cap},429);
  if(tot.s>=gcap)return J({error:"site_limit"},429);
  let r;try{r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":AK,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:String(env.AI_MODEL||"claude-sonnet-5-5").trim(),max_tokens:400,system:AI_SYS,messages:[{role:"user",content:ctx}]})})}catch{return J({error:"ai_unreachable"},502)}
  if(!r.ok){let mm="";try{mm=(await r.json()).error?.message||""}catch{}return J({error:"ai_error",status:r.status,message:String(mm).slice(0,160)},502)}
  const j=await r.json(),txt=(j.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("").trim();
  let o;try{o=JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g,""))}catch{o={summary:txt.slice(0,700)}}
  const out={stance:["agree","caution","disagree"].includes(o.stance)?o.stance:"caution",confidence:["high","medium","low"].includes(o.confidence)?o.confidence:"low",summary:clip(o.summary,700),risks:(Array.isArray(o.risks)?o.risks:[]).slice(0,4).map(x=>clip(x,160))};
  await db.prepare("INSERT INTO ai_use(uid,day,n) VALUES(?1,?2,1) ON CONFLICT(uid,day) DO UPDATE SET n=n+1").bind(me.uid,day).run();
  await db.prepare("INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=?2").bind(key,JSON.stringify({at:Date.now(),out})).run();
  return J(out)}
 if(p==="matches"&&m==="GET"){
  if(!FK)return J({error:"no_key"});
  const f=url.searchParams.get("from")||"",to=url.searchParams.get("to")||"",re=/^\d{4}-\d{2}-\d{2}$/;
  if(!re.test(f)||!re.test(to))return J({error:"bad_date"},400);
  const span=(Date.parse(to)-Date.parse(f))/864e5;if(!(span>=0&&span<=10))return J({error:"bad_range"},400);
  const iso=d=>new Date(d).toISOString().slice(0,10),near=to>=iso(Date.now()-864e5)&&f<=iso(Date.now()+864e5);
  const ttl=near?60e3:(to<iso(Date.now())?36e5:6e5);
  const r=await cached(db,"m:"+f+":"+to,ttl,async()=>{const o=await fd(env,`/matches?dateFrom=${f}&dateTo=${to}`);return o.ok?{ok:true,out:{at:Date.now(),matches:(o.j.matches||[]).map(mapMatch)}}:o});
  return r.err?J({error:r.err,status:r.status}):J(r.out)}
 if(p==="season"&&m==="GET"){
  if(!FK)return J({error:"no_key"});
  const code=(url.searchParams.get("code")||"").toUpperCase();if(!/^[A-Z0-9]{2,4}$/.test(code))return J({error:"bad_code"},400);
  const r=await cached(db,"s:"+code,108e5,async()=>{const o=await fd(env,`/competitions/${code}/matches?status=FINISHED`);if(!o.ok)return o;
   const teams={},res=[],since=Date.now()-15e9;
   for(const x of o.j.matches||[]){const h=x.homeTeam,a=x.awayTeam,s=x.score?.fullTime;if(!h?.id||!a?.id||s?.home==null||Date.parse(x.utcDate)<since)continue;teams[h.id]=h.shortName||h.name;teams[a.id]=a.shortName||a.name;res.push([x.utcDate,h.id,a.id,s.home,s.away])}
   return{ok:true,out:{at:Date.now(),code,name:o.j.competition?.name||code,teams,res}}});
  return r.err?J({error:r.err,status:r.status}):J(r.out)}
 if(p==="live"&&m==="GET"){
  if(!FK)return J({error:"no_key"});
  const ttl=Math.max(30,+env.LIVE_TTL||60)*1000,c=await db.prepare("SELECT v FROM settings WHERE k='live'").first();let old=null;
  if(c){try{old=JSON.parse(c.v);if(Date.now()-old.at<ttl)return J(old.out)}catch{old=null}}
  const iso=d=>new Date(d).toISOString().slice(0,10);
  let r;try{r=await fetch(`https://api.football-data.org/v4/matches?dateFrom=${iso(Date.now()-864e5)}&dateTo=${iso(Date.now()+864e5)}`,{headers:{"X-Auth-Token":FK}})}catch{r=null}
  if(!r||!r.ok){if(old)return J({...old.out,stale:true});return J({error:r&&r.status===429?"rate":"api",status:r?r.status:0})}
  const j=await r.json();
  const out={at:Date.now(),matches:(j.matches||[]).map(x=>({id:x.id,t:x.utcDate,s:x.status,m:typeof x.minute==="number"?x.minute:null,hid:nm(x.homeTeam).id,aid:nm(x.awayTeam).id,h:nm(x.homeTeam).shortName||nm(x.homeTeam).name,hn:nm(x.homeTeam).name,a:nm(x.awayTeam).shortName||nm(x.awayTeam).name,an:nm(x.awayTeam).name,hs:x.score?.fullTime?.home??null,as:x.score?.fullTime?.away??null,c:nm(x.competition).code,cn:nm(x.competition).name}))};
  await db.prepare("INSERT INTO settings(k,v) VALUES('live',?1) ON CONFLICT(k) DO UPDATE SET v=?1").bind(JSON.stringify({at:out.at,out})).run();
  return J(out)}
 if(p==="save"&&m==="POST"&&me.role==="user"){
  const it={t:+b.t||Date.now(),d:clip(b.d,12),l:clip(b.l,40),m:clip(b.m,120),p:clip(b.p,80),h:+b.h||0,x:+b.x||0,a:+b.a||0,dc:clip(b.dc,80),bt:+b.bt||0,o:+b.o||0};
  await db.prepare("INSERT INTO saves(uid,data,created) VALUES(?,?,?)").bind(me.uid,JSON.stringify(it),Date.now()).run();
  await db.prepare("DELETE FROM saves WHERE uid=?1 AND id NOT IN (SELECT id FROM saves WHERE uid=?1 ORDER BY id DESC LIMIT 50)").bind(me.uid).run();
  return J({ok:true})}
 if(p==="saves"&&m==="GET"){const r=await db.prepare("SELECT id,data FROM saves WHERE uid=? ORDER BY id DESC LIMIT 50").bind(me.uid).all();return J({items:(r.results||[]).map(x=>({id:x.id,...JSON.parse(x.data)}))})}
 if(p==="saves"&&m==="DELETE"){await db.prepare("DELETE FROM saves WHERE id=? AND uid=?").bind(+url.searchParams.get("id")||0,me.uid).run();return J({ok:true})}
 if(p.startsWith("admin/")){
  if(me.role!=="admin")return J({error:"forbidden"},403);
  if(p==="admin/feedtest"){
   if(!FK)return J({has_key:false});
   let r;try{r=await fetch("https://api.football-data.org/v4/competitions/PL",{headers:{"X-Auth-Token":FK}})}catch(e){return J({has_key:true,key_length:FK.length,status:0,message:"Could not reach football-data.org from the server: "+String(e&&e.message||e).slice(0,120)})}
   let msg="";try{const j=await r.json();msg=j.message||j.error||(j.name?"OK: "+j.name:"")}catch{}
   return J({has_key:true,key_length:FK.length,status:r.status,message:String(msg).slice(0,200)})}
  if(p==="admin/users"){const r=await db.prepare("SELECT u.id,u.name,u.email,u.status,u.mpesa,u.phone,u.created,u.plan,u.expires,u.lifetime,u.last_login,(SELECT COUNT(*) FROM saves s WHERE s.uid=u.id) n FROM users u ORDER BY u.created DESC LIMIT 500").all();return J({users:r.results||[]})}
  if(p==="admin/payment"&&m==="POST"){
   const pay=await db.prepare("SELECT * FROM payments WHERE id=?").bind(+b.id||0).first();if(!pay||pay.status!=="pending")return J({error:"not_pending"},400);
   if(b.decision!=="confirm"&&b.decision!=="reject")return J({error:"bad"},400);
   const okp=b.decision==="confirm";
   await db.prepare("UPDATE payments SET status=?,decided=? WHERE id=?").bind(okp?"confirmed":"rejected",Date.now(),pay.id).run();
   if(okp)await grant(db,pay.uid,pay.plan,await getPlans(db));else await db.prepare("UPDATE users SET status='rejected' WHERE id=? AND status='pending'").bind(pay.uid).run();
   return J({ok:true})}
  if(p==="admin/grant"&&m==="POST"){const P=await getPlans(db),id=+b.id||0;if(!(b.plan in P)||!(await db.prepare("SELECT 1 FROM users WHERE id=?").bind(id).first()))return J({error:"bad"},400);await grant(db,id,b.plan,P);return J({ok:true})}
  if(p==="admin/plans"){
   if(m==="POST"){const o={};for(const id of Object.keys(PLAN_DEF)){const s=(b.plans||{})[id];if(!s)continue;const pr=Math.round(+s.price);if(!(pr>0&&pr<=1e6))return J({error:"bad_price"},400);o[id]={price:pr,on:s.on!==false}}
    await db.prepare("INSERT INTO settings(k,v) VALUES('plans',?1) ON CONFLICT(k) DO UPDATE SET v=?1").bind(JSON.stringify(o)).run()}
   return J({plans:Object.values(await getPlans(db))})}
  if(p==="admin/report"&&m==="GET"){
   const re=/^\d{4}-\d{2}-\d{2}$/,iso=d=>new Date(d).toISOString().slice(0,10),off=Math.max(-840,Math.min(840,+url.searchParams.get("tz")||0));
   const f=url.searchParams.get("from")||iso(Date.now()-29*864e5),to=url.searchParams.get("to")||iso(Date.now());
   if(!re.test(f)||!re.test(to)||to<f)return J({error:"bad_date"},400);
   const a=Date.parse(f+"T00:00:00Z")-off*6e4,z=Date.parse(to+"T00:00:00Z")+864e5-off*6e4,now=Date.now();
   const SEL="SELECT p.id,p.uid,p.plan,p.amount,p.mpesa,p.status,p.created,p.decided,u.name,u.email,u.phone FROM payments p LEFT JOIN users u ON u.id=p.uid ";
   const pays=(await db.prepare(SEL+"WHERE p.created>=? AND p.created<? ORDER BY p.created DESC LIMIT 1000").bind(a,z).all()).results||[];
   const pending=(await db.prepare(SEL+"WHERE p.status='pending' ORDER BY p.created ASC LIMIT 200").all()).results||[];
   const users=(await db.prepare("SELECT u.id,u.name,u.email,u.phone,u.status,u.plan,u.expires,u.lifetime,u.created,u.last_login,(SELECT COUNT(*) FROM saves s WHERE s.uid=u.id) n FROM users u ORDER BY u.created DESC LIMIT 1000").all()).results||[];
   const conf=pays.filter(x=>x.status==="confirmed"),byPlan={},daily={};let revenue=0;
   for(const x of conf){revenue+=x.amount;(byPlan[x.plan]=byPlan[x.plan]||{n:0,sum:0});byPlan[x.plan].n++;byPlan[x.plan].sum+=x.amount;const d=iso(x.created+off*6e4);(daily[d]=daily[d]||{n:0,sum:0});daily[d].n++;daily[d].sum+=x.amount}
   const us={total:users.length,active:0,expired:0,permanent:0,pending:0,rejected:0,expiringSoon:0};
   for(const u of users){if(u.status==="pending")us.pending++;else if(u.status==="rejected")us.rejected++;else if(u.lifetime){us.permanent++;us.active++}else if(u.expires&&u.expires>now){us.active++;if(u.expires-now<2592e5)us.expiringSoon++}else us.expired++}
   return J({from:f,to,summary:{revenue,confirmed:conf.length,rejected:pays.filter(x=>x.status==="rejected").length,pendingCount:pending.length,pendingAmount:pending.reduce((s,x)=>s+x.amount,0),byPlan,daily,users:us},users,payments:pays,pending})}
  if(p==="admin/status"&&m==="POST"){if(!["approved","rejected","pending"].includes(b.status))return J({error:"bad"},400);
   if(b.status==="approved"){const pp=await db.prepare("SELECT * FROM payments WHERE uid=? AND status='pending' ORDER BY id DESC LIMIT 1").bind(+b.id||0).first();
    if(pp){await db.prepare("UPDATE payments SET status='confirmed',decided=? WHERE id=?").bind(Date.now(),pp.id).run();await grant(db,pp.uid,pp.plan,await getPlans(db))}}
   await db.prepare("UPDATE users SET status=? WHERE id=?").bind(b.status,+b.id||0).run();
   if(b.status!=="approved")await db.prepare("DELETE FROM sessions WHERE uid=?").bind(+b.id||0).run();return J({ok:true})}
  if(p==="admin/delete"&&m==="POST"){const id=+b.id||0;await db.batch([db.prepare("DELETE FROM saves WHERE uid=?").bind(id),db.prepare("DELETE FROM sessions WHERE uid=?").bind(id),db.prepare("DELETE FROM users WHERE id=?").bind(id)]);return J({ok:true})}
  if(p==="admin/data"&&m==="POST"){const d=b.data;
   if(!d||typeof d!=="object"||Array.isArray(d))return J({error:"bad_format"},400);
   const row=await db.prepare("SELECT v FROM settings WHERE k='data'").first();let cur;try{cur=row?JSON.parse(row.v):{...BUNDLED}}catch{cur={...BUNDLED}}
   for(const [k,l] of Object.entries(d)){
    if(!/^[A-Za-z0-9_]{1,12}$/.test(k))return J({error:"bad_key"},400);
    if(l===null){delete cur[k];continue}
    if(!(l&&l.t&&typeof l.t==="object"&&Array.isArray(l.r)&&Array.isArray(l.f)))return J({error:"bad_format"},400);
    cur[k]=l}
   const v=JSON.stringify(cur);if(v.length>400000)return J({error:"too_big"},413);
   await db.prepare("INSERT INTO settings(k,v) VALUES('data',?1) ON CONFLICT(k) DO UPDATE SET v=?1").bind(v).run();return J({ok:true})}}
 return J({error:"not_found"},404)}
export default{async fetch(request,env){const p=new URL(request.url).pathname;if(p==="/api"||p.startsWith("/api/"))return handle(request,env);return new Response("Not found",{status:404})}};
