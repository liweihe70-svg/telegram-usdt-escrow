import {boundTelegramRequests} from './telegram-requests.js';
import { EvidenceFiles,boundedDownload } from './evidence-files.js';
import { Context, Telegraf } from 'telegraf';
import { BotController } from './bot-controller.js';
import type { View } from './bot-ui.js';
import { BOT_COMMANDS, BOT_COMMANDS_EN } from './bot-commands.js';

interface IO { reply(ctx:Context,view:View):Promise<unknown>; acknowledge(ctx:Context):Promise<unknown>; file?(ctx:Context,id:string):Promise<Uint8Array>; sendFile?(ctx:Context,file:{filename:string;bytes:Uint8Array}):Promise<unknown>; groupAccess?(ctx:Context):Promise<{member:boolean;admin:boolean;botAdmin:boolean}> }
const telegramIO:IO={
  reply:(ctx,view)=>ctx.reply(view.text,view.buttons?{reply_markup:{inline_keyboard:view.buttons}}:{}),
  acknowledge:ctx=>ctx.answerCbQuery()
};
export function createBot(token:string,controller:BotController,io:IO=telegramIO,lifecycle?:AbortSignal){
  const bot=new Telegraf(token);boundTelegramRequests(bot.telegram,lifecycle);
  bot.use(async ctx=>{
    boundTelegramRequests(ctx.telegram,lifecycle);
    if(ctx.callbackQuery)await io.acknowledge(ctx).catch(()=>{});
    if(ctx.myChatMember){const status=ctx.myChatMember.new_chat_member.status;await controller.groups.available(String(ctx.myChatMember.chat.id),status==='administrator');return;}
    if(ctx.message&&'migrate_to_chat_id'in ctx.message&&ctx.chat?.type==='group'){await controller.groups.migrate(String(ctx.chat.id),String(ctx.message.migrate_to_chat_id));return;}
    if(!ctx.from||ctx.from.is_bot||!ctx.chat||!['private','group','supergroup'].includes(ctx.chat.type))return;
    if(ctx.message&&'sender_chat'in ctx.message&&ctx.message.sender_chat)return;
    const media=ctx.message&&'photo'in ctx.message?{...ctx.message.photo.at(-1)!,filename:'photo.jpg'}:ctx.message&&'document'in ctx.message?{...ctx.message.document,filename:ctx.message.document.file_name??'document'}:undefined;
    const text=ctx.message && 'text' in ctx.message?ctx.message.text:ctx.message&&'caption'in ctx.message?ctx.message.caption:undefined;
    const callback=ctx.callbackQuery && 'data' in ctx.callbackQuery?ctx.callbackQuery.data:undefined;
    if(!text && !callback && !media)return;
    const group=ctx.chat.type!=='private';
    if(group&&media)return;
    const mention=text?.match(/^\/\w+@([a-zA-Z0-9_]+)/);
    if(group&&mention&&mention[1].toLowerCase()!==controller.config.username.toLowerCase())return;
    if(group&&text&&!/^\/(?:bind|group|group_language|group_resume|unbind|start|create|help|dispute|evidence|arbitrate)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/.test(text))return;
    if(group&&text&&/^\/(?:create|help|start)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/.test(text)&&!/^\/start(?:@[a-zA-Z0-9_]+)?\s+bind_/.test(text)){await io.reply(ctx,await controller.groupHelp(String(ctx.from.id)));return;}
    try{
      let access={member:false,admin:false,botAdmin:false};
      if(group){if(io.groupAccess)access=await io.groupAccess(ctx);else{const self=await bot.telegram.getChatMember(ctx.chat.id,bot.botInfo!.id),member=await bot.telegram.getChatMember(ctx.chat.id,ctx.from.id);access={botAdmin:self.status==='administrator',admin:['creator','administrator'].includes(member.status),member:['creator','administrator','member'].includes(member.status)||(member.status==='restricted'&&member.is_member)};}if(!access.botAdmin||!access.member)throw Error('无法核验群成员身份，请确认机器人为群管理员');}
      const view=await controller.handle({actor:String(ctx.from.id),chatId:String(ctx.chat.id),chatType:ctx.chat.type as 'private'|'group'|'supergroup',groupMember:access.member,groupAdmin:access.admin,text,callback,attachment:media?{filename:media.filename,size:media.file_size,load:async()=>io.file?io.file(ctx,media.file_id):boundedDownload(await bot.telegram.getFileLink(media.file_id))}:undefined,updateId:ctx.update.update_id});
      if(view.attachmentId){const file=await new EvidenceFiles(controller.escrow).read(view.attachmentId,String(ctx.from.id));if(io.sendFile)await io.sendFile(ctx,file);else await ctx.replyWithDocument({source:Buffer.from(file.bytes),filename:file.filename});}
      await io.reply(ctx,view);
      if(!group&&(callback?.startsWith('lang:') || /^\/language(?:@[a-zA-Z0-9_]+)?\s+(en|zh)$/.test(text?.trim()??''))){
        const language=await controller.language(String(ctx.from.id));
        await bot.telegram.setMyCommands(language==='en'?BOT_COMMANDS_EN:BOT_COMMANDS,{scope:{type:'chat',chat_id:ctx.chat.id}}).catch(()=>{});
      }
    }catch(error){
      const internal=error && typeof error==='object' && ('code' in error || 'response' in error);
      const errorView=await controller.errorView(String(ctx.from.id),internal?'操作暂时失败，请刷新订单后重试。':error instanceof Error?error.message:'操作失败');
      await io.reply(ctx,group?{...errorView,buttons:undefined}:errorView);
    }
  });
  // Avoid logging updates, message contents or URLs containing bot tokens.
  bot.catch(()=>{process.stderr.write('Telegram 交互处理失败，请检查连接与本地日志策略。\n');});
  return bot;
}
