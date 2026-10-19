import {boundTelegramRequests} from './telegram-requests.js';
import { Telegraf } from 'telegraf';
import { Escrow } from './escrow.js';
import { BotController } from './bot-controller.js';
import { createBot } from './telegram-bot.js';
import { BotNotifications } from './bot-notifications.js';
import { SimulationWorker } from './simulation-worker.js';
import type { Settings } from './local-settings.js';
import { BOT_COMMANDS, BOT_COMMANDS_EN } from './bot-commands.js';
type BotInfo=Awaited<ReturnType<Telegraf['telegram']['getMe']>>;
// Dependency injection is for isolated fault tests; the panel always uses the real defaults.
export interface RuntimeTransport {
  getMe?:(token:string)=>Promise<BotInfo>;
  createBot?:(token:string,controller:BotController)=>Telegraf;
  worker?:(escrow:Escrow)=>{tick():Promise<void>};
}
export class BotRuntime {
  private bot?:Telegraf;private task?:Promise<void>;private timer?:ReturnType<typeof setInterval>;
  private work?:Promise<unknown>;private generation=0;private connectionAbort?:AbortController;
  private stopTask?:Promise<{state:string;username:string;error:string}>;
  private state:'stopped'|'starting'|'running'|'stopping'|'error'='stopped';private username='';private lastError='';
  constructor(private escrow:Escrow,private transport:RuntimeTransport={}){}
  status(){return {state:this.state,username:this.username,error:this.lastError};}
  async start(settings:Settings){
    if(this.state==='running' || this.state==='starting' || this.state==='stopping' || this.stopTask)throw new Error('机器人已经启动或正在连接');
    if(!/^\d+:[a-zA-Z0-9_-]{20,}$/.test(settings.token))throw new Error('请先保存有效的测试机器人 Token');
    if(this.state==='error')await this.quiesce();
    this.state='starting';this.lastError='';const generation=++this.generation,connection=new AbortController();this.connectionAbort=connection;
    let timeout:ReturnType<typeof setTimeout>|undefined,attemptBot:Telegraf|undefined;
    try{
      const probe=new Telegraf(settings.token);boundTelegramRequests(probe.telegram,connection.signal);
      const info=await Promise.race([(this.transport.getMe?this.transport.getMe(settings.token):probe.telegram.getMe()),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('连接超时')),12000);})]);
      if(generation!==this.generation)throw new Error('连接已取消');
      if(!info.username)throw new Error('机器人用户名不可用');
      const controller=new BotController(this.escrow,{username:info.username,brand:settings.brand,minimumFee:settings.minimumFee,feeBps:settings.feeBps});
      const bot=this.transport.createBot?.(settings.token,controller)??createBot(settings.token,controller,undefined,connection.signal);attemptBot=bot;bot.botInfo=info;this.bot=bot;this.username=info.username;
      const notices=new BotNotifications(controller,(chat,view)=>bot.telegram.sendMessage(chat,view.text,{reply_markup:{inline_keyboard:view.buttons??[]}}));
      const simulator=this.transport.worker?.(this.escrow)??new SimulationWorker(this.escrow);
      let resolveReady:()=>void=()=>{},rejectReady:(error:Error)=>void=()=>{};
      const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
      this.task=bot.launch({dropPendingUpdates:false,allowedUpdates:['message','callback_query','my_chat_member']},()=>{
        if(generation!==this.generation){bot.stop('cancelled');rejectReady(new Error('连接已取消'));return;}
        this.state='running';resolveReady();
        void Promise.all([bot.telegram.setMyCommands(BOT_COMMANDS),bot.telegram.setMyCommands(BOT_COMMANDS_EN,{language_code:'en'})]).catch(()=>{this.lastError='命令菜单更新失败，仍可直接输入命令。';});
        const tick=()=>{if(this.work)return;this.work=simulator.tick().then(()=>notices.flush()).catch(()=>{this.lastError='模拟结算或通知失败，将自动重试。';}).finally(()=>{this.work=undefined;});};
        this.work=notices.scheduleCurrent().then(()=>simulator.tick()).then(()=>notices.flush()).catch(()=>{this.lastError='启动状态恢复或通知暂时失败，将自动重试。';}).finally(()=>{this.work=undefined;});
        this.timer=setInterval(tick,3000);
      }).catch(()=>{
        if(generation===this.generation){this.state='error';this.lastError='Telegram 连接失败，请检查 Token、网络或重复运行的机器人实例。';if(this.timer)clearInterval(this.timer);}
        rejectReady(new Error('Telegram 连接失败'));
      });
      await Promise.race([ready,new Promise<never>((_,reject)=>{if(timeout)clearTimeout(timeout);timeout=setTimeout(()=>reject(new Error('启动超时')),15000);})]);
      return this.status();
    }catch{
      connection.abort();
      if(generation===this.generation){++this.generation;this.state='error';this.lastError='连接失败，请检查测试 Token、网络及是否存在其他轮询实例。';if(this.timer)clearInterval(this.timer);}
      if(attemptBot){try{attemptBot.stop('start failed');}catch{}}
      throw new Error('Telegram 连接失败；请检查本机配置和网络，Token 不会显示在错误信息中。');
    }finally{if(timeout)clearTimeout(timeout);}
  }
  async stop(){
    if(this.stopTask)return this.stopTask;
    ++this.generation;if(this.timer)clearInterval(this.timer);this.state='stopping';
    const bot=this.bot,task=this.task,work=this.work;this.connectionAbort?.abort();
    this.stopTask=(async()=>{
      if(bot){try{bot.stop('control panel');}catch{}}
      // Never allow a replacement worker while its predecessor is still sending or writing.
      await Promise.all([task?.catch(()=>{}),work?.catch(()=>{})]);
      this.bot=undefined;this.task=undefined;this.work=undefined;this.state='stopped';this.lastError='';return this.status();
    })().finally(()=>{this.stopTask=undefined;});
    return this.stopTask;
  }
  async quiesce(){
    await this.stop();
    if(this.task)await this.task;
    if(this.work)await this.work;
  }
}
