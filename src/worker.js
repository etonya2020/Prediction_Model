// Ettylinks Matchday Prediction Model: server side (Cloudflare Worker + D1). Games for any date are loaded from football-data.org.
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
  db.prepare("CREATE TABLE IF NOT EXISTS calls(t INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS preds(mid INTEGER PRIMARY KEY,comp TEXT,cn TEXT,ko INTEGER,src TEXT,at INTEGER,data TEXT,gh INTEGER,ga INTEGER,top REAL,rh INTEGER,dh INTEGER,bh INTEGER,oh INTEGER)"),
  db.prepare("CREATE INDEX IF NOT EXISTS preds_ko ON preds(ko)")]);
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
const clip=(v,n)=>String(v??"").slice(0,n);
// ---------- Football feed (football-data.org), model and track record ----------
const FDURL="https://api.football-data.org/v4";
const ORDER=["PL","PD","SA","BL1","FL1","ELC","DED","PPL","BSA","CL","EC","WC"];
const LEAGUES=new Set(["PL","PD","SA","BL1","FL1","ELC","DED","PPL","BSA"]);
const DAY=864e5;
const dstr=ms=>new Date(ms).toISOString().slice(0,10);
const R4=x=>Math.round(x*1e4)/1e4;
// Day window in UTC for a calendar date in the visitor's timezone (tz = minutes ahead of UTC, Nairobi = 180)
function dayWindow(date,tz){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date||""))return null;
 const s=Date.parse(date+"T00:00:00Z");if(isNaN(s)||dstr(s)!==date)return null;
 const y=+date.slice(0,4);if(y<2000||y>2100)return null;
 tz=Math.round(+tz||0);if(tz<-840||tz>840)tz=0;
 const a=s-tz*6e4;return[a,a+DAY]}
// Rate budget: the free football-data plan allows 10 calls a minute, shared by every user and the scheduled job
async function budget(db){const r=await db.prepare("SELECT COUNT(*) n FROM calls WHERE t>?").bind(Date.now()-6e4).first();return Math.max(0,9-(r?+r.n:0))}
async function fdGet(env,C,path){
 if(C.left<=0){C.limited=true;return{ok:false,status:429}}
 C.left--;C.used.push(Date.now());
 let r;try{r=await fetch(FDURL+path,{headers:{"X-Auth-Token":env.FOOTBALL_DATA_KEY}})}catch(e){return{ok:false,status:0,msg:String(e&&e.message||e).slice(0,200)}}
 if(r.status===429){C.limited=true;C.left=0}
 if(!r.ok){let msg="";try{const e=await r.json();msg=String(e.message||e.error||"").slice(0,200)}catch{}return{ok:false,status:r.status,msg}}
 try{return{ok:true,j:await r.json()}}catch{return{ok:false,status:0,msg:"unreadable answer"}}}
