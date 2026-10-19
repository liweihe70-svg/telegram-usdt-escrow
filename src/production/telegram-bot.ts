import {Telegraf,type Context} from 'telegraf';
import {boundTelegramRequests} from '../telegram-requests.js';
import {ProductionTelegramController,type ProductionView} from './telegram-controller.js';
import {boundedDownload} from './case-files.js';
import {ProductionGroups} from './groups.js';
import {groupError} from './group-errors.js';
interface IO{reply(ctx:Context,view:ProductionView):Promise<unknown>;acknowledge(ctx:Context):Promise<unknown>;document?(ctx:Context,filename:string,bytes:Uint8Array):Promise<unknown>;download?(ctx:Context,fileId:string):Promise<Uint8Array>;memberStatus?(ctx:Context,chatId:string,userId:string):Promise<string>;menu?(ctx:Context,language:'zh'|'en'):Promise<unknown>;groupMenu?(ctx:Context,language:'zh'|'en'):Promise<unknown>;photo?(ctx:Context,image:Uint8Array,caption:string):Promise<unknown>;rename?(ctx:Context,title:string):Promise<unknown>;inviteLink?(ctx:Context):Promise<string>;memberCount?(ctx:Context):Promise<number>;join?(ctx:Context,userId:number,approve:boolean):Promise<unknown>}
export const keyboard=(view:ProductionView)=>(view.buttons??[]).map(row=>row.map(b=>b.url?{text:b.text,url:b.url}:{text:b.text,callback_data:b.callback_data??''}));
// Shown when typing "/" in a group; the blue menu button itself only exists in private chats.
export const groupCommands={
  zh:[{command:'menu',description:'快捷菜单'},{command:'seller',description:'设置卖家：/seller 钱包地址'},{command:'buyer',description:'设置买家：/buyer 钱包地址'},{command:'terms',description:'记录交易内容（可选）：/terms 内容'},{command:'description',description:'设置交易内容'},{command:'pay_seller',description:'放款给卖家'},{command:'refund_buyer',description:'退款给买家'},{command:'qr',description:'收款二维码'},{command:'verify',description:'验证收款地址：/verify 地址'},{command:'convert',description:'币价换算：/convert 1 bnb usdt'},{command:'guide',description:'📖 交易说明（新手必看）'},{command:'buyer',description:'设置买家：/buyer 钱包地址'},{command:'seller',description:'设置卖家：/seller 钱包地址'},{command:'terms',description:'记录交易内容（可选）：/terms 内容'},{command:'balance',description:'托管余额'},{command:'blockchain',description:'链上交易链接'},{command:'dispute',description:'发起争议：/dispute 理由'},{command:'reset',description:'取消尚未生成订单的草稿'},{command:'language',description:'群语言：/language en 或 zh'}],
  en:[{command:'menu',description:'Quick access menu'},{command:'seller',description:'Set seller: /seller ADDRESS'},{command:'buyer',description:'Set buyer: /buyer ADDRESS'},{command:'terms',description:'Note the deal (optional): /terms DESCRIPTION'},{command:'description',description:'Set the deal description'},{command:'pay_seller',description:'Release funds to the seller'},{command:'refund_buyer',description:'Refund the buyer'},{command:'qr',description:'Deposit address QR'},{command:'verify',description:'Verify an address: /verify ADDRESS'},{command:'convert',description:'Convert: /convert 1 bnb usdt'},{command:'guide',description:'📖 How to trade (start here)'},{command:'buyer',description:'Set buyer: /buyer wallet address'},{command:'seller',description:'Set seller: /seller wallet address'},{command:'terms',description:'Note the deal (optional): /terms DESCRIPTION'},{command:'balance',description:'Escrow balance'},{command:'blockchain',description:'On-chain transaction links'},{command:'dispute',description:'Open a dispute: /dispute reason'},{command:'reset',description:'Cancel a draft before the order exists'},{command:'language',description:'Group language: /language en or zh'}]};
export const productionCommands={
  zh:[{command:'start',description:'正式商品担保首页'},{command:'guide',description:'📖 交易说明（新手必看）'},{command:'orders',description:'我的正式订单'},{command:'order',description:'查询订单：完整编号'},{command:'evidences',description:'争议附件：完整订单编号'},{command:'id',description:'本人 Telegram 数字 ID'},{command:'language',description:'中文 / English'}],
  en:[{command:'start',description:'Escrow home'},{command:'guide',description:'📖 How to trade (start here)'},{command:'orders',description:'My orders'},{command:'order',description:'Order by full ID'},{command:'evidences',description:'Dispute attachments by full order ID'},{command:'id',description:'My Telegram numeric ID'},{command:'language',description:'中文 / English'}]};
