import {Telegraf} from 'telegraf';
import {boundTelegramRequests} from '../telegram-requests.js';
import type {AuthDatabase} from './admin-auth.js';
import {ProductionTelegramController} from './telegram-controller.js';
import {createProductionTelegramBot,productionCommands,groupCommands,keyboard} from './telegram-bot.js';
import {ProductionNotifications} from './telegram-notifications.js';
import {ProductionGroups} from './groups.js';

export function validateProductionToken(value:string){if(typeof value!=='string'||value.length>256||!/^\d+:[a-zA-Z0-9_-]{20,}$/.test(value))throw Error('请填写有效的机器人 Token');}
export class ProductionTelegramRuntime{
  private token:string;private phase='stopped';private username='';private lastError='';
  private bot?:Telegraf;private task?:Promise<void>;private controller?:AbortController;
  private timer?:ReturnType<typeof setInterval>;private work?:Promise<unknown>;private stopTask?:Promise<void>;private generation=0;
  private configuring=false;
  constructor(private db:AuthDatabase,token='',private testnetMonitoring:()=>boolean=()=>false,private testnetPayouts:()=>boolean=()=>false){this.token=token;}
  // Administrator alerts go out only while the bot is connected; callers retry later otherwise.
  async sendText(chatId:string,text:string){if(this.phase!=='running'||!this.bot)throw Error('bot offline');await this.bot.telegram.sendMessage(chatId,text);}
  status(){return {state:this.configuring?'configuring':this.phase,username:this.username,error:this.lastError,configured:Boolean(this.token)};}
  async configure(token:string,save:(token:string)=>Promise<void>){
    validateProductionToken(token);if(this.configuring||!['stopped','error'].includes(this.phase))throw Error('请先停止正式机器人再修改 Token');
    this.configuring=true;try{await this.stop();await save(token);this.token=token;this.username='';this.lastError='';}finally{this.configuring=false;}
  }
  async start(){
    validateProductionToken(this.token);if(this.configuring||!['stopped','error'].includes(this.phase)||this.stopTask)throw Error('机器人已连接或正在连接');
    if(this.phase==='error')await this.stop();
    this.phase='starting';this.lastError='';const generation=++this.generation,controller=new AbortController();this.controller=controller;
    let timeout:ReturnType<typeof setTimeout>|undefined,legacyActive=false,attemptBot:Telegraf|undefined;
    try{
      const probe=new Telegraf(this.token);boundTelegramRequests(probe.telegram,controller.signal);
      const info=await Promise.race([probe.telegram.getMe(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('probe timeout')),12000);})]);
      if(generation!==this.generation||!info.username)throw Error('start cancelled');
      if(timeout)clearTimeout(timeout);
      try{
        const response=await fetch('http://127.0.0.1:8781/api/settings',{signal:AbortSignal.timeout(2000)});
        if(response.ok){const previous=await response.json() as {bot?:{state:string;username:string}};legacyActive=Boolean(previous.bot&&['running','starting','stopping'].includes(previous.bot.state)&&previous.bot.username?.toLowerCase()===info.username.toLowerCase());}
      }catch{}
      if(legacyActive)throw Error('legacy bot active');
      const router=new ProductionTelegramController(this.db,info.username,this.testnetMonitoring,this.testnetPayouts),groups=new ProductionGroups(this.db,info.username),bot=createProductionTelegramBot(this.token,router,controller.signal,undefined,groups);attemptBot=bot;this.bot=bot;bot.botInfo=info;this.username=info.username;
      const notifications=new ProductionNotifications(router,(chat,view)=>bot.telegram.sendMessage(chat,view.text,{reply_markup:{inline_keyboard:keyboard(view)}}),groups);
      const tick=()=>{if(this.work)return;this.work=notifications.flush().catch(()=>{this.lastError='状态通知暂时失败，将重试';}).finally(()=>{this.work=undefined;});};
      let resolveReady:()=>void=()=>{},rejectReady:(reason:Error)=>void=()=>{};const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
      this.task=bot.launch({dropPendingUpdates:false,allowedUpdates:['message','callback_query','my_chat_member','chat_join_request']},()=>{
        if(generation!==this.generation){try{bot.stop();}catch{}rejectReady(Error('cancelled'));return;}
        this.phase='running';this.timer=setInterval(tick,3000);tick();resolveReady();
        void this.resetCommands(bot).catch(()=>{this.lastError='菜单更新失败，可直接输入命令';});
      }).catch(()=>{if(generation===this.generation){this.phase='error';this.lastError='Telegram连接失败，请检查网络、Token或重复实例';if(this.timer)clearInterval(this.timer);}rejectReady(Error('connection failed'));});
      await Promise.race([ready,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('start timeout')),15000);})]);return this.status();
    }catch{
      controller.abort();if(generation===this.generation){this.phase='error';this.lastError=legacyActive?'同一机器人仍在模拟版运行，请先停止模拟机器人':'连接失败，请检查网络、Token或相同机器人的其他轮询实例';}
      try{attemptBot?.stop();}catch{}throw Error(legacyActive?'同一机器人仍在模拟版运行，请先停止模拟机器人':'正式机器人连接失败，请检查本机配置和网络');
    }finally{if(timeout)clearTimeout(timeout);}
  }
  // A bot token previously used by the simulation may still carry its per-language and per-chat menus,
  // which Telegram shows in preference to the default menu. Replace both with the production commands.
  private async resetCommands(bot:Telegraf){
    await bot.telegram.setMyCommands(productionCommands.zh);await bot.telegram.setMyCommands(productionCommands.en,{language_code:'en'});
    await bot.telegram.setMyCommands(groupCommands.zh,{scope:{type:'all_group_chats'}});await bot.telegram.setMyCommands(groupCommands.en,{scope:{type:'all_group_chats'},language_code:'en'});
    for(const {chat_id,language} of (await this.db.query<{chat_id:string;language:'zh'|'en'}>('SELECT chat_id::text,language FROM production_group_settings LIMIT 500')).rows)await bot.telegram.setMyCommands(groupCommands[language==='en'?'en':'zh'],{scope:{type:'chat',chat_id:Number(chat_id)}}).catch(()=>{});
    const chats=(await this.db.query<{chat_id:string;language:'zh'|'en'}>('SELECT chat_id::text,language FROM production_contacts ORDER BY updated_at DESC LIMIT 500')).rows;
    for(const {chat_id,language} of chats)await bot.telegram.setMyCommands(productionCommands[language==='en'?'en':'zh'],{scope:{type:'chat',chat_id:Number(chat_id)}}).catch(()=>{});
  }
  async stop(){
    if(this.stopTask)return this.stopTask;
    ++this.generation;this.phase='stopping';if(this.timer)clearInterval(this.timer);this.controller?.abort();try{this.bot?.stop();}catch{}
    this.stopTask=(async()=>{await Promise.all([this.task?.catch(()=>{}),this.work?.catch(()=>{})]);this.bot=undefined;this.task=undefined;this.work=undefined;this.phase='stopped';this.lastError='';})().finally(()=>{this.stopTask=undefined;});return this.stopTask;
  }
}
