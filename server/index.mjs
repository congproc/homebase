import {requestAccess,socketUid} from './access.mjs';
import {config,ROOT} from './config.mjs';
import {getPowerState,savePowerSettings} from './services.mjs';
import {getTraffic,updateControl} from './traffic.mjs';
import {checkAlerts,getAlerts,unreadAlerts,updateAlerts} from './alerts.mjs';
import {readGpus} from './gpu.mjs';
import {readDisks} from './disks.mjs';
import {getDesktop,desktopAction} from './desktop.mjs';
import {VERSION,applyUpdate,checkForUpdate,startUpdateChecks,updateAvailable,updateStatus} from './update.mjs';
import {tmuxNew,tmuxKill,serviceAction,startAgent,stopAgent,SESSION_NAME} from './actions.mjs';
import http from 'node:http';
import os from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
const exec = promisify(execFile);
const token = randomBytes(32).toString('hex');
const run = async (bin,args=[]) => { try { const {stdout}=await exec(bin,args,{timeout:6000,maxBuffer:2*1024*1024}); return {ok:true,output:stdout.trim()}; } catch(e) {return {ok:false,output:'',error:e.code==='ENOENT'?'Not installed':e.stderr?.trim() || e.message};} };
let previous=os.cpus(), history=[], snapshot, collecting=false;
const events=[];
// Sleep periods since boot from kernel log (cached 60s). Totals come from clocks: BOOTTIME includes suspend, MONOTONIC excludes it.
let sleepCache={at:0,periods:[]};
async function sleepPeriods(){
 if(Date.now()-sleepCache.at<60000)return sleepCache.periods;
 const r=await run('journalctl',['-b','-k','--no-pager','-o','short-unix','--grep','PM: suspend (entry|exit)']);
 const periods=[];let open=null;
 for(const line of r.output.split('\n')){const t=Number(line.split(' ')[0])*1000;if(!t)continue;if(line.includes('suspend entry'))open=t;else if(line.includes('suspend exit')&&open){periods.push({from:open,to:t});open=null;}}
 sleepCache={at:Date.now(),periods};return periods;
}
const record=(message)=>{events.unshift({message,at:Date.now()});events.splice(30);};
record('Local monitoring started');
async function collect(){
 if(collecting)return;collecting=true;
 try{
 const now=os.cpus();let idle=0,total=0;now.forEach((c,i)=>{let p=previous[i]||c;idle+=c.times.idle-p.times.idle;for(const k in c.times)total+=c.times[k]-p.times[k];});previous=now;
 const cpu=total?Math.round((1-idle/total)*1000)/10:0;
 const [docker,tmux,ps,df,models,net,mem,installed,gpu,disks]=await Promise.all([
 run('docker',['ps','-a','--format','{{json .}}']),run('tmux',['list-sessions','-F','#{session_windows}|#{session_attached}|#{session_created}|#{session_name}']),run('ps',['-eo','pid,pcpu,pmem,etimes,comm','--sort=-pcpu']),run('df',['-B1','/']),fetch('http://127.0.0.1:11434/api/ps',{signal:AbortSignal.timeout(2500)}).then(r=>r.ok?r.json():Promise.reject()).catch(()=>null),readFile('/proc/net/dev','utf8').catch(()=>''),readFile('/proc/meminfo','utf8').catch(()=>''),Promise.all(['claude','codex','ollama'].map(n=>run('which',[n]))),readGpus(),readDisks().catch(e=>({available:false,error:e.message,items:[]}))
 ]);
 // comm goes last: names can contain spaces ("tmux: server"), which used to shift the numeric columns into NaN.
 const processes=ps.output.split('\n').slice(1).map(s=>{const [pid,cpu,memory,elapsed,...name]=s.trim().split(/\s+/);return {pid:Number(pid),name:name.join(' '),cpu:Number(cpu)||0,memory:Number(memory)||0,elapsed:Number(elapsed)||0};}).filter(p=>Number.isInteger(p.pid)&&p.name);
 const available=Number(mem.match(/MemAvailable:\s+(\d+)/)?.[1]||os.freemem()/1024)*1024;
 const memory={used:os.totalmem()-available,total:os.totalmem(),percent:Math.round((1-available/os.totalmem())*100)};
 const diskLine=df.output.split('\n')[1]?.trim().split(/\s+/);const disk=diskLine?{total:Number(diskLine[1]),used:Number(diskLine[2]),percent:parseInt(diskLine[4])}:null;
 const network=net.split('\n').slice(2).filter(l=>!l.trim().startsWith('lo:')).reduce((a,l)=>{const v=l.split(':')[1]?.trim().split(/\s+/);if(v){a.rx+=Number(v[0]);a.tx+=Number(v[8]);}return a;},{rx:0,tx:0});
 const t=Date.now();
 // After a gap (idle pause, suspend) there is no fair baseline for rates; the chart draws the gap as a break.
 const last=history.at(-1),old=last&&t-last.at<=30000?last:undefined;const point={at:t,cpu,memory:memory.percent,rx:network.rx,tx:network.tx,download:old?Math.max(0,(network.rx-old.rx)/((t-old.at)/1000)):0,upload:old?Math.max(0,(network.tx-old.tx)/((t-old.at)/1000)):0,...(gpu.items[0]?{gpu:gpu.items[0].utilization,vram:gpu.items[0].memory?.percent??null}:{})};history.push(point);history=history.filter(p=>t-p.at<=15*60*1000).slice(-180);
 const boottime=os.uptime(),monotonic=Number(process.hrtime.bigint())/1e9,periods=await sleepPeriods().catch(()=>[]);
 const sleep={awake:monotonic,asleep:Math.max(0,boottime-monotonic),bootAt:t-boottime*1000,count:periods.length,periods:periods.slice(-14)};
 snapshot={at:t,sleep,hostname:os.hostname(),user:os.userInfo().username,platform:`${os.type()} ${os.release()}`,cpuModel:now[0]?.model,cores:now.length,cpu,memory,disk,uptime:os.uptime(),load:os.loadavg(),network:point,history,interfaces:Object.entries(os.networkInterfaces()).flatMap(([name,list])=>(list||[]).filter(a=>!a.internal&&a.family==='IPv4').map(a=>({name,address:a.address}))),containers:{available:docker.ok,error:docker.error,items:docker.output?docker.output.split('\n').map(l=>JSON.parse(l)):[]},sessions:{available:tmux.ok||tmux.error?.includes('no server running')||tmux.error?.includes('No such file'),error:tmux.error,items:tmux.output?tmux.output.split('\n').map(l=>{const [windows,attached,created,...rest]=l.split('|');return {name:rest.join('|'),windows:Number(windows),attached:Number(attached),created:Number(created)}}).filter(s=>s.name):[]},agents:['claude','codex','ollama'].map((name,i)=>({name,installed:installed[i].ok,processes:processes.filter(p=>p.name.toLowerCase().includes(name))})),models:models?.models||[],ollamaOnline:!!models,processes:processes.slice(0,12),gpu,disks:{...disks,setupCommand:config.setupCommand},events};
 }finally{collecting=false;}
}
// Security alerts are checked in the background even when no dashboard is open (cheap: incremental log reads).
await checkAlerts();setInterval(()=>{checkAlerts();},20000).unref();
// Idle pause: only collect while a dashboard has asked for status recently. Hidden tabs stop polling, so they count as idle.
const IDLE_AFTER=20000;let lastViewed=0;
startUpdateChecks();
await collect();setInterval(()=>{
 if(Date.now()-lastViewed>IDLE_AFTER)return;
 collect().catch(()=>{});
},5000).unref();
// Called on every API request; refreshes a stale snapshot before answering so the first view after a pause is current.
async function markViewed(){
 lastViewed=Date.now();
 if(Date.now()-(snapshot?.at||0)>6000)await collect().catch(()=>{});
}
// Applied to every response: no framing (clickjacking), no MIME sniffing, no referrer leakage, strict resource origins.
const SECURITY_HEADERS={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"};
const send=(res,status,data)=>{res.writeHead(status,{...SECURITY_HEADERS,'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
 try{
 const access=requestAccess(req.headers,{uid:await socketUid(req.socket)});if(!access.allowed)return send(res,403,{error:access.error});
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
 await markViewed();

 if(req.method==='GET'&&url.pathname==='/api/power')return send(res,200,await getPowerState());
 if(req.method==='GET'&&url.pathname==='/api/desktop')return send(res,200,await getDesktop());
 if(req.method==='GET'&&url.pathname==='/api/alerts'){await checkAlerts();return send(res,200,await getAlerts());}
 if(req.method==='GET'&&url.pathname==='/api/traffic')return send(res,200,await getTraffic(url.searchParams.get('site')||undefined,url.searchParams.get('range')||undefined));
 if(req.method==='GET'&&url.pathname==='/api/status')return send(res,200,{...snapshot,token,version:VERSION,updateAvailable:updateAvailable(),alertsUnread:await unreadAlerts().catch(()=>0)});
 if(req.method==='GET'&&url.pathname==='/api/update')return send(res,200,await updateStatus());
 if(req.method==='POST'&&['/api/action','/api/power','/api/traffic/control','/api/alerts','/api/update'].includes(url.pathname)){
 const supplied=Buffer.from(String(req.headers['x-server-token']||''));const expected=Buffer.from(token);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(res,403,{error:'Refresh the dashboard and try again'});
 if(!/^application\/json\b/i.test(req.headers['content-type']||''))return send(res,415,{error:'Expected application/json'});
 let body='';for await(const chunk of req){body+=chunk;if(body.length>32768)return send(res,413,{error:'Request too large'});}let payload;try{payload=JSON.parse(body)}catch{return send(res,400,{error:'Invalid JSON'})}
 if(url.pathname==='/api/update'){try{
  if(payload.action==='check'){await checkForUpdate(true);return send(res,200,await updateStatus());}
  if(payload.action==='apply'){const st=await applyUpdate();record(`Updating Homebase to ${st.job?.version}`);return send(res,200,st);}
  return send(res,400,{error:'Unsupported action'});
 }catch(e){return send(res,400,{error:e.message})}}
 if(url.pathname==='/api/alerts'){try{return send(res,200,await updateAlerts(payload))}catch(e){return send(res,400,{error:e.message})}}
 if(url.pathname==='/api/traffic/control'){try{const c=await updateControl(payload);const {action,sid,ip}=payload;record(`traffic: ${action} ${sid||ip}`);return send(res,200,c)}catch(e){return send(res,400,{error:e.message})}}
 if(url.pathname==='/api/power'){try{const power=await savePowerSettings(payload);record('Sleep settings updated');return send(res,200,power)}catch(e){return send(res,400,{error:e.message})}}
 const {kind,id,action,pid}=payload;let result;
 if(kind==='desktop'){try{if(!['on','off'].includes(action))return send(res,400,{error:'Unsupported action'});const out=await desktopAction(action);record(`desktop: turned ${action}`);return send(res,200,out);}catch(e){return send(res,400,{error:e.message})}}
 if(kind==='service'||kind==='agent'){try{let out;
  if(kind==='service')out=await serviceAction(id,action);
  else if(action==='start'&&['claude','codex'].includes(id))out=await startAgent(snapshot,id);
  else if(action==='stop'&&['claude','codex'].includes(id)&&(pid===undefined||Number.isInteger(pid)))out=await stopAgent(snapshot,id,pid);
  else if(id==='ollama'&&['start','stop','restart'].includes(action))out=await serviceAction('system:ollama.service',action);
  else return send(res,400,{error:'Unsupported action'});
  record(`${kind}: ${action} ${id}${pid?` (PID ${pid})`:''}`);await collect();return send(res,200,out);
 }catch(e){return send(res,400,{error:e.message})}}
 if(kind==='docker'&&['start','stop','restart','logs'].includes(action)&&snapshot.containers.items.some(c=>c.ID===id))result=await run('docker',action==='logs'?['logs','--tail','80',id]:[action,id]);
 else if(kind==='tmux'&&action==='create'&&typeof id==='string'&&SESSION_NAME.test(id))result=await tmuxNew(id);
 else if(kind==='tmux'&&action==='kill'&&snapshot.sessions.items.some(s=>s.name===id))result=await tmuxKill(id);
 else if(kind==='tmux'&&action==='capture'&&snapshot.sessions.items.some(s=>s.name===id))result=await run('tmux',['capture-pane','-p','-t',`=${id}:`,'-S','-80']);
 else return send(res,400,{error:'Unsupported action or unknown resource'});
 if(!result.ok)return send(res,400,{error:result.error});if(action!=='logs'&&action!=='capture')record(`${kind}: ${action} ${id}`);await collect();return send(res,200,{output:result.output});
 }return send(res,404,{error:'Not found'});
 }
 const root=resolve(ROOT,'dist');const file=resolve(root,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(root+'/')&&file!==root)return send(res,403,{error:'Forbidden'});
 let target=file;try{if(!(await stat(target)).isFile())target=resolve(root,'index.html')}catch{target=resolve(root,'index.html')}
 const data=await readFile(target);const ext=extname(target);
 const type=({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json','.json':'application/json','.woff2':'font/woff2'})[ext]||'application/octet-stream';
 // Hashed build assets never change; everything else (index.html, icons) revalidates so a rebuild shows up immediately.
 const cache=url.pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache';
 res.writeHead(200,{...SECURITY_HEADERS,'Content-Type':type,'Cache-Control':cache});res.end(data);
 }catch{send(res,500,{error:'Unable to complete request'});}
});server.listen(config.port,'127.0.0.1',()=>console.log(`Homebase agent: http://127.0.0.1:${config.port}`));
