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
  db.prepare("CREATE TABLE IF NOT EXISTS fails(k TEXT PRIMARY KEY,n INTEGER,t INTEGER)")]);
 try{await db.prepare("ALTER TABLE users ADD COLUMN phone TEXT").run()}catch{}
 ready=true}
async function sess(db,env,req){
 const m=(req.headers.get("cookie")||"").match(/(?:^|;\s*)mm=([a-f0-9]{48})/);if(!m)return null;
 const s=await db.prepare("SELECT s.uid,s.role,s.exp,u.name,u.email,u.status FROM sessions s LEFT JOIN users u ON u.id=s.uid WHERE s.token=?").bind(m[1]).first();
 if(!s||s.exp<Date.now())return null;
 if(s.role==="admin")return{role:"admin",uid:0,name:"Developer",email:String(env.ADMIN_EMAIL||"")};
 if(s.status!=="approved")return null;
 return{role:"user",uid:s.uid,name:s.name,email:s.email}}
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
async function handle(request,env){
 if(!env.DB)return J({error:"no_db"},503);
 await ensure(env.DB);const db=env.DB;
 const FK=String(env.FOOTBALL_DATA_KEY||"").trim(),AE=String(env.ADMIN_EMAIL||"").trim().toLowerCase(),AP=String(env.ADMIN_PASSWORD||"").trim();
 const url=new URL(request.url),p=url.pathname.replace(/^\/api\/?/,"").replace(/\/$/,""),m=request.method;
 if(m!=="GET"){const o=request.headers.get("origin");if(o&&new URL(o).host!==url.host)return J({error:"forbidden"},403)}
 let b={};if(m==="POST"){try{b=await request.json()}catch{b={}}}
 const me=await sess(db,env,request);
 if(p==="register"&&m==="POST"){
  const name=clip(b.name,60).trim(),email=clip(b.email,120).trim().toLowerCase(),pw=String(b.password||""),code=clip(b.code,10).trim().toUpperCase();let ph=clip(b.phone,20).replace(/[\s\-()]/g,"").replace(/^\+/,"");if(/^0[17]\d{8}$/.test(ph))ph="254"+ph.slice(1);
  if(name.length<2)return J({error:"bad_name"},400);
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return J({error:"bad_email"},400);
  if(pw.length<8||pw.length>200)return J({error:"bad_password"},400);
  if(!/^[A-Z0-9]{10}$/.test(code))return J({error:"bad_code"},400);
  if(!/^254[17]\d{8}$/.test(ph))return J({error:"bad_phone"},400);
  if(await db.prepare("SELECT 1 FROM users WHERE email=?").bind(email).first())return J({error:"email_taken"},409);
  if(await db.prepare("SELECT 1 FROM users WHERE mpesa=?").bind(code).first())return J({error:"code_used"},409);
  const salt=rnd(16);
  try{await db.prepare("INSERT INTO users(name,email,salt,hash,status,mpesa,created,phone) VALUES(?,?,?,?,?,?,?,?)").bind(name,email,salt,await pbk(pw,salt),"pending",code,Date.now(),ph).run()}catch{return J({error:"email_taken"},409)}
  return J({ok:true})}
 if(p==="login"&&m==="POST"){
  const em=clip(b.email,120).trim().toLowerCase(),pw=String(b.password||"").slice(0,200);
  if(await blocked(db,em))return J({error:"slow"},429);
  let role,uid=0;
  if(AE&&AP&&eq(em,AE)&&eq(pw.trim(),AP)){role="admin"}
  else{const u=await db.prepare("SELECT * FROM users WHERE email=?").bind(em).first();
   if(!u||!eq(await pbk(pw,u.salt),u.hash)){await fail(db,em);return J({error:"bad",admin_set:!!(AE&&AP)},401)}
   if(u.status!=="approved")return J({error:u.status,name:u.name,code:u.mpesa},403);
   role="user";uid=u.id}
  await db.prepare("DELETE FROM fails WHERE k=?").bind(em).run();
  await db.prepare("DELETE FROM sessions WHERE exp<?").bind(Date.now()).run();
  const tok=rnd(24);await db.prepare("INSERT INTO sessions(token,uid,role,exp) VALUES(?,?,?,?)").bind(tok,uid,role,Date.now()+2592e6).run();
  const who=role==="admin"?{role,name:"Developer",email:AE}:await db.prepare("SELECT 'user' role,name,email FROM users WHERE id=?").bind(uid).first();
  return J(who,200,{"set-cookie":`mm=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`})}
 if(p==="logout"&&m==="POST"){
  const c=(request.headers.get("cookie")||"").match(/(?:^|;\s*)mm=([a-f0-9]{48})/);if(c)await db.prepare("DELETE FROM sessions WHERE token=?").bind(c[1]).run();
  return J({ok:true},200,{"set-cookie":"mm=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"})}
 if(!me)return J({error:"login"},401);
 if(p==="me")return J({role:me.role,name:me.name,email:me.email});
 if(p==="data"){const r=await db.prepare("SELECT v FROM settings WHERE k='data'").first();return new Response(r?r.v:JSON.stringify(BUNDLED),{headers:{"content-type":"application/json","cache-control":"no-store"}})}
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
  if(p==="admin/users"){const r=await db.prepare("SELECT u.id,u.name,u.email,u.status,u.mpesa,u.phone,u.created,(SELECT COUNT(*) FROM saves s WHERE s.uid=u.id) n FROM users u ORDER BY u.created DESC LIMIT 500").all();return J({users:r.results||[]})}
  if(p==="admin/status"&&m==="POST"){if(!["approved","rejected","pending"].includes(b.status))return J({error:"bad"},400);
   await db.prepare("UPDATE users SET status=? WHERE id=?").bind(b.status,+b.id||0).run();
   if(b.status!=="approved")await db.prepare("DELETE FROM sessions WHERE uid=?").bind(+b.id||0).run();return J({ok:true})}
  if(p==="admin/delete"&&m==="POST"){const id=+b.id||0;await db.batch([db.prepare("DELETE FROM saves WHERE uid=?").bind(id),db.prepare("DELETE FROM sessions WHERE uid=?").bind(id),db.prepare("DELETE FROM users WHERE id=?").bind(id)]);return J({ok:true})}
  if(p==="admin/data"&&m==="POST"){const d=b.data;
   if(!d||typeof d!=="object"||!Object.values(d).every(l=>l&&l.t&&Array.isArray(l.r)&&Array.isArray(l.f)))return J({error:"bad_format"},400);
   const v=JSON.stringify(d);if(v.length>400000)return J({error:"too_big"},413);
   await db.prepare("INSERT INTO settings(k,v) VALUES('data',?1) ON CONFLICT(k) DO UPDATE SET v=?1").bind(v).run();return J({ok:true})}}
 return J({error:"not_found"},404)}
export default{async fetch(request,env){const p=new URL(request.url).pathname;if(p==="/api"||p.startsWith("/api/"))return handle(request,env);return new Response("Not found",{status:404})}};
