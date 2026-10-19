import { EvidenceFiles } from './evidence-files.js';
import { t } from './bot-language.js';
import { randomUUID } from 'node:crypto';
import { Escrow } from './escrow.js';
import { button, type View } from './bot-ui.js';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class BotDisputes {
    constructor(private escrow: Escrow) { }
    private async participant(id: string, actor: string) {
        if (!uuid.test(id))
            throw new Error(t("请提供完整订单编号"));
        const o = await this.escrow.get(id);
        if (actor !== o.buyer_id && actor !== o.seller_id)
            throw new Error(t("无权查看此订单"));
        return o;
    }
    async handle(actor: string, command: string | undefined, text: string | undefined, callback: string | undefined): Promise<View | undefined> {
        if (command === '/dispute' || command === '/evidence') {
            const [, id, ...words] = text!.trim().split(/\s+/), note = words.join(' ');
            if (!id || !note.trim() || note.length > 1000)
                throw new Error((t("格式：") + command + t(" 完整订单编号 ") + (command === '/dispute' ? t("争议理由") : t("证据说明")) + t("（1至1000字）")));
            const o = await this.participant(id, actor);
            if (command === '/evidence') {
                if (o.state !== 'DISPUTED')
                    throw new Error(t("仅争议中的订单可追加证据说明"));
                await this.escrow.db.transaction(async (tx) => {
                    await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [id]);
                    const current = (await tx.query<{
                        state: string;
                    }>('SELECT state FROM orders WHERE id=$1', [id])).rows[0];
                    if (current.state !== 'DISPUTED')
                        throw new Error(t("订单已不在争议中"));
                    const n = (await tx.query<{
                        n: number;
                    }>('SELECT count(*)::int AS n FROM bot_evidence_notes WHERE order_id=$1 AND user_id=$2', [id, actor])).rows[0].n;
                    if (n >= 10)
                        throw new Error(t("每位参与方每笔订单最多10条证据说明"));
                    await tx.query('INSERT INTO bot_evidence_notes(id,user_id,order_id,note) VALUES($1,$2,$3,$4)', [randomUUID(), actor, id, note]);
                });
                return { text: t("证据说明已保存，可由双方及测试管理员查询。请勿提交密码、私钥或无关个人信息。"), buttons: [[button(t("查看证据说明"), `evidence:${id}`)], [button(t("返回订单"), `order:${id}`)]] };
            }
            if (!['FUNDED', 'AWAITING_CONFIRMATION', 'REFUND_REQUESTED'].includes(o.state))
                throw new Error(t("当前状态不能发起争议"));
            const request = randomUUID();
            await this.escrow.db.transaction(async (tx) => {
                await tx.query('DELETE FROM bot_dispute_requests WHERE user_id=$1 AND order_id=$2', [actor, id]);
                await tx.query('INSERT INTO bot_dispute_requests(id,user_id,order_id,reason) VALUES($1,$2,$3,$4)', [request, actor, id, note]);
            });
            return { text: (t("请确认发起模拟争议\n订单：") + id + t("\n理由：") + note + t("\n确认后暂停普通放款和退款。申请10分钟内有效。")), buttons: [[button(t("确认发起争议"), `dispute:${request}`)], [button(t("取消申请"), `dispute_cancel:${request}`)]] };
        }
        if (callback?.startsWith('dispute:') || callback?.startsWith('dispute_cancel:')) {
            const request = callback.split(':')[1];
            if (!uuid.test(request))
                throw new Error(t("无效争议申请"));
            const r = (await this.escrow.db.query<{
                order_id: string;
                reason: string;
            }>('SELECT order_id,reason FROM bot_dispute_requests WHERE id=$1 AND user_id=$2 AND expires_at>now()', [request, actor])).rows[0];
            if (!r)
                throw new Error(t("争议申请已失效或无权操作"));
            await this.participant(r.order_id, actor);
            if (callback.startsWith('dispute_cancel:')) {
                await this.escrow.db.query('DELETE FROM bot_dispute_requests WHERE id=$1', [request]);
                return { text: t("已取消争议申请，订单状态未变动。"), buttons: [[button(t("返回订单"), `order:${r.order_id}`)]] };
            }
            await this.escrow.act(r.order_id, actor, 'DISPUTE', r.reason);
            await this.escrow.db.query('DELETE FROM bot_dispute_requests WHERE id=$1', [request]);
            return { text: (t("模拟争议已发起，普通结算暂停。\n可追加证据说明：\n/evidence ") + r.order_id + t(" 证据说明\n提交图片或文件：发送附件，在附件说明填写 /file_evidence 完整订单编号 证据说明。")), buttons: [[button(t("返回订单"), `order:${r.order_id}`)]] };
        }
        if (command === '/evidences' || callback?.startsWith('evidence:')) {
            const id = callback ? callback.split(':')[1] : text!.trim().split(/\s+/)[1];
            if (!id || !uuid.test(id))
                throw new Error(t("格式：/evidences 完整订单编号"));
            const o = await this.escrow.get(id);
            if (!this.escrow.isAdmin(actor) && actor !== o.buyer_id && actor !== o.seller_id)
                throw new Error(t("无权查看此订单"));
            const notes = (await this.escrow.db.query<{
                note: string;
                user_id: string;
                created_at: string;
            }>('SELECT note,user_id::text,created_at::text FROM bot_evidence_notes WHERE order_id=$1 ORDER BY created_at,id', [id])).rows;
            const files=await new EvidenceFiles(this.escrow).list(id);
            const dispute = (await this.escrow.db.query<{
                reason: string;
                decision: string | null;
            }>('SELECT reason,decision FROM disputes WHERE order_id=$1', [id])).rows[0];
            const entries=[...notes.map(n=>({...n,file:false,id:"",filename:"",size:0})),...files.map(f=>({...f,file:true,note:f.note}))].sort((a,b)=>a.created_at.localeCompare(b.created_at));
            const part = Number(callback?.split(':')[2] ?? 0);
            if (!Number.isSafeInteger(part) || part < 0 || part >= Math.max(1, Math.ceil(entries.length / 2)))
                throw new Error(t("无效证据页码"));
            const page=entries.slice(part*2,part*2+2);
            const body=page.map((n,index)=>String(part*2+index+1)+t(". 用户 ")+n.user_id+"\n"+(n.file?t('争议附件')+": "+n.filename+" · "+n.size+" B\n":"")+n.note).join('\n\n');
            const nav = [];
            if (part > 0)
                nav.push(button(t("上一页"), `evidence:${id}:${part - 1}`));
            if ((part + 1) * 2 < entries.length)
                nav.push(button(t("下一页"), `evidence:${id}:${part + 1}`));
            return { text: (t("模拟争议记录 · 第") + (part + 1) + t("页\n订单：") + id + t("\n发起理由：") + (dispute?.reason ?? t("尚未发起")) + "\n\n" + (body || t("尚未追加证据说明。")) + ""), buttons: [...page.filter(f=>f.file).map(f=>[button(t('下载附件')+' · '+f.filename,`file:${f.id}`)]),...(nav.length ? [nav] : []), [button(this.escrow.isAdmin(actor) ? t("管理菜单") : t("返回订单"), this.escrow.isAdmin(actor) ? 'menu:admin' : `order:${id}`)]] };
        }
        return undefined;
    }
}