async function sendView(ctx:Context,view:ProductionView):Promise<unknown>{
  const extra:Record<string,unknown>={reply_markup:{inline_keyboard:keyboard(view)}};
  if(view.html)extra.parse_mode='HTML';
  const tapped=ctx.callbackQuery&&'message' in ctx.callbackQuery?ctx.callbackQuery.message:undefined;
  if((view.remove||view.replace)&&tapped){await ctx.deleteMessage(tapped.message_id).catch(()=>{});if(view.remove)return;}
  if(view.remove)return;
  if(view.edit&&tapped){
    try{return await ctx.editMessageText(view.text,{...extra,link_preview_options:{is_disabled:true}} as never);}
    catch(e){if(/not modified/i.test((e as Error).message))return;}
  }
  const message=ctx.message as {message_id?:number}|undefined;
  if(view.quote&&message?.message_id)extra.reply_parameters={message_id:message.message_id,allow_sending_without_reply:true};
  let sent:unknown;
  // Captions are limited to 1024 characters; longer text goes as a normal message after the media.
  const caption=view.text.length<=1024;
  if(view.media){
    const source=view.media.bytes?{source:Buffer.from(view.media.bytes)}:view.media.url!;
    const opts={...extra,...(caption?{caption:view.text}:{})} as never;
    sent=view.media.kind==='video'?await ctx.replyWithVideo(source as never,opts):await ctx.replyWithPhoto(source as never,opts);
    if(!caption)sent=await ctx.reply(view.text,extra as never);
  }else sent=await ctx.reply(view.text,extra as never);
  if(view.after)await sendView(ctx,{...view.after,quote:false});
  return sent;
}
const normalIO:IO={rename:(ctx,title)=>ctx.telegram.setChatTitle(ctx.chat!.id,title),photo:(ctx,image,caption)=>sendView(ctx,{text:caption,media:{kind:'photo',bytes:image},quote:true}),groupMenu:(ctx,language)=>ctx.telegram.setMyCommands(groupCommands[language],{scope:{type:'chat',chat_id:ctx.chat!.id}}),inviteLink:async ctx=>(await ctx.telegram.createChatInviteLink(ctx.chat!.id,{creates_join_request:true,name:'escrow',expire_date:Math.floor(Date.now()/1000)+86400})).invite_link,
  memberCount:ctx=>ctx.telegram.getChatMembersCount(ctx.chat!.id),
  join:(ctx,userId,approve)=>approve?ctx.telegram.approveChatJoinRequest(ctx.chat!.id,userId):ctx.telegram.declineChatJoinRequest(ctx.chat!.id,userId),menu:(ctx,language)=>ctx.telegram.setMyCommands(productionCommands[language],{scope:{type:'chat',chat_id:ctx.chat!.id}}),reply:sendView,acknowledge:ctx=>ctx.answerCbQuery(),document:(ctx,filename,bytes)=>ctx.replyWithDocument({source:Buffer.from(bytes),filename}),download:async(ctx,fileId)=>boundedDownload(await ctx.telegram.getFileLink(fileId)),memberStatus:async(ctx,chatId,userId)=>{const m=await ctx.telegram.getChatMember(chatId,Number(userId));return m.status==='restricted'&&!m.is_member?'left':m.status;}};
