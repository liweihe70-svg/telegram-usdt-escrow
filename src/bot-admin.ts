import { OrderTimeouts } from './order-timeouts.js';
import { t } from './bot-language.js';
import { randomUUID } from 'node:crypto';
import { Escrow, units, type Order } from './escrow.js';
import { amount, button, states, type View } from './bot-ui.js';
export const DEMO_PEER = '9007199254740991';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const back = [button("返回首页", 'menu:home')];
export function ownsDemo(o: Order, actor: string): boolean {
    return (o.buyer_id === actor && o.seller_id === DEMO_PEER && o.seller_address === `sim:demo_${actor}`)
        || (o.seller_id === actor && o.buyer_id === DEMO_PEER && o.buyer_address === `sim:demo_${actor}`);
}
function demoActions(o: Order): Array<[
    string,
    string
]> {
    const peerPays = DEMO_PEER === (o.kind === 'PRODUCT' ? o.buyer_id : o.seller_id);
    if (o.state === 'AWAITING_ACCEPTANCE')
        return [[t("模拟对方确认条款"), 'ACCEPT']];
    if (o.state === 'AWAITING_DEPOSIT')
        return [[t("注入足额模拟入金"), 'DEPOSIT']];
    if (o.state === 'FUNDED' && !peerPays)
        return [[o.kind === 'PRODUCT' ? t("模拟对方交付") : t("模拟对方支付法币"), 'DECLARE']];
    if (o.state === 'AWAITING_CONFIRMATION' && peerPays)
        return [[o.kind === 'PRODUCT' ? t("模拟对方验收放款") : t("模拟对方确认到账放币"), 'RELEASE']];
    if (o.state === 'REFUND_REQUESTED' && o.refund_requester !== DEMO_PEER)
        return [[t("模拟对方同意退款"), 'AGREE_REFUND'], [t("模拟对方拒绝退款"), 'REJECT_REFUND']];
    return [];
}
export class BotAdmin {
    constructor(private escrow: Escrow) { }
    decorate(o: Order, actor: string, view: View, peerAccepted = false): View {
        if(o.manual_review)return view;
        if (!ownsDemo(o, actor))
            return view;
        const buttons = (view.buttons ?? []).map(row => row.filter(b => !b.url)).filter(row => row.length);
        if (this.escrow.isAdmin(actor))
            for (const [label, action] of demoActions(o))
                if (action !== 'ACCEPT' || !peerAccepted)
                    buttons.unshift([button(label, `demo:${action}:${o.id}`)]);
        return { ...view, text: t("单账号演练 · 对方为系统模拟身份，未连接真实用户。\n") + view.text, buttons };
    }
    private requireAdmin(actor: string) { if (!this.escrow.isAdmin(actor))
        throw new Error(t("此入口仅限已配置的测试管理员")); }
    async handle(actor: string, command: string | undefined, text: string | undefined, callback: string | undefined): Promise<View | undefined> {
        if (command === '/admin' || callback === 'menu:admin') {
            this.requireAdmin(actor);
            return { text: t("模拟内测管理\n单账号演练使用系统模拟对方，不代替真实交易参与人。\n争议需要管理员明确分配金额，不自动裁决。"), buttons: [[button(t("开始单账号演练"), 'menu:demo')], [button(t("待处理争议"), 'admin:disputes')], [button(t('超时待处理'),'scheduler:reviews')], back] };
        }
        const timers=new OrderTimeouts(this.escrow);
        if(callback==='scheduler:reviews'){this.requireAdmin(actor);const rows=await timers.reviews();return {text:t('超时待处理（最多20笔）'),buttons:[...rows.map(r=>[button(r.order_id.slice(0,8)+' · '+t(states[r.stage]),'scheduler:view:'+r.order_id)]),[button(t('管理菜单'),'menu:admin')]]};}
        if(callback?.startsWith('scheduler:view:')){this.requireAdmin(actor);const id=callback.slice(15);if(!uuid.test(id))throw Error(t('无效订单编号'));const o=await this.escrow.get(id);if(!o.manual_review)throw Error(t('超时记录已变化，请刷新订单后重试'));return {text:t('超时待处理：')+id+'\n'+t(states[o.state])+t('\n恢复后重新计时，不执行放款或退款。'),buttons:[[button(t('确认恢复普通处理'),`scheduler:resume:${id}:${o.timer_revision}`)],...(o.state==='DISPUTED'?[[button(t('待处理争议'),'admin:disputes')]]:[]),[button(t('返回'),'scheduler:reviews')]]};}
        if(callback?.startsWith('scheduler:resume:')){this.requireAdmin(actor);const [, ,id,rev]=callback.split(':');if(!uuid.test(id)||!Number.isSafeInteger(Number(rev)))throw Error(t('无效订单编号'));await timers.resume(id,actor,Number(rev));return {text:t('已恢复普通处理并重新计时，资金未变动。'),buttons:[[button(t('超时待处理'),'scheduler:reviews')]]};}
        if (command === '/disputes' || callback === 'admin:disputes') {
            this.requireAdmin(actor);
            const rows = (await this.escrow.db.query<{
                id: string;
            }>('SELECT id FROM orders WHERE state=$1 ORDER BY created_at DESC LIMIT 20', ['DISPUTED'])).rows;
            return { text: rows.length ? t("待处理模拟争议（最近20笔）") : t("当前没有待处理争议。"), buttons: [...rows.map(r => [button((t("争议 ") + r.id.slice(0, 8) + ""), `admin:order:${r.id}`)]), [button(t("管理菜单"), 'menu:admin')]] };
        }
        if (callback?.startsWith('admin:order:')) {
            this.requireAdmin(actor);
            const id = callback.slice('admin:order:'.length);
            if (!uuid.test(id))
                throw new Error(t("无效订单编号"));
            const o = await this.escrow.get(id);
            if (o.state !== 'DISPUTED')
                throw new Error(t("订单当前不在争议中"));
            return { text: (t("模拟争议详情\n编号：") + id + t("\n类型：") + o.kind + t("\n状态：") + t(states[o.state]) + t("\n本金：") + amount(o.principal) + t(" USDT\n可分配：") + amount(o.expected_deposit) + t(" USDT\n约定：") + o.description + t("\n\n准备裁决：\n/arbitrate ") + id + t(" 买家金额 卖家金额 裁决理由\n双方合计必须等于可分配金额；提交后仍须二次确认。")), buttons: [[button(t("争议理由与证据说明"), `evidence:${id}`)], [button(t("返回争议列表"), 'admin:disputes')]] };
        }
        if (command === '/arbitrate') {
            this.requireAdmin(actor);
            const parts = text!.trim().split(/\s+/), [, id, buyer, seller, ...reasonParts] = parts, reason = reasonParts.join(' ');
            if (!id || !uuid.test(id) || !buyer || !seller || !reason.trim() || reason.length > 2000)
                throw new Error(t("格式：/arbitrate 完整订单编号 买家金额 卖家金额 裁决理由"));
            const o = await this.escrow.get(id);
            if (o.state !== 'DISPUTED')
                throw new Error(t("订单当前不在争议中"));
            if (units(buyer) + units(seller) !== BigInt(o.expected_deposit))
                throw new Error(t("分配金额合计必须等于订单可分配资金"));
            const proposal = randomUUID();
            // Keep only the newest pending proposal for this administrator and order.
            await this.escrow.db.transaction(async (tx) => {
                await tx.query('DELETE FROM bot_admin_proposals WHERE admin_id=$1 AND order_id=$2', [actor, id]);
                await tx.query('INSERT INTO bot_admin_proposals(id,admin_id,order_id,buyer_amount,seller_amount,reason) VALUES($1,$2,$3,$4,$5,$6)', [proposal, actor, id, buyer, seller, reason]);
            });
            return { text: (t("请核对模拟仲裁方案\n订单：") + id + t("\n给买家：") + buyer + t(" USDT\n给卖家：") + seller + t(" USDT\n本次费用：0\n理由：") + reason + t("\n方案10分钟内有效。确认后进入模拟结算，不能普通撤回。")), buttons: [[button(t("确认模拟裁决"), `arb:${proposal}`)], [button(t("取消裁决"), `arb_cancel:${proposal}`)]] };
        }
        if (callback?.startsWith('arb:') || callback?.startsWith('arb_cancel:')) {
            this.requireAdmin(actor);
            const id = callback.split(':')[1];
            if (!uuid.test(id))
                throw new Error(t("无效裁决方案"));
            const proposal = (await this.escrow.db.query<{
                order_id: string;
                buyer_amount: string;
                seller_amount: string;
                reason: string;
            }>('SELECT order_id,buyer_amount,seller_amount,reason FROM bot_admin_proposals WHERE id=$1 AND admin_id=$2 AND expires_at>now()', [id, actor])).rows[0];
            if (!proposal)
                throw new Error(t("裁决方案已失效或无权操作，请重新准备"));
            if (callback.startsWith('arb_cancel:')) {
                await this.escrow.db.query('DELETE FROM bot_admin_proposals WHERE id=$1', [id]);
                return { text: t("已取消裁决方案，订单资金未变动。"), buttons: [[button(t("待处理争议"), 'admin:disputes')]] };
            }
            await this.escrow.arbitrate(proposal.order_id, actor, proposal.buyer_amount, proposal.seller_amount, proposal.reason);
            await this.escrow.db.query('DELETE FROM bot_admin_proposals WHERE id=$1', [id]);
            return { text: (t("模拟裁决已提交\n订单：") + proposal.order_id + t("\n后台将自动处理模拟结算，结果通知已登记的参与方。")), buttons: [[button(t("管理菜单"), 'menu:admin')]] };
        }
        if (callback?.startsWith('demo:') || callback?.startsWith('democ:')) {
            this.requireAdmin(actor);
            const [prefix, action, id] = callback.split(':');
            if (!uuid.test(id))
                throw new Error(t("无效演练订单"));
            const o = await this.escrow.get(id);
            if(o.manual_review)throw Error(t("订单超时待人工处理，普通操作已暂停"));
        if (!ownsDemo(o, actor))
                throw new Error(t("只能操作自己创建的单账号演练订单"));
            if (!demoActions(o).some(([, a]) => a === action))
                throw new Error(t("当前状态不允许此演练步骤"));
            if (prefix === 'demo')
                return { text: (t("确认执行单账号演练步骤：") + demoActions(o).find(([, a]) => a === action)![0] + t("\n订单：") + id + t("\n仅操作系统模拟身份和模拟资金。")), buttons: [[button(t("确认演练步骤"), `democ:${action}:${id}`)], [button(t("返回订单"), `order:${id}`)]] };
            if (action === 'ACCEPT')
                await this.escrow.accept(id, DEMO_PEER, o.terms_version);
            else if (action === 'DEPOSIT')
                await this.escrow.deposit(id, { network: 'SIMULATED_TRON', token: 'SIM_USDT', txHash: `simtx:demo_${id}`, eventIndex: 0, amount: amount(o.expected_deposit), confirmed: true, success: true, to: o.deposit_address });
            else
                await this.escrow.act(id, DEMO_PEER, action as Parameters<Escrow['act']>[2]);
            return { text: t("演练步骤已执行。"), buttons: [[button(t("查看最新订单"), `order:${id}`)]] };
        }
        return undefined;
    }
}
