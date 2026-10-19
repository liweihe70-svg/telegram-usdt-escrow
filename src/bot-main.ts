import {boundTelegramRequests} from './telegram-requests.js';
import { OrderTimeouts } from './order-timeouts.js';
import { Escrow } from './escrow.js';
import { BotController } from './bot-controller.js';
import { createBot } from './telegram-bot.js';
import { BotNotifications } from './bot-notifications.js';
import { SimulationWorker } from './simulation-worker.js';
import { BOT_COMMANDS, BOT_COMMANDS_EN } from './bot-commands.js';

const token=process.env.TELEGRAM_BOT_TOKEN?.trim();
if(!token || !/^\d+:[a-zA-Z0-9_-]+$/.test(token)){
  process.stderr.write('请在项目本地 .env 中配置 TELEGRAM_BOT_TOKEN，再运行 npm run bot。不要将 Token 发到聊天中。\n');
  process.exit(1);
}
let escrow:Escrow|undefined;
let timer:ReturnType<typeof setInterval>|undefined;
const pending=new Set<Promise<unknown>>(),connection=new AbortController();
try{
  const admins=(process.env.ADMIN_TELEGRAM_IDS??'').split(',').map(s=>s.trim()).filter(Boolean);
  const dataDir=process.env.BOT_DATA_DIR??'data/telegram-demo';
  if(!dataDir.startsWith('data/') || dataDir.includes('..') || dataDir.includes('\\'))throw new Error('开发数据路径无效');
  escrow=await Escrow.open(dataDir,admins);
  // getMe determines the actual bot username used in invitations.
  const { Telegraf }=await import('telegraf');
  const probe=new Telegraf(token);boundTelegramRequests(probe.telegram,connection.signal);
  const info=await probe.telegram.getMe();
  if(!info.username)throw new Error('机器人缺少用户名');
  const controller=new BotController(escrow,{
    username:info.username,brand:process.env.BOT_BRAND??'USDT 交易担保',
    minimumFee:process.env.FEE_MIN_USDT??'5',feeBps:Number(process.env.FEE_BPS??'500')
  });
  const bot=createBot(token,controller,undefined,connection.signal);bot.botInfo=info;
  const notices=new BotNotifications(controller,(chat,view)=>bot.telegram.sendMessage(chat,view.text,{reply_markup:{inline_keyboard:view.buttons??[]}}));
  const simulation=new SimulationWorker(escrow),timeouts=new OrderTimeouts(escrow);
  const track=(p:Promise<unknown>)=>{pending.add(p);void p.finally(()=>pending.delete(p)).catch(()=>{});};
  let launched=false,stopping=false;
  async function shutdown(){
    if(stopping)return;stopping=true;
    if(timer)clearInterval(timer);connection.abort();
    if(launched)bot.stop('shutdown');
  }
  process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
  await bot.launch({dropPendingUpdates:false,allowedUpdates:['message','callback_query','my_chat_member']},()=>{
    launched=true;
    void Promise.all([bot.telegram.setMyCommands(BOT_COMMANDS),bot.telegram.setMyCommands(BOT_COMMANDS_EN,{language_code:'en'})]).catch(()=>process.stderr.write('命令菜单更新失败，仍可直接输入命令。\n'));
    process.stdout.write('Telegram 模拟资金机器人已启动。真实钱包未连接。\n');
    track(notices.scheduleCurrent().then(()=>timeouts.tick()).then(()=>simulation.tick()).then(()=>notices.flush()).catch(()=>process.stderr.write('启动通知恢复失败。\n')));
    timer=setInterval(()=>{track(timeouts.tick().then(()=>simulation.tick()).then(()=>notices.flush()).catch(()=>process.stderr.write('模拟结算或订单通知暂时失败，稍后重试。\n')));},3000);
  });
}catch{
  process.stderr.write('机器人启动或连接失败。请检查本地配置、网络及是否有其他实例正在轮询同一 Token。\n');
  process.exitCode=1;
}finally{
  if(timer)clearInterval(timer);connection.abort();
  await Promise.allSettled([...pending]);
  if(escrow)await escrow.db.close();
}
