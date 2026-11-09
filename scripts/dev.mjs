import {spawn} from 'node:child_process';
const children=[spawn(process.execPath,['server/index.mjs'],{stdio:'inherit'}),spawn(process.execPath,['node_modules/vite/bin/vite.js'],{stdio:'inherit'})];
let closing=false;const stop=(code=0)=>{if(closing)return;closing=true;children.forEach(c=>c.kill());process.exitCode=code;};
for(const c of children)c.on('exit',code=>stop(code||0));process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
