import { t } from './bot-language.js';
import type { Order } from './escrow.js';
export type Button = {
    text: string;
    callback_data: string;
    url?: never;
} | {
    text: string;
    url: string;
    callback_data?: never;
};
export interface View {
    text: string;
    attachmentId?: string;
    buttons?: Button[][];
    language?: 'zh'|'en';
}
export function amount(raw: string | bigint): string {
    const n = BigInt(raw), fraction = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `${n / 1000000n}${fraction ? '.' + fraction : ''}`;
}
export const states: Record<string, string> = {
    AWAITING_ACCEPTANCE: "待双方确认", AWAITING_DEPOSIT: "待模拟入金", FUNDED: "模拟资金已到账",
    AWAITING_CONFIRMATION: "待验收／确认收款", REFUND_REQUESTED: "退款协商中", DISPUTED: "争议处理中",
    SETTLING: "模拟结算中", COMPLETED: "已完成", REFUNDED: "已退款", ARBITRATED: "已仲裁结算", CLOSED: "已关闭"
};
export const button = (text: string, data: string): Button => ({ text, callback_data: data });
export function home(brand: string, completed: number, disputes: number): View {
    return { text: ("" + brand + t("\n\nTelegram 交易担保 · 模拟内测\n支持商品／服务担保和 USDT 买卖流程。\n\n模拟完成交易：") + completed + t("\n模拟已结争议：") + disputes + t("\n\n当前不接收真实资金，请勿向展示地址转账。")), buttons: [
            [button(t("创建担保交易"), 'menu:create')],
            [button(t("我的交易"), 'menu:orders'), button(t("收费规则"), 'menu:fees')],
            [button(t("使用说明"), 'menu:help'), button(t("什么是担保？"), 'menu:about')],
            [button(t("交易规则"), 'menu:rules'), button(t("流程演练"), 'help:tutorial')],
        [button(t("我的 Telegram ID"), 'menu:id')],
        [button('🌐 中文 / English','menu:language')]
        ] };
}
export function orderView(o: Order, actor: string, username: string): View {
    if (actor !== o.buyer_id && actor !== o.seller_id)
        throw new Error(t("无权查看此订单"));
    const isPayer = actor === (o.kind === 'PRODUCT' ? o.buyer_id : o.seller_id);
    const rows: Button[][] = [];
    const action = (text: string, act: string) => button(text, `act:${act}:${o.id}`);
    if (o.state === 'AWAITING_ACCEPTANCE')
        rows.push([button(t("确认交易条款"), `accept:${o.terms_version}:${o.id}`)]);
    if (['AWAITING_ACCEPTANCE', 'AWAITING_DEPOSIT'].includes(o.state))
        rows.push([action(t("取消订单"), 'CLOSE')]);
    if (o.state === 'AWAITING_DEPOSIT')
        rows.push([button(t("查看模拟入金说明"), `deposit:${o.id}`)]);
    if (o.state === 'FUNDED' && !isPayer)
        rows.push([action(o.kind === 'PRODUCT' ? t("我已交付") : t("我已支付法币"), 'DECLARE')]);
    if (o.state === 'AWAITING_CONFIRMATION' && isPayer)
        rows.push([action(o.kind === 'PRODUCT' ? t("确认收货并放款") : t("确认收到法币并放币"), 'RELEASE')]);
    if (['FUNDED', 'AWAITING_CONFIRMATION'].includes(o.state))
        rows.push([action(t("申请退款"), 'REQUEST_REFUND')]);
    if (o.state === 'REFUND_REQUESTED' && actor !== o.refund_requester)
        rows.push([action(t("同意退款"), 'AGREE_REFUND'), action(t("拒绝退款"), 'REJECT_REFUND')]);
    if (['FUNDED', 'AWAITING_CONFIRMATION', 'REFUND_REQUESTED'].includes(o.state))
        rows.push([action(t("发起争议"), 'DISPUTE')]);
    if (o.state === 'AWAITING_ACCEPTANCE' || o.state === 'AWAITING_DEPOSIT')
        rows.push([{
                text: t("分享给交易对方"), url: `https://t.me/${username}?start=order_${o.id}`
            }]);
    rows.push([button(t("刷新订单"), `order:${o.id}`), button("返回首页", 'menu:home')]);
    rows.push([button(t("模拟余额"), `balance:${o.id}`), button(t("出入金记录"), `blockchain:${o.id}`)]);
    rows.push([button(t("查看交易条款"), `terms:${o.id}`)]);
    if (['DISPUTED', 'ARBITRATED'].includes(o.state))
        rows.push([button(t("争议记录与证据说明"), `evidence:${o.id}`)]);
    if(o.manual_review)for(let n=rows.length-1;n>=0;n--){rows[n]=rows[n].filter(b=>!b.callback_data?.startsWith('accept:')&&(!b.callback_data?.startsWith('act:')||b.callback_data.startsWith('act:DISPUTE:')));if(!rows[n].length)rows.splice(n,1);}
    const timing=o.manual_review?t('\n超时待人工处理：普通操作暂停，资金保留。'):o.deadline_at?t('\n当前阶段截止时间：')+new Date(o.deadline_at).toISOString():'';
    return { text: timing+"\n"+(t("担保订单 · 模拟内测\n编号：") + o.id + t("\n类型：") + (o.kind === 'PRODUCT' ? t("商品／服务交易") : t("USDT 买卖")) + t("\n状态：") + t(states[o.state]) + t("\n条款版本：") + o.terms_version + t("\n\n买家 ID：") + o.buyer_id + t("\n卖家 ID：") + o.seller_id + t("\n本金：") + amount(o.principal) + t(" USDT\n担保费：") + amount(o.fee) + t(" USDT\n应付总额：") + amount(o.expected_deposit) + t(" USDT\n费用承担：") + (o.kind === 'PRODUCT' ? t("买家") : t("卖家")) + t("\n\n买家模拟钱包：") + o.buyer_address + t("\n卖家模拟钱包：") + o.seller_address + t("\n\n交易约定：") + o.description + "\n\n" + (o.kind === 'PRODUCT' ? t("买家存入模拟资金，卖家交付，买家验收后放款。") : t("卖家存入模拟资金，买家声明支付法币，卖家确认到账后放币。")) + t("\n当前不接收真实资金。")), buttons: rows };
}
