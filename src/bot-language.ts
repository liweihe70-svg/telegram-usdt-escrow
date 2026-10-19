import { AsyncLocalStorage } from 'node:async_hooks';
import { english } from './bot-english.js';
import type { View } from './bot-ui.js';

export type Language='zh'|'en';
const scope=new AsyncLocalStorage<Language>();
export const withLanguage=<T>(language:Language,work:()=>T):T=>scope.run(language,work);
export const translate=(systemText:string,language:Language):string=>language==='en'?(english[systemText]??systemText):systemText;
export const t=(systemText:string):string=>translate(systemText,scope.getStore()??'zh');

// Buttons may be shared constants created before a request's language context.
// The message body is never translated here: it can contain user-authored data.
export function localizeButtons(view:View,language:Language):View {
  return {...view,buttons:view.buttons?.map(row=>row.map(b=>({...b,text:translate(b.text,language)})))};
}
const errors:Record<string,string>={
  '金额必须为最多六位小数的非负字符串':'Amounts must be non-negative decimal strings with up to six decimal places',
  '超过模拟金额上限':'The simulated amount limit was exceeded',
  '无效用户 ID':'Invalid user ID',
  '仅接受 sim: 开头的模拟地址':'Only simulated addresses starting with sim: are accepted',
  '不是订单参与者':'You are not a participant in this order',
  '订单不存在':'Order not found',
  '金额超限或本金为零':'The amount exceeds the limit or the principal is zero',
  '买卖双方必须不同':'The buyer and seller must be different users',
  '无效请求编号':'Invalid request ID',
  '重复请求的订单内容不一致':'The repeated request has different order details',
  '条款版本已过期':'The terms version has expired',
  '不是已确认的模拟 USDT 成功转账':'This is not a confirmed successful simulated USDT transfer',
  '无效链上事件':'Invalid transfer event',
  '入金必须大于零':'The deposit must be greater than zero',
  '收款地址不匹配':'The deposit address does not match',
  '同一链上事件内容冲突':'Conflicting details for the same transfer event',
  '争议理由须为1至1000字':'The dispute reason must contain 1–1000 characters',
  '仅交付方或法币付款方可以声明完成':'Only the delivery party or fiat payer can declare completion',
  '无放款权限':'You are not authorized to release funds',
  '只能由另一方拒绝退款':'Only the other party can reject a refund',
  '不能自行批准退款':'You cannot approve your own refund request',
  '结算金额不守恒':'Settlement allocations do not balance',
  '托管账本余额不匹配':'The escrow ledger balance does not match',
  '无仲裁权限':'You are not authorized to arbitrate',
  '必须填写有效裁决理由':'Provide a valid ruling reason',
  '出款哈希不匹配':'The payout hash does not match',
  '出款尚未广播':'The payout has not been broadcast yet',
  '操作暂时失败，请刷新订单后重试。':'The operation failed temporarily. Refresh the order and try again.',
  '操作失败':'Operation failed',
  '请在与机器人的私聊中创建或操作订单。担保群绑定尚未接入。':'Create or operate orders in a private chat with the bot. Escrow groups are not integrated yet.'
};
export function translateError(message:string,language:Language):string {
  if(language==='zh')return message;
  if(message.startsWith('当前状态不允许操作：'))return 'This action is not allowed in the current state: '+message.slice('当前状态不允许操作：'.length);
  return errors[message]??translate(message,language);
}
