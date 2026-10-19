// Isolated synthetic preview. Never connects a Telegram bot or wallet.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,open,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Escrow,TEST_NETWORK} from '../dist/src/escrow.js';
import {OrderTimeouts} from '../dist/src/order-timeouts.js';
const root=resolve('data/qa-timeouts-'+Date.now());await mkdir(root,{recursive:true});
await writeFile(join(root,'.env'),'BOT_BRAND="超时模拟验收"\n');
const escrow=await Escrow.open(join(root,'data/local-demo')),worker=new OrderTimeouts(escrow);
let active,closed;
for(const funded of [false,true]){
 const o=await escrow.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:s',description:funded?'已入金超时模拟：管理员恢复前保持模拟资金。':'未确认超时模拟：无入金自动关闭。'});
 if(funded){await escrow.accept(o.id,'1001',1);await escrow.accept(o.id,'1002',1);await escrow.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:timeout_preview',eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});active=o.id;}else closed=o.id;
 await escrow.db.query("UPDATE order_timers SET deadline_at=now()-interval '1 minute',reminder_at=now()-interval '1 minute' WHERE order_id=$1",[o.id]);
}
await worker.tick();await escrow.db.close();const log=await open(join(root,'preview.log'),'a');
const child=spawn(process.execPath,[resolve('dist/src/server.js')],{cwd:root,env:{...process.env,PANEL_PORT:'0'},windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
for(let n=0;n<100;n++){const lines=await readFile(join(root,'preview.log'),'utf8'),line=lines.split('\n').find(s=>s.startsWith('READY '));if(line){console.log(JSON.stringify({...JSON.parse(line.slice(6)),fixture:root,reviewOrder:active,closedOrder:closed}));break;}await new Promise(r=>setTimeout(r,200));}
