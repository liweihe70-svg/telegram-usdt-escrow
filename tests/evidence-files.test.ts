import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {Escrow,TEST_NETWORK} from '../src/escrow.js';
import {BotController} from '../src/bot-controller.js';
import {EvidenceFiles,classify,FILE_LIMIT,boundedDownload} from '../src/evidence-files.js';
import {createBot} from '../src/telegram-bot.js';
let e:Escrow,c:BotController,sequence=95000;
before(async()=>{e=await Escrow.open(undefined,['9001']);c=new BotController(e,{username:'EvidenceTest_bot',brand:'Fixture',minimumFee:'5',feeBps:500});});
after(()=>e.db.close());
async function order(dispute=true){const o=await e.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:s',description:'Evidence fixture'});await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:file_'+o.id,eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});if(dispute)await e.act(o.id,'1001','DISPUTE','Missing delivery');return o;}
const upload=(text='proof')=>({filename:'proof.txt',load:async()=>Buffer.from(text)});
const submit=(id:string,actor='1001',updateId?:number)=>c.handle({actor,chatId:actor,text:'/file_evidence '+id+' 原始说明',attachment:upload(),updateId});
test('附件提交在下载前校验交易方和争议状态，群内不能提交',async()=>{
 const o=await order(),files=new EvidenceFiles(e);let downloads=0;const source={filename:'x.txt',load:async()=>{downloads++;return Buffer.from('x');}};
 for(const actor of ['1003','9001'])await assert.rejects(files.submit(actor,'/file_evidence '+o.id,source),/无权/);
 const normal=await order(false);await assert.rejects(files.submit('1001','/file_evidence '+normal.id,source),/争议/);
 await assert.rejects(c.handle({actor:'1001',chatId:'-1008001',chatType:'supergroup',attachment:source,text:'/file_evidence '+o.id}),/私聊/);assert.equal(downloads,0);
});
test('二进制类型、大小、文件名清理与下载权限',async()=>{
 assert.equal(classify(Buffer.from('%PDF-1.7\nfixture'),'a.pdf'),'application/pdf');assert.equal(classify(Buffer.from('89504e470d0a1a0a','hex'),'a.png'),'image/png');assert.equal(classify(Buffer.from('ffd8ff','hex'),'a.jpg'),'image/jpeg');
 for(const [b,n]of [[Buffer.from('MZ executable'),'a.exe'],[Buffer.from('not png'),'a.png'],[Buffer.from([0xff]),'a.txt'],[Buffer.alloc(FILE_LIMIT+1),'a.txt']] as const)assert.throws(()=>classify(b,n));
 await assert.rejects(boundedDownload(new URL('https://example.com/file/botfoo')),/下载失败/);
 const o=await order(),f=new EvidenceFiles(e);await f.submit('1001','/file_evidence '+o.id+' 中文说明',{filename:'../\r\nproof.txt',load:async()=>Buffer.from('保存原文')});const list=await f.list(o.id);assert.equal(list[0].filename,'proof.txt');assert.equal(list[0].note,'中文说明');
 for(const actor of ['1001','1002','9001'])assert.equal(Buffer.from((await f.read(list[0].id,actor)).bytes).toString(),'保存原文');await assert.rejects(f.read(list[0].id,'1003'),/无权/);
});
test('Telegram更新重放只保存一次，证据分页和英文回复保留用户说明',async()=>{
 const o=await order(),update=sequence++;await c.handle({actor:'1001',chatId:'1001',text:'/language en'});const first=await submit(o.id,'1001',update);assert.match(first.text,/saved/);await submit(o.id,'1001',update);assert.equal((await new EvidenceFiles(e).list(o.id)).length,1);
 for(let i=0;i<4;i++)await submit(o.id);await assert.rejects(submit(o.id),/quota/);
 const page=await c.handle({actor:'1001',chatId:'1001',text:'/evidences '+o.id});assert.match(page.text,/原始说明/);assert.equal(page.buttons?.flat().filter(b=>b.callback_data?.startsWith('file:')).length,2);assert(page.text.length<4096);
 const file=(await new EvidenceFiles(e).list(o.id))[0];await assert.rejects(c.handle({actor:'1003',chatId:'1003',callback:'file:'+file.id}),/无权/);
});
test('下载期间仲裁完成则拒绝写入，旧证据可继续查询',async()=>{
 const o=await order(),f=new EvidenceFiles(e);await f.submit('1001','/file_evidence '+o.id,upload());
 await assert.rejects(f.submit('1001','/file_evidence '+o.id,{filename:'x.txt',load:async()=>{await e.arbitrate(o.id,'9001','50','55','fixture ruling');return Buffer.from('x');}}),/争议/);
 assert.equal((await f.list(o.id)).length,1);await f.read((await f.list(o.id))[0].id,'1002');
});
test('Telegram图片与文档更新接入，重复更新不再下载，下载按钮按用户检查',async()=>{
 const o=await order();let downloaded=0,sent=0;const replies:string[]=[];const bot=createBot('fixture-token',c,{acknowledge:async()=>{},reply:async(_,v)=>{replies.push(v.text);},file:async(_,id)=>{downloaded++;return id==='doc'?Buffer.from('document evidence'):Buffer.from('ffd8ff','hex');},sendFile:async()=>{sent++;}});
 bot.botInfo={id:991,is_bot:true,first_name:'Test',username:'EvidenceTest_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
 const update:any={update_id:sequence++,message:{message_id:1,date:1,from:{id:1001,is_bot:false,first_name:'buyer'},chat:{id:1001,type:'private'},caption:'/file_evidence '+o.id+' screenshot',photo:[{file_id:'fixture',file_unique_id:'fixture',width:1,height:1,file_size:3}]}};
 await bot.handleUpdate(update);await bot.handleUpdate(update);assert.equal(downloaded,1);
 const {photo,...documentMessage}=update.message;await bot.handleUpdate({update_id:sequence++,message:{...documentMessage,document:{file_id:'doc',file_unique_id:'doc',file_name:'document.txt',file_size:17}}});assert.equal(downloaded,2);assert.equal((await new EvidenceFiles(e).list(o.id)).length,2);
 const file=(await new EvidenceFiles(e).list(o.id))[0];await bot.handleUpdate({update_id:sequence++,callback_query:{id:'cb',from:update.message.from,chat_instance:'1',data:'file:'+file.id,message:update.message}});assert.equal(sent,1);
 assert(replies.some(r=>/saved/.test(r)));
});

