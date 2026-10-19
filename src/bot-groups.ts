import {randomUUID} from 'node:crypto';
import {t,withLanguage,type Language} from './bot-language.js';
import {button,orderView,type View,type Button} from './bot-ui.js';
import {Escrow} from './escrow.js';
import type {BotInput} from './bot-controller.js';
import {DEMO_PEER} from './bot-admin.js';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const validGroup=(id:string)=>/^-[1-9]\d{0,15}$/.test(id)&&Number.isSafeInteger(Number(id));
export interface GroupBinding {order_id:string;chat_id:string;owner_id:string;state:'PENDING'|'ACTIVE'|'PAUSED'|'REVOKED';language:Language;expired:boolean}
export class BotGroups {
 constructor(private escrow:Escrow,private username:string){}
 async binding(chat:string){return (await this.escrow.db.query<GroupBinding>(`SELECT order_id,chat_id::text,owner_id::text,state,language,expires_at<now() AS expired FROM bot_group_bindings WHERE chat_id=$1 AND state<>'REVOKED'`,[chat])).rows[0];}
 private async participant(id:string,actor:string){const o=await this.escrow.get(id);if(![o.buyer_id,o.seller_id].includes(actor))throw Error(t('只有交易双方可以操作担保群订单'));return o;}
 guide():View{return {text:t('担保群使用说明 · 模拟资金\n先在私聊创建订单，手动创建群并添加机器人为管理员。\n交易方兼群管理员发送 /bind 完整订单编号；另一方点击确认绑定。双方同意后才展示交易内容。\n/group 查看订单；/group_language en 或 zh 切换群语言；/unbind 撤销群绑定，不改变订单。\n所有群成员都能看见群内交易信息，请只邀请可信成员。争议、证据及仲裁仍在私聊办理。'),buttons:[[{text:t('私聊创建交易'),url:`https://t.me/${this.username}?start=group_help`}]]};}
 private pending(b:GroupBinding):View{return {text:t('担保群绑定待确认\n订单：')+b.order_id+t('\n另一位交易方须在30分钟内确认。确认后交易内容及状态会向本群成员展示。群绑定同意不等于确认交易条款。'),language:b.language,buttons:[[button(t('同意在本群展示订单'),`g:j:${b.order_id}`)],[button(t('取消群绑定'),`g:u:${b.order_id}`)]]};}
 async view(b:GroupBinding):Promise<View>{return withLanguage(b.language,async()=>{
  if(b.state==='PENDING')return this.pending(b);
  if(b.state!=='ACTIVE')throw Error(t('担保群绑定已暂停或撤销'));
  const o=await this.escrow.get(b.order_id),base=orderView(o,o.buyer_id,this.username),rows:Button[][]=[];
  const accepted=(await this.escrow.db.query<{user_id:string}>('SELECT user_id::text FROM order_acceptances WHERE order_id=$1 AND terms_version=$2',[o.id,o.terms_version])).rows.map(r=>r.user_id);
  for(const [actor,role,label]of [[o.buyer_id,'B',t('买家')],[o.seller_id,'S',t('卖家')]]){
   const card=orderView(o,actor,this.username);
   for(const row of card.buttons??[])for(const item of row){const data=item.callback_data;if(!data||!(/^(accept|act):/.test(data)))continue;if(data.startsWith('accept:')&&accepted.includes(actor))continue;
    rows.push([button(label+' · '+item.text,`g:${role}:${data}`)]);
   }
  }
  rows.push([button(t('刷新群订单'),`g:q:${o.id}`),{text:t('私聊处理争议与证据'),url:`https://t.me/${this.username}?start=order_${o.id}`}]);
  return {text:t('已绑定担保群 · 模拟资金\n')+base.text+t('\n\n条款确认：买家')+(accepted.includes(o.buyer_id)?t('已确认'):t('未确认'))+t(' · 卖家')+(accepted.includes(o.seller_id)?t('已确认'):t('未确认')),buttons:rows,language:b.language};
 });}
 async handle(i:BotInput,language:Language,action:(input:BotInput)=>Promise<View>):Promise<View>{
  if(!validGroup(i.chatId)||!i.groupMember)throw Error(t('无法核验群成员身份，请确认机器人为群管理员'));
  let text=i.text?.trim(),command=text?.split(/\s+/)[0].replace(/@[a-zA-Z0-9_]+$/,'');
  const start=text?.match(/^\/start(?:@[a-zA-Z0-9_]+)?\s+bind_([a-f0-9-]+)$/);if(start){command='/bind';text='/bind '+start[1];}
  if(command==='/bind'){
   const args=text!.split(/\s+/);if(args.length!==2||!uuid.test(args[1]))throw Error(t('格式：/bind 完整订单编号'));
   if(!i.groupAdmin)throw Error(t('绑定发起人必须是交易方兼群管理员'));
   const o=await this.participant(args[1],i.actor);if([o.buyer_id,o.seller_id].includes(DEMO_PEER))throw Error(t('系统模拟对方不能确认群绑定，请使用普通测试订单'));
   let existing=await this.binding(i.chatId);
   if(existing?.order_id===o.id){await this.participant(o.id,i.actor);return withLanguage(existing.language,()=>this.view(existing!));}
   if(o.state!=='AWAITING_ACCEPTANCE')throw Error(t('群绑定只能在订单入金前、条款待确认时发起'));
   await this.escrow.db.transaction(async tx=>{
    if((await tx.query('SELECT order_id FROM bot_group_bindings WHERE order_id=$1 OR (chat_id=$2 AND state<>\'REVOKED\') FOR UPDATE',[o.id,i.chatId])).rows.length)throw Error(t('订单或本群已经绑定，不能覆盖或转移'));
    await tx.query(`INSERT INTO bot_group_bindings(order_id,chat_id,owner_id,state,language) VALUES($1,$2,$3,'PENDING',$4)`,[o.id,i.chatId,i.actor,language]);
    await tx.query('INSERT INTO bot_group_consents(order_id,user_id) VALUES($1,$2)',[o.id,i.actor]);
   });
   return this.view((await this.binding(i.chatId))!);
  }
  const b=await this.binding(i.chatId);
  if(!b){if(i.callback)throw Error(t('本群没有有效绑定，旧按钮不能使用'));return this.guide();}
  return withLanguage(b.language,async()=>{
   await this.participant(b.order_id,i.actor);
   if(command==='/group_resume'){
    if(!i.groupAdmin||b.state!=='PAUSED')throw Error(t('恢复群通知需要交易方兼群管理员，且绑定处于暂停状态'));
    await this.escrow.db.query("UPDATE bot_group_bindings SET state='ACTIVE' WHERE order_id=$1 AND state='PAUSED'",[b.order_id]);
    await this.escrow.db.query('INSERT INTO outbox_jobs(id,order_id,event) VALUES($1,$2,$3)',[randomUUID(),b.order_id,'GROUP_RESUMED']);return this.view({...b,state:'ACTIVE'});
   }
   if(command==='/group_language'){
    const args=text!.split(/\s+/);if(!i.groupAdmin||args.length!==2||!['zh','en'].includes(args[1]))throw Error(t('交易方兼群管理员使用 /group_language en 或 zh'));
    await this.escrow.db.query('UPDATE bot_group_bindings SET language=$2 WHERE order_id=$1',[b.order_id,args[1]]);return this.view({...b,language:args[1] as Language});
   }
   if(command==='/unbind')return {text:t('撤销群绑定后，旧群按钮和群通知停止。订单与私聊交易继续保留。请确认：'),buttons:[[button(t('确认撤销群绑定'),`g:u:${b.order_id}`)],[button(t('返回群订单'),`g:q:${b.order_id}`)]],language:b.language};
   const join=i.callback?.match(/^g:j:([a-f0-9-]+)$/),revoke=i.callback?.match(/^g:u:([a-f0-9-]+)$/);
   if(join||revoke){if((join??revoke)![1]!==b.order_id)throw Error(t('按钮不属于本群绑定订单'));
    if(revoke){await this.escrow.db.query("UPDATE bot_group_bindings SET state='REVOKED' WHERE order_id=$1",[b.order_id]);return {text:t('群绑定已撤销，订单和私聊操作不受影响。'),language:b.language};}
    if(b.state==='ACTIVE')return this.view(b);
    if(b.state!=='PENDING'||b.expired)throw Error(t('群绑定确认已失效，请撤销后使用新订单'));
    await this.escrow.db.transaction(async tx=>{
     await tx.query('SELECT order_id FROM bot_group_bindings WHERE order_id=$1 FOR UPDATE',[b.order_id]);
     await tx.query('INSERT INTO bot_group_consents(order_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[b.order_id,i.actor]);
     const count=(await tx.query<{n:number}>('SELECT count(*)::int AS n FROM bot_group_consents WHERE order_id=$1',[b.order_id])).rows[0].n;
     if(count===2){await tx.query("UPDATE bot_group_bindings SET state='ACTIVE' WHERE order_id=$1 AND state='PENDING' AND expires_at>now()",[b.order_id]);await tx.query('INSERT INTO outbox_jobs(id,order_id,event) VALUES($1,$2,$3)',[randomUUID(),b.order_id,'GROUP_BOUND']);}
    });return this.view((await this.binding(i.chatId))!);
   }
   if(command==='/group')return this.view(b);
   if(command)return this.guide();
   if(b.state!=='ACTIVE')throw Error(t('双方同意群绑定后才能在群内操作订单'));
   const refresh=i.callback?.match(/^g:q:([a-f0-9-]+)$/);if(refresh){if(refresh[1]!==b.order_id)throw Error(t('按钮不属于本群绑定订单'));return this.view(b);}
   const match=i.callback?.match(/^g:([BS]):((?:accept:\d+|(?:act|execute):(?:DECLARE|RELEASE|REQUEST_REFUND|AGREE_REFUND|REJECT_REFUND|DISPUTE|CLOSE)):[a-f0-9-]+)$/);
   if(!match||match[2].split(':').at(-1)!==b.order_id)throw Error(t('按钮不属于本群绑定订单'));
   const o=await this.participant(b.order_id,i.actor);if(i.actor!==(match[1]==='B'?o.buyer_id:o.seller_id))throw Error(t('不能使用对方角色的群按钮'));
   if(match[2].includes(':DISPUTE:'))return {text:t('争议理由、证据和仲裁请在机器人私聊办理。'),language:b.language,buttons:[[{text:t('私聊处理争议与证据'),url:`https://t.me/${this.username}?start=order_${o.id}`}]]};
   const response=await action({...i,callback:match[2],text:undefined});
   if(match[2].startsWith('act:')&&(response.buttons??[]).flat().some(x=>x.callback_data?.startsWith('execute:'))){
    return {...response,language:b.language,buttons:response.buttons?.map(row=>row.filter(x=>x.callback_data?.startsWith('execute:')||x.callback_data?.startsWith('order:')).map(x=>button(x.text,x.callback_data!.startsWith('order:')?`g:q:${o.id}`:`g:${match[1]}:${x.callback_data}`)))};
   }
   return this.view(b);
  });
 }
 async available(chat:string,available:boolean){await this.escrow.db.query(`UPDATE bot_group_bindings SET state=CASE WHEN $2 THEN 'ACTIVE' ELSE 'PAUSED' END WHERE chat_id=$1 AND state=$3`,[chat,available,available?'PAUSED':'ACTIVE']);}
 async migrate(oldChat:string,newChat:string){if(!validGroup(oldChat)||!validGroup(newChat))throw Error('Invalid group migration');await this.escrow.db.transaction(async tx=>{
  const changed=(await tx.query<{order_id:string}>("UPDATE bot_group_bindings SET chat_id=$2 WHERE chat_id=$1 AND state<>'REVOKED' RETURNING order_id",[oldChat,newChat])).rows;
  if(changed[0])await tx.query(`INSERT INTO bot_group_notification_receipts(job_id,chat_id,sent_at,attempts,retry_at)
   SELECT r.job_id,$2,r.sent_at,r.attempts,r.retry_at FROM bot_group_notification_receipts r JOIN outbox_jobs j ON j.id=r.job_id
   WHERE r.chat_id=$1 AND j.order_id=$3 ON CONFLICT(job_id,chat_id) DO NOTHING`,[oldChat,newChat,changed[0].order_id]);
 });}
}
