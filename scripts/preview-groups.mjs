// Isolated panel preview with synthetic Telegram identities. No bot token or live messages.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,open,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Escrow} from '../dist/src/escrow.js';
import {BotController} from '../dist/src/bot-controller.js';
const root=resolve('data/qa-groups-'+Date.now());await mkdir(root,{recursive:true});
await writeFile(join(root,'.env'),'BOT_BRAND="担保群模拟预览"\n');
const escrow=await Escrow.open(join(root,'data/local-demo'));
const controller=new BotController(escrow,{username:'GroupPreview_bot',brand:'Group preview',minimumFee:'5',feeBps:500});
let active;
for(const [kind,chat,confirmed]of [['PRODUCT','-1007001',true],['P2P','-1007002',false]]){
 const order=await escrow.create({kind,buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:preview_buyer',sellerAddress:'sim:preview_seller',description:'担保群模拟预览：只使用测试身份和模拟资金，没有真实 Telegram 群。'});
 await controller.handle({actor:'1001',chatId:chat,chatType:'supergroup',groupMember:true,groupAdmin:true,text:'/bind '+order.id});
 if(confirmed){await controller.handle({actor:'1002',chatId:chat,chatType:'supergroup',groupMember:true,callback:'g:j:'+order.id});active=order.id;}
}
await escrow.db.close();const log=await open(join(root,'preview.log'),'a');
const child=spawn(process.execPath,[resolve('dist/src/server.js')],{cwd:root,env:{...process.env,PANEL_PORT:'0'},windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
for(let n=0;n<100;n++){const contents=await readFile(join(root,'preview.log'),'utf8'),line=contents.split('\n').find(s=>s.startsWith('READY '));if(line){console.log(JSON.stringify({...JSON.parse(line.slice(6)),fixture:root,activeOrder:active}));break;}await new Promise(r=>setTimeout(r,200));}
