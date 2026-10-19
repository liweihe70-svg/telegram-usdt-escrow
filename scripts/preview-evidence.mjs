// Isolated panel preview with synthetic Telegram identities. No bot token or live messages.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,open,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {EvidenceFiles} from '../dist/src/evidence-files.js';
import {Escrow,TEST_NETWORK} from '../dist/src/escrow.js';
import {BotController} from '../dist/src/bot-controller.js';
const root=resolve('data/qa-evidence-'+Date.now());await mkdir(root,{recursive:true});
await writeFile(join(root,'.env'),'BOT_BRAND="担保群模拟预览"\n');
const escrow=await Escrow.open(join(root,'data/local-demo'));
const controller=new BotController(escrow,{username:'GroupPreview_bot',brand:'Group preview',minimumFee:'5',feeBps:500});
const order=await escrow.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:s',description:'附件证据模拟预览，无真实资金或 Telegram 消息。'});
await escrow.accept(order.id,'1001',1);await escrow.accept(order.id,'1002',1);
await escrow.deposit(order.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:previewfiles',eventIndex:0,amount:'105',confirmed:true,success:true,to:order.deposit_address});
await escrow.act(order.id,'1001','DISPUTE','未收到约定商品（模拟）');
const files=new EvidenceFiles(escrow);
await files.submit('1001','/file_evidence '+order.id+' 模拟图片，非真实交易凭证',{filename:'proof.png',load:async()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=','base64')});
await files.submit('1002','/file_evidence '+order.id+' 交付说明原文（测试）',{filename:'delivery.txt',load:async()=>Buffer.from('模拟交付文件：没有真实交易。')});
const active=order.id;
await escrow.db.close();const log=await open(join(root,'preview.log'),'a');
const child=spawn(process.execPath,[resolve('dist/src/server.js')],{cwd:root,env:{...process.env,PANEL_PORT:'0'},windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
for(let n=0;n<100;n++){const contents=await readFile(join(root,'preview.log'),'utf8'),line=contents.split('\n').find(s=>s.startsWith('READY '));if(line){console.log(JSON.stringify({...JSON.parse(line.slice(6)),fixture:root,activeOrder:active}));break;}await new Promise(r=>setTimeout(r,200));}
