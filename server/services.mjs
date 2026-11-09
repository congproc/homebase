import {readdir, readFile, access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import os from 'node:os';
import net from 'node:net';
// TCP-only liveness check, for services whose HTTP access log would record an HTTP probe as a visitor.
const tcpOpen=port=>new Promise(resolve=>{const c=net.connect({host:'127.0.0.1',port,timeout:2000});c.once('connect',()=>{c.destroy();resolve(true)});c.once('timeout',()=>{c.destroy();resolve(false)});c.once('error',()=>resolve(false));});
const exec=(file,args,input)=>new Promise(resolve=>{
 const child=execFile(file,args,{timeout:20000,maxBuffer:1024*1024},(error,stdout,stderr)=>resolve({ok:!error,output:stdout.trim(),error:error?(stderr.trim()||error.message):undefined}));
 if(input!==undefined)child.stdin.end(input);
});
const properties=['Result','ExecMainStatus','ExecMainStartTimestamp','ExecMainExitTimestamp','TriggeredBy','Id','Description','LoadState','ActiveState','SubState','MainPID','MemoryCurrent','CPUUsageNSec','ActiveEnterTimestamp','UnitFileState','Restart','Type'];
import {config as settings} from './config.mjs';
const known=settings.services;
let cached, lastRead=0;
async function inventory(){
 const scopes=[{scope:'user',directory:os.homedir()+'/.config/systemd/user'},{scope:'system',directory:'/etc/systemd/system'}];
 const entries=(await Promise.all(scopes.map(async({scope,directory})=>{
  const files=await readdir(directory,{withFileTypes:true}).catch(()=>[]);
  return files.filter(f=>f.isFile()&&/^[A-Za-z0-9_.-]+\.service$/.test(f.name)&&!settings.hiddenUnits.some(p=>f.name.startsWith(p))).map(f=>({scope,unit:f.name}));
 }))).flat();
 // Timers per scope (realtime µs), so oneshot jobs can show their schedule.
 const timers={};
 await Promise.all(['user','system'].map(async scope=>{const r=await exec('systemctl',[...(scope==='user'?['--user']:[]),'list-timers','--all','--output=json','--no-pager']);try{for(const t of JSON.parse(r.output||'[]'))timers[scope+':'+t.unit]=t;}catch{}}));
 const iso=v=>{const e=Date.parse(v||'');return Number.isFinite(e)?new Date(e).toISOString():null};
 const services=await Promise.all(entries.map(async({scope,unit})=>{
  const result=await exec('systemctl',[...(scope==='user'?['--user']:[]),'show',unit,...properties.map(p=>'--property='+p)]);
  const p=Object.fromEntries(result.output.split('\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));
  const id=scope+':'+unit;
  return {id,unit,scope,...(known[id]||{name:p.Description||unit,description:unit}),state:p.ActiveState||'unknown',subState:p.SubState||'unknown',pid:Number(p.MainPID)||null,memory:/^\d+$/.test(p.MemoryCurrent||'')?Number(p.MemoryCurrent):null,cpuSeconds:/^\d+$/.test(p.CPUUsageNSec||'')?Number(p.CPUUsageNSec)/1e9:null,startedAt:p.ActiveEnterTimestamp||null,bootEnabled:['enabled','enabled-runtime'].includes(p.UnitFileState),restart:p.Restart||'no',type:p.Type||'unknown',error:result.error,
  ...(p.Type==='oneshot'?{job:(()=>{const timer=(p.TriggeredBy||'').split(/\s+/).find(u=>u.endsWith('.timer'));const t=timer&&timers[scope+':'+timer];return {timer:timer||null,next:t?.next?new Date(t.next/1000).toISOString():null,lastStart:iso(p.ExecMainStartTimestamp),lastExit:iso(p.ExecMainExitTimestamp),result:p.Result||null,exitStatus:Number(p.ExecMainStatus)||0};})()}:{})};
 }));
 // Homebase is still visible when running manually before its startup unit is installed.
 if(!services.some(s=>s.id==='user:homebase.service'))services.push({id:'user:homebase.service',unit:'homebase.service',scope:'user',...known['user:homebase.service'],state:'active',subState:'running',pid:process.pid,memory:process.memoryUsage().rss,startedAt:new Date(Date.now()-process.uptime()*1000).toISOString(),bootEnabled:false,restart:'no',type:'simple',manual:true});
 for(const service of services){
  if(service.startedAt){const epoch=Date.parse(service.startedAt);if(Number.isFinite(epoch))service.startedAt=new Date(epoch).toISOString();}
 }
 await Promise.all(services.filter(s=>s.probe==='tcp'&&s.state==='active').map(async s=>{s.responding=await tcpOpen(s.port)}));
 await Promise.all(services.filter(s=>s.url&&s.state==='active').map(async s=>{try{const r=await fetch(s.url,{signal:AbortSignal.timeout(2000),redirect:'manual'});s.endpointStatus=r.status;s.responding=r.status<500;await r.body?.cancel();}catch{s.responding=false}}));
 const order=Object.keys(known);
 services.sort((a,b)=>(order.includes(a.id)?order.indexOf(a.id):99)-(order.includes(b.id)?order.indexOf(b.id):99));
 return services.filter(s=>s.scope==='user'||s.type!=='oneshot');
}
export async function getPowerState(force=false){
 if(!force&&cached&&Date.now()-lastRead<15000)return cached;
 const [services,configText,timer,enabled,journal,helper,hooks,control]=await Promise.all([
 inventory(),readFile('/etc/homebase/power.json','utf8').catch(()=>null),exec('systemctl',['show','server-night-sleep.timer','--property=ActiveState','--property=NextElapseUSecRealtime','--property=LastTriggerUSec','--property=TimersCalendar']),exec('systemctl',['is-enabled','server-night-sleep.timer']),exec('journalctl',['-u','server-night-sleep.service','-n','100','--no-pager','-o','cat']),access(settings.powerHelper).then(()=>true).catch(()=>false),Promise.all(['/usr/local/sbin/server-smart-sleep','/usr/local/sbin/server-night-sleep'].map(p=>readFile(p,'utf8').then(s=>s.includes('# HOMEBASE POWER INTEGRATION')).catch(()=>false))).then(values=>values.every(Boolean)),
 // Whether the sudoers rule for system service control is installed (lists only; runs nothing).
 exec('sudo',['-n','-l']).then(r=>r.output.includes(settings.powerHelper+' service'))
 ]);
 const props=Object.fromEntries(timer.output.split('\n').map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)]}));
 let config,configError;
 try{config=configText?JSON.parse(configText):null}catch{configError='Saved sleep settings could not be read. Repair the configuration before saving.'}
 const detectedTime=props.TimersCalendar?.match(/\b(\d\d:\d\d):\d\d\b/)?.[1]||'00:30';
 config=config||{enabled:enabled.output==='enabled',sleepTime:detectedTime,wakeTime:'05:00',blockSsh:true,blockTmux:true,services:{}};
 const lines=journal.output.split('\n');let start=-1;for(let i=0;i<lines.length;i++)if(lines[i].includes('=== NIGHT SLEEP CONTROLLER ==='))start=i;
 const last=start>=0?lines.slice(start):[];
 const reasons=last.filter(l=>/^ - /.test(l)).map(l=>l.replace(/^ - /,''));
 cached={setupCommand:settings.setupCommand,installed:helper&&hooks&&!!configText&&!configError,serviceControl:control,config,configError,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,timerState:props.ActiveState||'unknown',nextAttempt:props.NextElapseUSecRealtime||null,lastAttempt:props.LastTriggerUSec||null,lastOutcome:last.some(l=>l.includes('Skipping nightly suspend'))?'Skipped — server was busy':last.some(l=>l.includes('Server resumed'))?'Resumed':last.some(l=>l.includes('Suspending server'))?'Suspend requested':'No recent result',lastReasons:[...new Set(reasons)],services:services.map(s=>({...s,preventSleep:config.services?.[s.id]===true,blockingNow:config.services?.[s.id]===true&&['active','activating','reloading','deactivating'].includes(s.state)})),error:timer.error};lastRead=Date.now();return cached;
}
export async function savePowerSettings(config){
 const state=await getPowerState(true);
 if(!state.installed)throw Error('Administrator setup is required before sleep settings can be saved.');
 if(!config||typeof config!=='object'||!config.services||Array.isArray(config.services))throw Error('Invalid sleep settings');
 const valid=new Set(state.services.filter(s=>!s.manual).map(s=>s.id));
 for(const id of Object.keys(config.services))if(!valid.has(id)&&!(config.services[id]===false&&id in state.config.services))throw Error('Unknown hosted service: '+id);
 const result=await exec('sudo',['-n',settings.powerHelper,'apply'],JSON.stringify(config));
 if(!result.ok)throw Error(result.error||'Unable to apply sleep settings');
 lastRead=0;
 return getPowerState(true);
}
