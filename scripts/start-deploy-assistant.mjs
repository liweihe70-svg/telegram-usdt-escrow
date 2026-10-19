import {spawn} from 'node:child_process';
import {mkdir,open} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),url='http://127.0.0.1:8783/';
const workspaceId=createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,24);
async function health(){try{const r=await fetch(url+'health',{signal:AbortSignal.timeout(1000)});return r.ok?await r.json():null;}catch{return null;}}
let h=await health();
if(!h){
  const dir=resolve(root,'data/deploy-assistant');await mkdir(dir,{recursive:true});
  const out=await open(resolve(dir,'output.log'),'a'),err=await open(resolve(dir,'error.log'),'a');
  const child=spawn(process.execPath,['scripts/deploy-assistant-server.mjs'],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out.fd,err.fd]});child.unref();await out.close();await err.close();
  for(let n=0;n<20;n++){h=await health();if(h)break;await new Promise(r=>setTimeout(r,500));}
}
if(h?.application!=='escrow-testnet-deploy-assistant'||h.workspaceId!==workspaceId)throw Error('Test deployment assistant unavailable or port occupied');
console.log(JSON.stringify({ready:true,url,chainId:97,serverSigning:false}));
