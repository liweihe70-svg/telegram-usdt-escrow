import {spawn} from 'node:child_process';
import {open,mkdir,access} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// `--mainnet` starts the separate real-funds instance: its own port, data, logs, config file and bot.
const mainnet=process.argv.includes('--mainnet'),network=mainnet?'mainnet':'testnet';
const port=mainnet?8784:8782,envFile=mainnet?'.env.mainnet':'.env.production',serviceDir=mainnet?'data/production-mainnet-service':'data/production-service';
const workspaceId=createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,24);
const url=`http://127.0.0.1:${port}`;
async function health(){try{const response=await fetch(url+'/health',{signal:AbortSignal.timeout(1500)});return response.ok?await response.json():null;}catch{return null;}}
const matches=h=>h&&h.application==='escrow-production-development'&&h.workspaceId===workspaceId&&(h.network??'testnet')===network;
const before=await health();
if(before){if(!matches(before))throw Error(`${port}由其他项目或其他网络实例占用`);console.log(JSON.stringify({ready:true,url,network,reused:true}));}
else{
  if(mainnet)try{await access(join(root,envFile));}catch{throw Error('缺少 .env.mainnet：请先按 .env.mainnet.example 创建并填写');}
  await new Promise((resolve,reject)=>{const process=spawn('npm.cmd',['run','build'],{cwd:root,windowsHide:true,shell:true,stdio:'inherit'});process.once('error',reject);process.once('exit',code=>code===0?resolve():reject(Error('编译失败')));});
  const directory=join(root,serviceDir);await mkdir(directory,{recursive:true});
  const output=await open(join(directory,'output.log'),'a'),errors=await open(join(directory,'error.log'),'a');
  const args=[];try{await access(join(root,envFile));args.push(`--env-file=${envFile}`);}catch{}
  args.push('dist/src/production/server.js');
  const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,detached:true,stdio:['ignore',output.fd,errors.fd],env:{...process.env,PRODUCTION_NETWORK:network}});child.unref();await output.close();await errors.close();
  let result;for(let index=0;index<30;index++){result=await health();if(result)break;await new Promise(resolve=>setTimeout(resolve,500));}
  if(!matches(result))throw Error(`后台未启动，请查看${serviceDir}/error.log`);
  console.log(JSON.stringify({ready:true,url,network,engine:result.engine}));
}
