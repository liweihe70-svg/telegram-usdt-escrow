import {resolve} from 'node:path';
import {configureNetwork,instanceFiles,network,limits} from './network.js';
import {productionDatabase} from './database.js';
import {productionApp} from './http-app.js';
import {claimService} from '../service-lock.js';
import {createHash,randomUUID} from 'node:crypto';
import {saveProductionBotToken,saveProductionField} from './token-settings.js';

configureNetwork(process.env.PRODUCTION_NETWORK);limits();
const files=instanceFiles(),port=Number(process.env.PRODUCTION_PANEL_PORT??files.port);
if(!Number.isSafeInteger(port)||port<1||port>65535||port===8781||port===8783)throw Error('正式后台端口无效');
const root=resolve(process.cwd(),files.dataDir);
const instanceId=randomUUID(),workspaceId=createHash('sha256').update(resolve(process.cwd()).toLowerCase()).digest('hex').slice(0,24);
const release=await claimService(resolve(process.cwd(),files.serviceDir),instanceId);
try{
  const {database,engine}=await productionDatabase(process.env.PRODUCTION_DATABASE_URL,root);
  const app=productionApp(database,engine,{workspaceId,instanceId,onStop:release,botToken:process.env.PRODUCTION_TELEGRAM_BOT_TOKEN,saveBotToken:token=>saveProductionBotToken(process.cwd(),token),rpcUrl:process.env.BNB_RPC_URL,saveRpc:rpc=>saveProductionField(process.cwd(),'BNB_RPC_URL',rpc),backupRoot:process.cwd()});
  try{const url=await app.start(port);console.log(JSON.stringify({ready:true,url,engine,network:network(),realFunds:network()==='mainnet'}));}catch{await database.close();await release();console.error('正式后台启动失败，请检查端口和本机配置');process.exitCode=1;}
  process.once('SIGINT',()=>void app.stop());process.once('SIGTERM',()=>void app.stop());
}catch{await release();console.error('正式后台初始化失败，请检查独立数据库配置');process.exitCode=1;}
