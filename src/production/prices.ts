// Estimated conversions for /convert. Informational only: never used for deposits, fees or payouts.
const IDS:Record<string,string>={btc:'bitcoin',eth:'ethereum',bnb:'binancecoin',ltc:'litecoin',trx:'tron',usdt:'tether',sol:'solana',ton:'the-open-network'};
const FIAT=['usd','cny','eur'];
let cache:{at:number;prices:Record<string,Record<string,number>>}|null=null;
export type PriceFetch=(url:string)=>Promise<Record<string,Record<string,number>>>;
const defaultFetch:PriceFetch=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('price');return await r.json() as Record<string,Record<string,number>>;};
async function prices(get:PriceFetch){
  if(cache&&Date.now()-cache.at<60000)return cache.prices;
  const fresh=await get(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(IDS).join(',')}&vs_currencies=${FIAT.join(',')}`);
  cache={at:Date.now(),prices:fresh};return fresh;
}
export function resetPriceCache(){cache=null;}
// Value of one unit of `symbol` in USD.
const usdOf=(p:Record<string,Record<string,number>>,symbol:string)=>symbol==='usd'?1:FIAT.includes(symbol)?1/(p.tether?.[symbol]??NaN)*(p.tether?.usd??1):p[IDS[symbol]]?.usd;
const esc=(v:string)=>v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// Returns Telegram HTML; the bot sends it with parse_mode HTML.
export async function convert(text:string,en:boolean,get:PriceFetch=defaultFetch,brandName='Escrow'):Promise<{text:string}>{
  const m=text.trim().match(/^\/convert(?:@[a-zA-Z0-9_]+)?\s+(\d+(?:\.\d+)?)\s+([a-zA-Z]+)\s+([a-zA-Z]+)$/);
  const name=esc(brandName),usage={text:en?`━━━━ ⚡️ ${name} ━━━━\n\n❌ <u>INVALID FORMAT</u>\n\n📝 FORMAT: /convert amount from_coin to_coin\n\nEXAMPLES:\n• /convert 0.00009 btc usd\n• /convert 1000 usd btc\n• /convert 0.00007 btc ltc\n\n<i>This command is only for obtaining an estimated exchange value of any cryptocurrency to any currency</i>`:`━━━━ ⚡️ ${name} ━━━━\n\n❌ <u>格式错误</u>\n\n📝 格式：/convert 数量 原币种 目标币种\n\n例如：\n• /convert 0.00009 btc usd\n• /convert 1000 usd btc\n• /convert 0.00007 btc ltc\n\n<i>本命令仅用于估算任意加密货币与法币之间的兑换价值</i>`};
  if(!m)return usage;
  const amount=Number(m[1]),from=m[2].toLowerCase(),to=m[3].toLowerCase();
  if(!(from in IDS||FIAT.includes(from))||!(to in IDS||FIAT.includes(to))||!Number.isFinite(amount))return usage;
  try{
    const p=await prices(get),a=usdOf(p,from),b=usdOf(p,to);if(!a||!b||!Number.isFinite(a)||!Number.isFinite(b))throw Error();
    const result=amount*a/b,shown=result>=1?result.toFixed(4):result.toPrecision(6);
    return {text:en?`💱 ${m[1]} ${from.toUpperCase()} ≈ ${shown} ${to.toUpperCase()}\n<i>Estimate only (CoinGecko); not used for deposits or payouts.</i>`:`💱 ${m[1]} ${from.toUpperCase()} ≈ ${shown} ${to.toUpperCase()}\n<i>仅供估算（CoinGecko），不用于入金或出款。</i>`};
  }catch{return {text:en?'Price service unavailable, try again later.':'价格服务暂时不可用，请稍后再试。'};}
}
