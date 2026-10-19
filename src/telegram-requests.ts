import type {Telegram} from 'telegraf';
// Telegraf's default HTTP timeout is too long for a controlled local shutdown.
// Keep long polling's 50-second server wait, but bound ordinary API requests.
export function boundTelegramRequests(telegram:Telegram,lifecycle?:AbortSignal,timeoutMs=15000){
 const call=telegram.callApi.bind(telegram);
 telegram.callApi=(async(method:any,payload:any,options:any={})=>{
  const request=new AbortController(),upstream=options.signal as AbortSignal|undefined;
  const cancel=()=>request.abort();let timedOut=false;
  lifecycle?.addEventListener('abort',cancel,{once:true});upstream?.addEventListener('abort',cancel,{once:true});
  if(lifecycle?.aborted||upstream?.aborted)request.abort();
  const wait=method==='getUpdates'&&payload?.timeout?Math.max(timeoutMs,(Number(payload.timeout)+15)*1000):timeoutMs;
  const timer=setTimeout(()=>{timedOut=true;request.abort();},wait);
  try{return await call(method,payload,{signal:request.signal as never});}
  catch(error){
   if(timedOut&&!lifecycle?.aborted&&!upstream?.aborted)throw Object.assign(new Error('Telegram 请求超时'),{name:'FetchError',code:'REQUEST_TIMEOUT'});
   throw error;
  }finally{clearTimeout(timer);lifecycle?.removeEventListener('abort',cancel);upstream?.removeEventListener('abort',cancel);}
 }) as Telegram['callApi'];
}