async function cacheGet(db,keys){const out={};if(!keys.length)return out;
 const r=await db.prepare("SELECT k,v FROM settings WHERE k IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(keys)).all();
 for(const x of r.results||[]){try{out[x.k]=JSON.parse(x.v)}catch{}}return out}
const cachePut=(db,k,o)=>db.prepare("INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=?2").bind(k,JSON.stringify(o));
// Score over 90 minutes (the markets are 90-minute markets): ignore extra time and penalties
function score(x){const s=x.score||{},f=s.fullTime||{},r=s.regularTime||{},use=s.duration&&s.duration!=="REGULAR"&&r.home!=null&&r.away!=null?r:f;
 return[use.home==null?null:+use.home,use.away==null?null:+use.away]}
function compact(x){const c=x.competition||{},h=x.homeTeam||{},a=x.awayTeam||{},se=x.season||{},sc=score(x),sy=se.startDate?+String(se.startDate).slice(0,4):null;
 return{id:x.id,t:Date.parse(x.utcDate),s:x.status,m:typeof x.minute==="number"?x.minute:null,c:c.code||"",cn:c.name||c.code||"",sy:sy&&sy>1990?sy:null,
  hi:h.id??null,hn:h.shortName||h.name||"Home",ai:a.id??null,an:a.shortName||a.name||"Away",gh:sc[0],ga:sc[1]}}
const seasonKey=(c,sy)=>"season:"+c+":"+(sy||"cur");
// ---- model (same maths as the page: shrunk goal rates, form, rest, injuries slider, Dixon-Coles style Poisson grid)
const FACT=[1,1,2,6,24,120,720,5040,40320];
const pois=(k,l)=>Math.exp(-l)*Math.pow(l,k)/FACT[k];
const tau=(i,j,a,b,r)=>i==0&&j==0?1-a*b*r:i==0&&j==1?1+a*r:i==1&&j==0?1+b*r:i==1&&j==1?1-r:1;
function calc(p,hn,an){
 const K=5,AV=(p.LH+p.LA)/2,s=(f,n)=>((f+K*AV)/(n+K))/AV;
 let lh=p.LH*s(p.hf,p.hg)*s(p.aa,p.ag),la=p.LA*s(p.af,p.ag)*s(p.ha,p.hg);
 lh*=(1+(p.hp-7)*0.012)*p.FH*(1-p.hi/100);la*=(1+(p.ap-7)*0.012)*p.FA*(1-p.ai/100);
 const M=[];let t=0,h=0,d=0,a=0,bt=0,o25=0,sc=[],i,j;
 for(i=0;i<9;i++){M[i]=[];for(j=0;j<9;j++){M[i][j]=pois(i,lh)*pois(j,la)*tau(i,j,lh,la,-0.1);t+=M[i][j]}}
 for(i=0;i<9;i++)for(j=0;j<9;j++){const q=M[i][j]/t;if(i>j)h+=q;else if(i==j)d+=q;else a+=q;if(i>0&&j>0)bt+=q;if(i+j>2)o25+=q;sc.push([i+"-"+j,q])}
 sc.sort((x,y)=>y[1]-x[1]);
 const dc=[["1X","1X ("+hn+" or draw)",h+d],["X2","X2 ("+an+" or draw)",d+a],["12","12 (no draw)",h+a]].sort((x,y)=>y[2]-x[2])[0],top=Math.max(h,d,a);
 return{h:R4(h),d:R4(d),a:R4(a),bt:R4(bt),o25:R4(o25),lh:R4(lh),la:R4(la),sc:sc.slice(0,5).map(x=>[x[0],R4(x[1])]),dk:dc[0],dc:dc[1],dcp:R4(dc[2]),top:R4(top),
  side:top==h?hn+" win":top==a?an+" win":"Draw",key:top==h?"H":top==a?"A":"D"}}
// Hit or miss of a recorded prediction against the 90-minute score
function evalGame(r,hs,as){const act=hs>as?"H":hs==as?"D":"A";
 return{act,res:r.key==act,dc:r.dk=="1X"?act!="A":r.dk=="X2"?act!="H":act!="D",bt:(r.bt>=0.5)==(hs>0&&as>0),ov:(r.o25>=0.5)==(hs+as>2)}}
// Season history sorted once per request: finished games by kick-off, running goal totals and a per-team index
const PREP=new WeakMap();
function prep(S){let P=PREP.get(S);if(P)return P;
 const F=(S.m||[]).filter(x=>x[2]==="FINISHED"&&x[5]!=null&&x[6]!=null).sort((a,b)=>a[1]-b[1]),ch=[0],ca=[0],T={};
 F.forEach((x,i)=>{ch.push(ch[i]+x[5]);ca.push(ca[i]+x[6]);(T[x[3]]||(T[x[3]]=[])).push(i);(T[x[4]]||(T[x[4]]=[])).push(i)});
 P={F,ch,ca,T};PREP.set(S,P);return P}
// Build the prediction for one game using ONLY games of the same competition that had finished before kick-off (kicked off 2+ hours earlier)
function predict(S,g){
 if(g.hi==null||g.ai==null||!Array.isArray(S.m))return null;
 const P=prep(S),F=P.F;let lo=0,hi=F.length;
 while(lo<hi){const mid=(lo+hi)>>1;if(F[mid][1]+72e5<=g.t)lo=mid+1;else hi=mid}
 const k=lo,LH=(P.ch[k]+15)/(k+10),LA=(P.ca[k]+12)/(k+10);
 const league=LEAGUES.has(g.c);let rank={};
 if(league){const T={};const row=id=>T[id]||(T[id]={id,pts:0,gd:0,gf:0});
  for(let i=0;i<k;i++){const x=F[i],h=row(x[3]),a=row(x[4]);h.gf+=x[5];a.gf+=x[6];h.gd+=x[5]-x[6];a.gd+=x[6]-x[5];if(x[5]>x[6])h.pts+=3;else if(x[5]<x[6])a.pts+=3;else{h.pts++;a.pts++}}
  Object.values(T).sort((p,q)=>q.pts-p.pts||q.gd-p.gd||q.gf-p.gf).forEach((r,i)=>{rank[r.id]=i+1})}
 const nm=id=>S.names&&S.names[id]||"Team";
 function team(id,name){
  const ms=(P.T[id]||[]).filter(i=>i<k).map(i=>F[i]),rec=ms.slice(-6);
  let pts=0,rp=0,gf=0,ga=0;const lines=[];
  ms.forEach(x=>{const home=x[3]===id,f=home?x[5]:x[6],a=home?x[6]:x[5];pts+=f>a?3:f==a?1:0});
  rec.forEach(x=>{const home=x[3]===id,f=home?x[5]:x[6],a=home?x[6]:x[5];gf+=f;ga+=a;rp+=f>a?3:f==a?1:0;lines.push((f>a?"W":f==a?"D":"L")+" "+f+"-"+a+(home?" v ":" at ")+nm(home?x[4]:x[3]))});
  const ppg=ms.length?pts/ms.length:1.35,wp=rec.length?rp/rec.length:ppg,form=5*(0.5*ppg+0.5*wp);
  const prev=ms.length?(g.t-ms[ms.length-1][1])/DAY:null;
  let nx=null;for(const x of S.m){if(x[0]!==g.id&&x[1]>g.t&&(x[2]==="SCHEDULED"||x[2]==="TIMED")&&(x[3]===id||x[4]===id)&&(!nx||x[1]<nx[1]))nx=x}
  const nd=nx?(nx[1]-g.t)/DAY:null;let fat=1;const flags=[];
  if(prev!==null&&prev<3.5){fat*=0.97;flags.push("only "+Math.round(prev)+" days of rest")}
  if(nd!==null&&nd<3.5){fat*=0.98;flags.push("plays again in "+Math.round(nd)+" days, so rotation is possible")}
  return{name,n:rec.length,gf,ga,form,fat,ctx:{name,rank:rank[id]||null,pts,gp:ms.length,lines:lines.slice(-4),flags,next:nx?nm(nx[3]===id?nx[4]:nx[3])+(nx[3]===id?" (home) ":" (away) ")+dstr(nx[1]):"none scheduled"}}}
 const h=team(g.hi,g.hn),a=team(g.ai,g.an);
 const inp={hf:h.gf,hg:h.n,ha:h.ga,hp:+h.form.toFixed(2),hi:0,af:a.gf,ag:a.n,aa:a.ga,ap:+a.form.toFixed(2),ai:0,LH:+LH.toFixed(3),LA:+LA.toFixed(3),FH:h.fat,FA:a.fat};
 return{...calc(inp,g.hn,g.an),inp,ctx:{h:h.ctx,a:a.ctx}}}
// Load the games of a window, make or refresh predictions before kick-off, and settle finished games
async function gamesFor(env,db,ws,we){
 const now=Date.now(),C={left:await budget(db),used:[],limited:false},writes=[];let stale=false,failed=null;
 try{
  const liveTtl=Math.max(30,+env.LIVE_TTL||60)*1000,dkey="day:"+dstr(ws-DAY)+":"+dstr(we+DAY);
  const dttl=we<now-2*DAY?432e5:ws>now+2*DAY?9e5:liveTtl;
  let c=(await cacheGet(db,[dkey]))[dkey],day=c&&c.matches;
  if(!c||now-c.at>dttl){
   const r=await fdGet(env,C,"/matches?dateFrom="+dstr(ws-DAY)+"&dateTo="+dstr(we+DAY));
   if(r.ok){day=(r.j.matches||[]).map(compact).filter(x=>!isNaN(x.t));writes.push(cachePut(db,dkey,{at:now,matches:day}))}
   else if(day)stale=true;else{failed={error:r.status===429?"rate":r.status===401||r.status===403?"key":"api",status:r.status,detail:r.msg||""};day=null}}
  if(!day)return{...failed,games:[],pending:[]};
  const win=day.filter(x=>x.t>=ws&&x.t<we).sort((p,q)=>p.t-q.t||ORDER.indexOf(p.c)-ORDER.indexOf(q.c));
  // season history for each competition in the window
  const groups=[],seen=new Set();
  win.forEach(x=>{const k=seasonKey(x.c,x.sy);if(!seen.has(k)){seen.add(k);groups.push({k,c:x.c,sy:x.sy})}});
  groups.sort((p,q)=>(ORDER.indexOf(p.c)<0?99:ORDER.indexOf(p.c))-(ORDER.indexOf(q.c)<0?99:ORDER.indexOf(q.c)));
  const SC=await cacheGet(db,groups.map(g=>g.k)),fresh=we>now-4*DAY&&ws<now+4*DAY;
  const need=groups.filter(g=>{const e=SC[g.k];if(!e)return true;const ttl=e.end&&e.end<now?6048e5:fresh?18e5:432e5;return now-e.at>ttl}).slice(0,Math.max(0,C.left));
  const got=await Promise.all(need.map(async g=>({g,r:await fdGet(env,C,"/competitions/"+g.c+"/matches"+(g.sy?"?season="+g.sy:""))})));
  got.forEach(({g,r})=>{
   if(r.ok){const names={},m=[];let end=0;
    (r.j.matches||[]).forEach(x=>{const k=compact(x);if(isNaN(k.t))return;if(k.hi!=null)names[k.hi]=k.hn;if(k.ai!=null)names[k.ai]=k.an;m.push([k.id,k.t,k.s,k.hi,k.ai,k.gh,k.ga]);
     const e=x.season&&x.season.endDate?Date.parse(x.season.endDate):0;if(e>end)end=e});
    SC[g.k]={at:now,end,names,m};writes.push(cachePut(db,g.k,SC[g.k]))}
   else if(SC[g.k])stale=true});
  const pending=groups.filter(g=>!SC[g.k]).map(g=>g.c);
  const ids=win.map(x=>x.id),ex={};
  if(ids.length){const r=await db.prepare("SELECT mid,src,data,gh,ga,at FROM preds WHERE mid IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(ids)).all();
   for(const x of r.results||[]){try{ex[x.mid]={src:x.src,p:JSON.parse(x.data),gh:x.gh,ga:x.ga,at:x.at}}catch{}}}
  const rows=[],games=[];
  for(const g of win){
   const pre=g.s==="SCHEDULED"||g.s==="TIMED",open=pre||g.s==="IN_PLAY"||g.s==="PAUSED",done=g.s==="FINISHED"&&g.gh!=null&&g.ga!=null;
   const S=SC[seasonKey(g.c,g.sy)],e=ex[g.id];let p=null,src=null,dirty=false;
   if(e){p=e.p;src=e.src;
    if(pre&&g.t>now&&S&&S.at>e.at){const q=predict(S,g);if(q&&JSON.stringify(q)!==JSON.stringify(p)){p=q;src="live";dirty=true}}
    else if(src==="back"&&!done&&open&&S&&g.t>now){/* unreachable: rescheduled games fall in the branch above */}}
   else if((open||done)&&S){const q=predict(S,g);if(q){p=q;src=g.t>now?"live":"back";dirty=true}}
   let ev=null;
   if(p&&done){ev=evalGame(p,g.gh,g.ga);
    if(!e||e.gh!==g.gh||e.ga!==g.ga)dirty=true}
   if(p&&dirty)rows.push({mid:g.id,comp:g.c,cn:g.cn,ko:g.t,src,at:now,data:JSON.stringify(p),gh:done?g.gh:null,ga:done?g.ga:null,top:p.top,
    rh:ev?+ev.res:null,dh:ev?+ev.dc:null,bh:ev?+ev.bt:null,oh:ev?+ev.ov:null});
   games.push({id:g.id,c:g.c,cn:g.cn,t:new Date(g.t).toISOString(),s:g.s,m:g.m,h:{i:g.hi,n:g.hn},a:{i:g.ai,n:g.an},hs:g.gh,as:g.ga,p,src:p?src:null,ev})}
  for(let i=0;i<rows.length;i+=40)writes.push(db.prepare(
   "INSERT INTO preds(mid,comp,cn,ko,src,at,data,gh,ga,top,rh,dh,bh,oh) SELECT json_extract(value,'$.mid'),json_extract(value,'$.comp'),json_extract(value,'$.cn'),json_extract(value,'$.ko'),json_extract(value,'$.src'),json_extract(value,'$.at'),json_extract(value,'$.data'),json_extract(value,'$.gh'),json_extract(value,'$.ga'),json_extract(value,'$.top'),json_extract(value,'$.rh'),json_extract(value,'$.dh'),json_extract(value,'$.bh'),json_extract(value,'$.oh') FROM json_each(?1) WHERE 1 ON CONFLICT(mid) DO UPDATE SET comp=excluded.comp,cn=excluded.cn,ko=excluded.ko,src=excluded.src,at=excluded.at,data=excluded.data,gh=excluded.gh,ga=excluded.ga,top=excluded.top,rh=excluded.rh,dh=excluded.dh,bh=excluded.bh,oh=excluded.oh").bind(JSON.stringify(rows.slice(i,i+40))));
  return{at:now,games,pending,stale,limited:C.limited}
 }finally{
  if(C.used.length)writes.push(db.prepare("INSERT INTO calls(t) SELECT value FROM json_each(?1) WHERE 1").bind(JSON.stringify(C.used)));
  writes.push(db.prepare("DELETE FROM calls WHERE t<?").bind(now-12e4));
  try{await db.batch(writes)}catch{}}}
// Scheduled job: keeps pre-match predictions fresh and settles finished games even when nobody has the page open
async function cron(env){if(!env.DB||!env.FOOTBALL_DATA_KEY)return;await ensure(env.DB);const n=Date.now();await gamesFor(env,env.DB,n-36*36e5,n+48*36e5)}

// ---- Where to watch: official broadcaster links per competition, editable by the developer (https links only)
const SS=[{t:"SuperSport on DStv Stream / GOtv Stream / Showmax (paid)",u:"https://www.dstv.com"},{t:"Possibly free-to-air on TV47 / SportyTV: check the game is shown",u:""}];
const WDEF={PL:SS,PD:SS,SA:SS,CL:SS};
function cleanWatch(o){
 if(!o||typeof o!=="object"||Array.isArray(o))return{err:"bad"};
 const out={};let n=0;
 for(const k of Object.keys(o)){
  if(!/^[A-Z0-9]{2,5}$/.test(k)||++n>30)continue;
  const arr=Array.isArray(o[k])?o[k]:[];out[k]=[];
  for(const x of arr.slice(0,5)){
   const t=clip(x&&x.t,70).trim();let u=clip(x&&x.u,300).trim();if(!t)continue;
   if(u){let q;try{q=new URL(u)}catch{return{err:"bad_url",label:t}}if(q.protocol!=="https:")return{err:"bad_url",label:t};u=q.href}
   out[k].push({t,u})}}
 return{ok:out}}
async function getWatch(db){const c=(await cacheGet(db,["watch"])).watch;return c&&c.v&&typeof c.v==="object"?c.v:WDEF}

async function handle(request,env){
 if(!env.DB)return J({error:"no_db"},503);
 await ensure(env.DB);const db=env.DB;
 const AE=String(env.ADMIN_EMAIL||"").trim().toLowerCase(),AP=String(env.ADMIN_PASSWORD||"").trim();
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
 if(p==="games"&&m==="GET"){
  if(!env.FOOTBALL_DATA_KEY)return J({error:"no_key"},503);
  const w=dayWindow(url.searchParams.get("date"),url.searchParams.get("tz"));if(!w)return J({error:"bad_date"},400);
  const out=await gamesFor(env,db,w[0],w[1]);return J(out,out.error?(out.error==="rate"?429:502):200)}
 if(p==="watch"&&m==="GET")return J({links:await getWatch(db)});
 if(p==="record"&&m==="GET"){
  const days=Math.min(Math.max(parseInt(url.searchParams.get("days"))||0,0),3650),since=days?Date.now()-days*DAY:0;
  const r=await db.prepare("SELECT src,comp,cn,COUNT(*) n,SUM(rh) res,SUM(dh) dc,SUM(bh) bt,SUM(oh) ov,SUM(CASE WHEN top>=0.55 THEN 1 ELSE 0 END) sn,SUM(CASE WHEN top>=0.55 THEN rh ELSE 0 END) sr FROM preds WHERE gh IS NOT NULL AND ko>=?1 GROUP BY src,comp,cn").bind(since).all();
  return J({days,rows:r.results||[]})}
 if(p==="save"&&m==="POST"&&me.role==="user"){
  const it={t:+b.t||Date.now(),d:clip(b.d,12),l:clip(b.l,40),m:clip(b.m,120),p:clip(b.p,80),h:+b.h||0,x:+b.x||0,a:+b.a||0,dc:clip(b.dc,80),bt:+b.bt||0,o:+b.o||0};
  await db.prepare("INSERT INTO saves(uid,data,created) VALUES(?,?,?)").bind(me.uid,JSON.stringify(it),Date.now()).run();
  await db.prepare("DELETE FROM saves WHERE uid=?1 AND id NOT IN (SELECT id FROM saves WHERE uid=?1 ORDER BY id DESC LIMIT 50)").bind(me.uid).run();
  return J({ok:true})}
 if(p==="saves"&&m==="GET"){const r=await db.prepare("SELECT id,data FROM saves WHERE uid=? ORDER BY id DESC LIMIT 50").bind(me.uid).all();return J({items:(r.results||[]).map(x=>({id:x.id,...JSON.parse(x.data)}))})}
 if(p==="saves"&&m==="DELETE"){await db.prepare("DELETE FROM saves WHERE id=? AND uid=?").bind(+url.searchParams.get("id")||0,me.uid).run();return J({ok:true})}
 if(p.startsWith("admin/")){
  if(me.role!=="admin")return J({error:"forbidden"},403);
  if(p==="admin/users"){const r=await db.prepare("SELECT u.id,u.name,u.email,u.status,u.mpesa,u.phone,u.created,(SELECT COUNT(*) FROM saves s WHERE s.uid=u.id) n FROM users u ORDER BY u.created DESC LIMIT 500").all();return J({users:r.results||[]})}
  if(p==="admin/watch"&&m==="POST"){
   if(b.reset===true){await db.prepare("DELETE FROM settings WHERE k='watch'").run();return J({ok:true,links:WDEF})}
   const c=cleanWatch(b.links);if(c.err)return J({error:c.err,label:c.label||""},400);
   await cachePut(db,"watch",{v:c.ok}).run();return J({ok:true,links:c.ok})}
  if(p==="admin/status"&&m==="POST"){if(!["approved","rejected","pending"].includes(b.status))return J({error:"bad"},400);
   await db.prepare("UPDATE users SET status=? WHERE id=?").bind(b.status,+b.id||0).run();
   if(b.status!=="approved")await db.prepare("DELETE FROM sessions WHERE uid=?").bind(+b.id||0).run();return J({ok:true})}
  if(p==="admin/delete"&&m==="POST"){const id=+b.id||0;await db.batch([db.prepare("DELETE FROM saves WHERE uid=?").bind(id),db.prepare("DELETE FROM sessions WHERE uid=?").bind(id),db.prepare("DELETE FROM users WHERE id=?").bind(id)]);return J({ok:true})}}
 return J({error:"not_found"},404)}
export default{async fetch(request,env){const p=new URL(request.url).pathname;if(p==="/api"||p.startsWith("/api/"))return handle(request,env);return new Response("Not found",{status:404})},
 async scheduled(event,env,ctx){ctx.waitUntil(cron(env).catch(()=>{}))}};