export function createProductionTelegramBot(token:string,controller:ProductionTelegramController,signal?:AbortSignal,io:IO=normalIO,groups?:ProductionGroups){
  const bot=new Telegraf(token);boundTelegramRequests(bot.telegram,signal);
  // Groups that just got the welcome/invite because the bot was made admin; the automatic "/start deal" that may follow is then skipped.
  const welcomed=new Map<string,number>();
  bot.use(async ctx=>{
    boundTelegramRequests(ctx.telegram,signal);
    if(ctx.callbackQuery)await io.acknowledge(ctx).catch(()=>{});
    const chatType=ctx.chat?.type;
    if(groups&&(chatType==='group'||chatType==='supergroup')){
      const chatId=String(ctx.chat!.id),update=ctx.update as {my_chat_member?:{old_chat_member?:{status:string};new_chat_member:{status:string;user:{id:number}}}};
      const request=(ctx.update as {chat_join_request?:{from:{id:number;is_bot:boolean}}}).chat_join_request;
      if(request){if(!io.join)return;const ok=!request.from.is_bot&&await groups.joinDecision(chatId,String(request.from.id),io.memberCount?await io.memberCount(ctx):99).catch(()=>false);await io.join(ctx,request.from.id,ok).catch(()=>{});return;}
      const ADMIN=['administrator','creator'];let joined=false;
      if(update.my_chat_member){
        if(!ADMIN.includes(update.my_chat_member.new_chat_member.status)){await groups.pauseChat(chatId,'BOT_NOT_ADMIN');return;}
        // Newly added or promoted to admin: post the welcome and invite link without waiting for a /start that some clients never send.
        if(ADMIN.includes(update.my_chat_member.old_chat_member?.status??'')||!ctx.from||ctx.from.is_bot)return;
        joined=true;welcomed.set(chatId,Date.now());for(const [id,at] of welcomed)if(Date.now()-at>600000)welcomed.delete(id);
      }
      const migrated=ctx.message&&'migrate_to_chat_id' in ctx.message?ctx.message.migrate_to_chat_id:undefined;if(migrated){await groups.migrate(chatId,String(migrated));return;}
      // Ignore bots, channel posts and anonymous admins: they cannot be tied to a party's Telegram ID.
      if(!ctx.from||ctx.from.is_bot||(ctx.message&&'sender_chat' in ctx.message&&ctx.message.sender_chat))return;
      const text=joined?'/start deal':ctx.message&&'text' in ctx.message?ctx.message.text:undefined,callback=ctx.callbackQuery&&'data' in ctx.callbackQuery?ctx.callbackQuery.data:undefined;
      if(!joined&&text&&/^\/start(?:@[a-zA-Z0-9_]+)?\s+deal$/.test(text)&&Date.now()-(welcomed.get(chatId)??0)<120000)return;
      if(callback&&!callback.startsWith('g:'))return;
      const status=(userId:string)=>io.memberStatus?io.memberStatus(ctx,chatId,userId):Promise.resolve('left');
      try{const view=await groups.handle({chatId,actor:String(ctx.from.id),text,callback,status,botStatus:()=>status(String(ctx.botInfo.id)),invite:io.inviteLink?()=>io.inviteLink!(ctx):undefined,actorName:ctx.from.username?`@${ctx.from.username}`:ctx.from.first_name,actorUsername:ctx.from.username,rename:io.rename?title=>io.rename!(ctx,title):undefined});if(view?.photo&&io.photo)await io.photo(ctx,view.photo,view.text);else if(view)await io.reply(ctx,{...(view as ProductionView),quote:view.quote??false});
        // After the group language changes, switch this group's "/" command list to match.
        const switched=text?.trim().match(/^\/(?:group_)?language(?:@[a-zA-Z0-9_]+)?\s+(zh|en)$/)?.[1]??callback?.match(/^g:l:(zh|en)$/)?.[1];
        if(view&&switched&&io.groupMenu)await io.groupMenu(ctx,switched as 'zh'|'en').catch(()=>{});
      }
      catch(e){if(text?.startsWith('/')||callback){const en=await groups.language(chatId).catch(()=>'en')==='en';await io.reply(ctx,{text:groupError((e as Error).message,en),quote:false}).catch(()=>{});}}
      return;
    }
    if(!ctx.from||ctx.from.is_bot||ctx.chat?.type!=='private'||!Number.isSafeInteger(ctx.from.id)||String(ctx.chat.id)!==String(ctx.from.id))return;
    const text=ctx.message&&'text'in ctx.message?ctx.message.text:undefined;
    const callback=ctx.callbackQuery&&'data'in ctx.callbackQuery?ctx.callbackQuery.data:undefined;
    const message=ctx.message as undefined|{caption?:string;document?:{file_id:string;file_unique_id:string;file_name?:string;file_size?:number};photo?:{file_id:string;file_unique_id:string;file_size?:number}[]};
    const attachment=message?.document?{id:message.document.file_id,uniqueId:message.document.file_unique_id,filename:message.document.file_name??'document',size:message.document.file_size}:message?.photo?.length?(p=>({id:p.file_id,uniqueId:p.file_unique_id,filename:'photo.jpg',size:p.file_size}))(message.photo[message.photo.length-1]):undefined;
    if(attachment&&!text){
      // Telegram converts photos to JPEG; the file is only fetched after identity, state and caption checks.
      try{await io.reply(ctx,await controller.submitFile(String(ctx.from.id),String(ctx.chat.id),message?.caption,()=>({filename:attachment.filename,size:attachment.size,uniqueId:attachment.uniqueId,load:()=>io.download?io.download(ctx,attachment.id):Promise.reject(Error('download unavailable'))})));}
      catch{await io.reply(ctx,{text:'附件未保存，请稍后重试。Attachment not saved; please retry.'});}
      return;
    }
    const fileButton=callback?.match(/^pf:([a-f0-9-]{36})$/)?.[1];
    if(fileButton){
      try{const file=await controller.readFile(fileButton,String(ctx.from.id));if(!io.document)throw Error();await io.document(ctx,file.filename,file.bytes);}
      catch{await io.reply(ctx,{text:'无法取回附件：仅订单双方可下载。Attachment unavailable: only the order parties can download it.'});}
      return;
    }
    if(!text&&!callback)return;
    try{
      await io.reply(ctx,await controller.handle({actor:String(ctx.from.id),chatId:String(ctx.chat.id),text,callback,updateId:ctx.update.update_id}));
      // Telegram picks the menu by app language; a per-chat menu follows the language chosen in the bot instead.
      const language=text?.trim().match(/^\/language(?:@[a-zA-Z0-9_]+)?\s+(zh|en)$/)?.[1]??callback?.match(/^p:lang:(zh|en)$/)?.[1];
      if(language&&io.menu)await io.menu(ctx,language as 'zh'|'en').catch(()=>{});
    }
    catch{
      let en=false;try{en=await controller.language(String(ctx.from.id))==='en';}catch{}
      await io.reply(ctx,{text:en?'The operation could not be completed. Check your role and refresh the order; no transfer was sent.':'操作未完成，请核对参与方身份并刷新订单；未执行转账。',buttons:[[{text:en?'My orders':'我的订单',callback_data:'p:orders'}]]});
    }
  });
  bot.catch(()=>{process.stderr.write('正式机器人交互暂时失败；未记录更新正文或凭据。\n');});
  return bot;
}
