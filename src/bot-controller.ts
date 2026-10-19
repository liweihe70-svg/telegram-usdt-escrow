import { EvidenceFiles,type EvidenceUpload } from './evidence-files.js';
import { t, withLanguage, localizeButtons, translateError, type Language } from './bot-language.js';
import { randomUUID } from 'node:crypto';
import { Escrow, units } from './escrow.js';
import { amount, button, home, orderView, states as statesForNotification, type View } from './bot-ui.js';
import { helpView } from './bot-help.js';
import { BotAdmin, DEMO_PEER } from './bot-admin.js';
import { BotDisputes } from './bot-disputes.js';
import { BotGroups,validGroup } from './bot-groups.js';
export interface BotConfig {
    username: string;
    brand: string;
    minimumFee: string;
    feeBps: number;
}
export interface BotInput {
    actor: string;
    chatId: string;
    text?: string;
    callback?: string;
    updateId?: number;
    attachment?: EvidenceUpload;
    chatType?: 'private'|'group'|'supergroup';
    groupMember?: boolean;
    groupAdmin?: boolean;
}
interface Draft {
    id: string;
    step: 'TYPE' | 'ROLE' | 'OTHER' | 'AMOUNT' | 'DESCRIPTION' | 'REVIEW';
    demo?: boolean;
    kind?: 'PRODUCT' | 'P2P';
    role?: 'BUYER' | 'SELLER';
    other?: string;
    principal?: string;
    fee?: string;
    description?: string;
}
const validId = (s: string) => /^[1-9]\d{0,15}$/.test(s) && Number.isSafeInteger(Number(s));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const back = [button("返回首页", 'menu:home')];
export class BotController {
    get groups(){return new BotGroups(this.escrow,this.config.username);}
    async groupHelp(actor:string){return this.localized(actor,async()=>this.groups.guide());}
    private groupPrivateGuide():View{return {...this.groups.guide(),buttons:[[button(t('创建担保交易'),'menu:create')],[button(t('返回首页'),'menu:home')]]};}
    private queues = new Map<string, Promise<unknown>>();
    async language(actor:string):Promise<Language>{
        if(!validId(actor))return 'zh';
        const row=(await this.escrow.db.query<{language:Language}>('SELECT language FROM bot_languages WHERE user_id=$1',[actor])).rows[0];
        return row?.language??'zh';
    }
    private async localized(actor:string,work:()=>Promise<View>):Promise<View>{
        const language=await this.language(actor);
        return withLanguage(language,async()=>{
            try{const view=await work();const selected=view.language??language;return {...localizeButtons(view,selected),language:selected};}
            catch(error){
                if(error instanceof Error && !('code' in error) && !('response' in error))throw new Error(translateError(error.message,await this.language(actor)),{cause:error});
                throw error;
            }
        });
    }
    async errorView(actor:string,message:string):Promise<View>{
        const language=await this.language(actor);
        return localizeButtons({text:translateError(message,language),buttons:[back]},language);
    }
    async notification(id:string,actor:string,event=""):Promise<View>{
        return this.localized(actor,async()=>{
            const prefixes:Record<string,string>={TIMEOUT_CLOSED:'未入金订单已到期关闭。\n',TIMEOUT_REVIEW:'订单超时待人工处理，普通操作已暂停，资金保留。\n',TIMEOUT_REMINDER:'订单阶段提醒，请按约定推进交易。\n',TIMEOUT_ADMIN_REMINDER:'管理员提醒：订单仍待人工处理。\n',TIMEOUT_RESUMED:'管理员已恢复普通处理并重新计时。\n'};
            const o=await this.escrow.get(id);
            if(this.escrow.isAdmin(actor)&&![o.buyer_id,o.seller_id].includes(actor))return {text:t(prefixes[event]??'订单有更新，请以当前状态为准。\n\n')+id+'\n'+t(statesForNotification[o.state]??o.state),buttons:[[button(t('超时待处理'),'scheduler:reviews')],...(o.state==='DISPUTED'?[[button(t('待处理争议'),'admin:disputes')]]:[])]};
            const view=await this.orderCard(id,actor);
            if(prefixes[event])return {...view,text:t(prefixes[event])+view.text};
            return {...view,text:t('订单有更新，请以当前状态为准。\n\n')+view.text};
        });
    }
    constructor(public readonly escrow: Escrow, public readonly config: BotConfig) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(config.username))
            throw new Error(t("无效机器人用户名"));
        if (!Number.isSafeInteger(config.feeBps) || config.feeBps < 0 || config.feeBps > 10000)
            throw new Error(t("无效费率"));
        units(config.minimumFee);
    }
    quote(principal: string): string {
        const n = units(principal);
        if (n <= 0n)
            throw new Error(t("本金必须大于零"));
        const fee = (n * BigInt(this.config.feeBps) + 9999n) / 10000n, minimum = units(this.config.minimumFee);
        const result = fee > minimum ? fee : minimum;
        units(amount(n + result));
        return amount(result);
    }
    async handle(input: BotInput): Promise<View> {
        const group=input.chatType==='group'||input.chatType==='supergroup';
        if (!validId(input.actor) || input.actor === DEMO_PEER || (group?!validGroup(input.chatId):input.actor !== input.chatId))
            throw new Error(t("请在与机器人的私聊中操作"));
        const queue=group?'group:'+input.chatId:input.actor;
        const previous = this.queues.get(queue) ?? Promise.resolve();
        const current = previous.catch(() => { }).then(() => this.localized(input.actor,()=>this.process(input)));
        this.queues.set(queue, current);
        try {
            return await current;
        }
        finally {
            if (this.queues.get(queue) === current)
                this.queues.delete(queue);
        }
    }
    private async process(input: BotInput): Promise<View> {
        if (input.updateId === undefined)
            return this.dispatch(input);
        if (!Number.isSafeInteger(input.updateId) || input.updateId < 0)
            throw new Error(t("无效 Telegram 更新编号"));
        const db = this.escrow.db;
        const claimed = await db.query(`INSERT INTO bot_processed_updates(bot_username,update_id,actor,chat_id)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING update_id`, [this.config.username, input.updateId, input.actor,input.chatId]);
        if (!claimed.rows.length) {
            const prior = (await db.query<{
                actor: string;
                response: View | null;
                chat_id:string|null;
            }>('SELECT actor::text,response,chat_id::text FROM bot_processed_updates WHERE bot_username=$1 AND update_id=$2', [this.config.username, input.updateId])).rows[0];
            if (prior.actor !== input.actor)
                throw new Error(t("更新编号对应的身份不一致"));
            if(prior.chat_id!==null&&prior.chat_id!==input.chatId)throw new Error(t('更新编号对应的聊天不一致'));
            if(input.chatType==='group'||input.chatType==='supergroup'){if(prior.chat_id===null)throw new Error(t('更新编号对应的聊天不一致'));return this.dispatch({...input,text:'/group',callback:undefined});}
            if (prior.response)
                return prior.response;
            // An interrupted request may or may not have committed. Never repeat its mutation blindly.
            return { text: t("上次请求处理状态需要核对，请通过 /orders 刷新订单，或 /start 重新开始填写。"), buttons: [back] };
        }
        const result = await this.dispatch(input);
        await db.query('UPDATE bot_processed_updates SET response=$3 WHERE bot_username=$1 AND update_id=$2', [this.config.username, input.updateId, JSON.stringify(result)]);
        return result;
    }
    private async save(actor: string, draft: Draft) {
        await this.escrow.db.query(`INSERT INTO bot_sessions(user_id,draft,expires_at) VALUES($1,$2,now()+interval '1 hour')
      ON CONFLICT(user_id) DO UPDATE SET draft=excluded.draft,expires_at=excluded.expires_at`, [actor, JSON.stringify(draft)]);
    }
    private async draft(actor: string): Promise<Draft | undefined> {
        const r = await this.escrow.db.query<{
            draft: Draft;
        }>('SELECT draft FROM bot_sessions WHERE user_id=$1 AND expires_at>now()', [actor]);
        return r.rows[0]?.draft;
    }
    private async clear(actor: string) { await this.escrow.db.query('DELETE FROM bot_sessions WHERE user_id=$1', [actor]); }
    async view(id: string, actor: string): Promise<View> {
        return this.localized(actor,()=>this.orderCard(id,actor));
    }
    private async orderCard(id: string, actor: string): Promise<View> {
        if (!uuid.test(id))
            throw new Error(t("无效订单编号"));
        const o = await this.escrow.get(id), view = orderView(o, actor, this.config.username);
        let peerAccepted = false;
        if (o.state === 'AWAITING_ACCEPTANCE') {
            const accepted = (await this.escrow.db.query<{
                user_id: string;
            }>('SELECT user_id::text FROM order_acceptances WHERE order_id=$1 AND terms_version=$2', [id, o.terms_version])).rows.map(r => r.user_id);
            peerAccepted = accepted.includes(DEMO_PEER);
            view.text += (t("\n\n条款确认：买家") + (accepted.includes(o.buyer_id) ? t("已确认") : t("未确认")) + t(" · 卖家") + (accepted.includes(o.seller_id) ? t("已确认") : t("未确认")) + "");
            if (accepted.includes(actor))
                view.buttons = view.buttons?.map(row => row.filter(b => !b.callback_data?.startsWith('accept:'))).filter(row => row.length);
        }
        const binding=(await this.escrow.db.query<{chat_id:string;state:string}>('SELECT chat_id::text,state FROM bot_group_bindings WHERE order_id=$1',[id])).rows[0];
        if(binding)view.text+=t('\n\n担保群：')+binding.chat_id+' · '+binding.state;
        else if(o.state==='AWAITING_ACCEPTANCE'&&![o.buyer_id,o.seller_id].includes(DEMO_PEER))view.buttons?.push([{text:t('添加到担保群并申请绑定'),url:`https://t.me/${this.config.username}?startgroup=bind_${o.id}`}]);
        return new BotAdmin(this.escrow).decorate(o, actor, view, peerAccepted);
    }
    private async homepage(actor?: string): Promise<View> {
        const stats = await this.escrow.db.query<{
            completed: number;
            disputes: number;
        }>(`SELECT
      count(*) FILTER(WHERE state IN ('COMPLETED','ARBITRATED'))::int AS completed,
      count(*) FILTER(WHERE state='ARBITRATED')::int AS disputes FROM orders`);
        const view = home(this.config.brand, stats.rows[0].completed, stats.rows[0].disputes);
        if (actor && this.escrow.isAdmin(actor))
            view.buttons?.push([button(t("单账号演练"), 'menu:demo'), button(t("模拟内测管理"), 'menu:admin')]);
        return view;
    }
    private async list(actor: string): Promise<View> {
        const r = await this.escrow.db.query<{
            id: string;
        }>('SELECT id FROM orders WHERE buyer_id=$1 OR seller_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20', [actor]);
        return { text: r.rows.length ? t("我的交易（最近20笔）") : t("你还没有担保订单。"), buttons: [...r.rows.map(o => [button((t("订单 ") + o.id.slice(0, 8) + ""), `order:${o.id}`)]), back] };
    }
    private prompt(d: Draft): View {
        const cancel = [button(t("取消创建"), 'menu:home')];
        switch (d.step) {
            case 'TYPE': return { text: d.demo ? t("单账号演练：对方由系统模拟，不需要第二个账号。请选择交易类型。") : t("请选择交易类型 · 模拟内测"), buttons: [[button(t("商品／服务担保"), `type:PRODUCT:${d.id}`)], [button(t("USDT 买卖担保"), `type:P2P:${d.id}`)], cancel] };
            case 'ROLE': return { text: t("你是这笔交易的哪一方？"), buttons: [[button(t("我是买家"), `role:BUYER:${d.id}`), button(t("我是卖家"), `role:SELLER:${d.id}`)], cancel] };
            case 'OTHER': return { text: t("请输入交易对方的 Telegram 数字 ID。\n让对方先打开机器人发送 /id，把数字 ID 告诉你。\n不要输入用户名。"), buttons: [cancel] };
            case 'AMOUNT': return { text: t("请输入交易本金，例如 100 或 25.5。\n单位：模拟 USDT，最多六位小数。"), buttons: [cancel] };
            case 'DESCRIPTION': return { text: t("请输入商品／服务或买卖约定，写明交付内容、期限及验收条件（最多1000字）。"), buttons: [cancel] };
            case 'REVIEW': return { text: (t("创建前核对 · 模拟内测\n类型：") + (d.kind === 'PRODUCT' ? t("商品／服务") : t("USDT 买卖")) + t("\n你的角色：") + (d.role === 'BUYER' ? t("买家") : t("卖家")) + t("\n对方：") + (d.demo ? t("系统模拟身份（单账号演练）") : d.other) + t("\n本金：") + d.principal + t(" USDT\n担保费：") + d.fee + t(" USDT\n应付总额：") + amount(units(d.principal!) + units(d.fee!)) + t(" USDT\n费用由 USDT 入金方承担。\n\n约定：") + d.description + t("\n\n双方仅使用模拟地址，订单仍需要分别确认条款。")), buttons: [[button(t("创建订单"), `create:${d.id}`)], cancel] };
        }
    }
    private async dispatch(i: BotInput,registerContact=true): Promise<View> {
        if(i.attachment){if(i.chatType&&i.chatType!=='private')throw Error(t('请在私聊中提交争议附件'));const id=await new EvidenceFiles(this.escrow).submit(i.actor,i.text??'',i.attachment);return {text:t('争议附件已保存。'),buttons:[[button(t('查看证据说明'),`evidence:${id}`)]]};}
        if(registerContact&&(i.chatType==='group'||i.chatType==='supergroup'))return this.groups.handle(i,await this.language(i.actor),input=>this.dispatch(input,false));
        if(registerContact)await this.escrow.db.query(`INSERT INTO bot_contacts(user_id,chat_id) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id,updated_at=now()`, [i.actor, i.chatId]);
        const text = i.text?.trim();
        const helpCommands: Record<string, string> = { '/instructions': 'instructions', '/help': 'instructions', '/rules': 'rules', '/whatisescrow': 'about', '/video': 'tutorial' };
        const queryCallback = i.callback?.match(/^(terms|balance|blockchain):([a-f0-9-]+)$/);
        const command = queryCallback ? '/' + queryCallback[1] : text?.split(/\s+/)[0].replace(/@[a-zA-Z0-9_]+$/, '');
        if(command==='/language' || i.callback==='menu:language' || i.callback?.startsWith('lang:')){
            const args=command==='/language'?text!.split(/\s+/).slice(1):[];
            const selected=i.callback?.startsWith('lang:')?i.callback.slice(5):args[0];
            if(args.length>1 || (selected!==undefined && selected!=='zh' && selected!=='en'))throw new Error('Choose zh or en: /language en');
            if(selected){
                await this.escrow.db.query(`INSERT INTO bot_languages(user_id,language) VALUES($1,$2)
                  ON CONFLICT(user_id) DO UPDATE SET language=excluded.language,updated_at=now()`,[i.actor,selected]);
                return withLanguage(selected,async()=>{
                    const active=await this.draft(i.actor);
                    const view=active?this.prompt(active):await this.homepage(i.actor);
                    return {...view,language:selected,text:(selected==='en'?'Language set to English.':'已切换为中文。')+'\n\n'+view.text};
                });
            }
            const language=await this.language(i.actor);
            return {text:'请选择语言 / Choose your language',buttons:[
                [button((language==='zh'?'✓ ':'')+'中文','lang:zh'),button((language==='en'?'✓ ':'')+'English','lang:en')],
                [button(language==='en'?'Back':'返回',await this.draft(i.actor)?'language:resume':'menu:home')]
            ]};
        }
        if(i.callback==='language:resume'){
            const active=await this.draft(i.actor);return active?this.prompt(active):this.homepage(i.actor);
        }
        if(i.callback?.startsWith('file:')){const id=i.callback.slice(5);await new EvidenceFiles(this.escrow).read(id,i.actor);return {text:t('争议附件'),attachmentId:id};}
        if(command==='/file_evidence')return {text:t('请在附件说明填写：/file_evidence 完整订单编号 证据说明（最多1000字）')};
        const adminView = await new BotAdmin(this.escrow).handle(i.actor, command, text, i.callback);
        if (adminView)
            return adminView;
        const disputeView = await new BotDisputes(this.escrow).handle(i.actor, command, text, i.callback);
        if (disputeView)
            return disputeView;
        if (command === '/menu')
            return this.homepage(i.actor);
        if (command === '/demo' || i.callback === 'menu:demo') {
            if (!this.escrow.isAdmin(i.actor))
                throw new Error(t("单账号演练仅限已配置的测试管理员"));
            const d: Draft = { id: randomUUID(), step: 'TYPE', demo: true, other: DEMO_PEER };
            await this.save(i.actor, d);
            return this.prompt(d);
        }
        if (command && helpCommands[command])
            return helpView(helpCommands[command]);
        if (i.callback?.startsWith('help:'))
            return helpView(i.callback.slice(5));
        if (i.callback === 'menu:help')
            return helpView('instructions');
        if (i.callback === 'menu:about')
            return helpView('about');
        if (i.callback === 'menu:rules')
            return helpView('rules');
        if (command === '/buyer' || command === '/seller') {
            const role = command === '/buyer' ? t("买家") : t("卖家");
            return { text: ("" + role + t("角色说明 · 模拟内测\n创建订单时选择“我是") + role + t("”，并填写交易对方的数字 ID。订单创建后双方身份固定，不通过发送地址来更换角色。\n模拟钱包由数字 ID 生成，不接收真实钱包地址。")), buttons: [[button(("" + role + t("安全指南")), command === '/buyer' ? 'help:buyer' : 'help:seller')], [button(t("创建担保交易"), 'menu:create')], back] };
        }
        if (command && ['/terms', '/description', '/balance', '/qr', '/blockchain'].includes(command)) {
            const args = queryCallback ? [queryCallback[2]] : text!.split(/\s+/).slice(1);
            if (args.length === 0)
                return { text: command === '/qr' ? t("模拟版本尚未启用收款二维码，sim: 标识不能用于转账。") : (t("请提供完整订单编号：") + command + t(" 订单编号\n从“我的交易”找到订单。") + (command === '/balance' ? t("只查询这笔订单的模拟托管余额，不是钱包链上余额。") : t("条款及描述在创建订单时填写，双方确认后锁定。")) + ""), buttons: [[button(t("我的交易"), 'menu:orders')], back] };
            if (args.length !== 1 || !uuid.test(args[0]))
                throw new Error(t("请提供一个完整订单编号"));
            const id = args[0];
            await this.view(id, i.actor);
            const o = await this.escrow.get(id), returnOrder = [button(t("返回订单"), `order:${id}`)];
            if (command === '/blockchain') {
                const deposits = (await this.escrow.db.query<{
                    amount: string;
                    tx_hash: string;
                    classification: string;
                }>('SELECT amount::text,tx_hash,classification FROM deposits WHERE order_id=$1 ORDER BY created_at DESC LIMIT 5', [id])).rows;
                const payouts = (await this.escrow.payouts(id)).slice(0, 5);
                const records = [...deposits.map(p => (t("入金 ") + amount(p.amount) + " USDT · " + (p.classification === 'CREDITED' ? t("已记账") : t("异常款")) + "\n" + p.tx_hash.slice(0, 120) + "")), ...payouts.map(p => (t("出款 ") + amount(p.amount) + " USDT · " + p.status + "\n" + (p.tx_hash?.slice(0, 120) ?? t("尚未模拟广播")) + ""))];
                return { text: (t("订单出入金记录 · 模拟内测\n编号：") + id + "\n\n" + (records.length ? records.join('\n\n') : t("还没有出入金记录。")) + t("\n\n最多显示最近5条入金及5条出款。simtx: 哈希不是真实链上交易，不能在区块浏览器查询。")), buttons: [returnOrder] };
            }
            if (command === '/qr')
                return { text: t("此订单只使用模拟资金，尚未启用真实收款二维码。请通过订单内模拟入金说明测试。"), buttons: [returnOrder] };
            if (command === '/balance') {
                const r = await this.escrow.db.query<{
                    balance: string;
                    exceptions: string;
                }>(`SELECT
          coalesce(sum(amount) FILTER(WHERE account=$1),0)::text AS balance,
          coalesce(sum(amount) FILTER(WHERE account=$2),0)::text AS exceptions FROM ledger_entries WHERE account IN ($1,$2)`, [`escrow:${id}`, `exception:${id}`]);
                return { text: (t("订单模拟资金\n编号：") + id + t("\n待结算托管余额：") + amount(-BigInt(r.rows[0].balance)) + t(" USDT\n待处理异常款：") + amount(-BigInt(r.rows[0].exceptions)) + t(" USDT\n约定入金总额：") + amount(o.expected_deposit) + t(" USDT\n这些是本地账本余额，不是链上钱包查询。")), buttons: [returnOrder] };
            }
            return { text: ("" + (command === '/terms' ? t("交易条款") : t("商品／买卖约定")) + t("\n订单：") + id + t("\n版本：") + o.terms_version + "\n\n" + o.description + t("\n\n双方应确认同一版本，当前版本不支持创建后修改。")), buttons: [returnOrder] };
        }
        if (command === '/simulate_deposit') {
            if (!this.escrow.isAdmin(i.actor))
                throw new Error(t("此测试命令仅限已配置的管理员"));
            const id = text!.split(/\s+/).slice(1).join(' ');
            if (!uuid.test(id))
                throw new Error(t("无效订单编号"));
            const o = await this.escrow.get(id);
            if (o.state !== 'AWAITING_DEPOSIT')
                throw new Error(t("请先完成双方条款确认，并确保订单处于待入金状态"));
            await this.escrow.deposit(id, { network: 'SIMULATED_TRON', token: 'SIM_USDT', txHash: `simtx:admin_${id}`, eventIndex: 0, amount: amount(o.expected_deposit), confirmed: true, success: true, to: o.deposit_address });
            return { text: (t("已注入模拟入金事件。\n订单：") + id + t("\n不涉及真实转账。")), buttons: [back] };
        }
        if (text?.startsWith('/start')) {
            if(/^\/start(?:@[a-zA-Z0-9_]+)?\s+group_help$/.test(text))return this.groupPrivateGuide();
            const match = text.match(/^\/start(?:@[a-zA-Z0-9_]+)?(?:\s+order_([a-f0-9-]+))?$/);
            if (!match)
                throw new Error(t("无效邀请链接"));
            await this.clear(i.actor);
            return match[1] ? this.view(match[1], i.actor) : this.homepage(i.actor);
        }
        if (command === '/cancel' || i.callback === 'menu:home') {
            await this.clear(i.actor);
            return this.homepage(i.actor);
        }
        if (command === '/id' || i.callback === 'menu:id')
            return { text: (t("你的 Telegram ID：") + i.actor + ""), buttons: [back] };
        if (command === '/orders' || i.callback === 'menu:orders')
            return this.list(i.actor);
        if(command==='/group')return this.groupPrivateGuide();
        if (i.callback === 'menu:fees')
            return { text: (t("内测收费配置\n担保费为本金的 ") + this.config.feeBps / 100 + t("% 与 ") + this.config.minimumFee + t(" USDT 中较高者，向上舍入至六位小数。\n由 USDT 入金方额外支付。双方退款退还本金及费用；当前仲裁不收费。\n创建订单时保存费率结果，不影响已创建订单。\n当前仅模拟资金，真实收费方案尚未启用。")), buttons: [back] };
        if (i.callback === 'menu:create' || command === '/create') {
            const d: Draft = { id: randomUUID(), step: 'TYPE' };
            await this.save(i.actor, d);
            return this.prompt(d);
        }
        if (i.callback) {
            const parts = i.callback.split(':'), cmd = parts[0];
            if (cmd === 'order')
                return this.view(parts[1], i.actor);
            if (cmd === 'deposit') {
                const o = await this.escrow.get(parts[1]);
                orderView(o, i.actor, this.config.username);
                if (o.state !== 'AWAITING_DEPOSIT')
                    throw new Error(t("订单当前不等待入金"));
                return { text: (t("模拟入金说明\n订单：") + o.id + t("\n测试收款标识：") + o.deposit_address + t("\n应付：") + amount(o.expected_deposit) + t(" 模拟 USDT\n\n此标识不是链上地址，不能转账。由开发测试工具注入已确认事件；机器人不会凭用户截图记账。")), buttons: [[button(t("返回订单"), `order:${o.id}`)]] };
            }
            if (cmd === 'accept') {
                const id = parts[2];
                await this.view(id, i.actor);
                await this.escrow.accept(id, i.actor, Number(parts[1]));
                const v = await this.view(id, i.actor);
                return { ...v, text: t("你的条款确认已记录。\n\n") + v.text };
            }
            if (cmd === 'act' || cmd === 'execute') {
                const action = parts[1] as Parameters<Escrow['act']>[2], id = parts[2];
                const card = await this.view(id, i.actor), actions = new Set(['DECLARE', 'RELEASE', 'REQUEST_REFUND', 'AGREE_REFUND', 'REJECT_REFUND', 'DISPUTE', 'CLOSE']);
                if (!actions.has(action))
                    throw new Error(t("不支持的操作"));
                if (cmd === 'act' && action === 'DISPUTE')
                    return { text: (t("请填写争议理由后提交申请：\n/dispute ") + id + t(" 争议理由\n提交后仍需二次确认。争议中可提交文字、图片或文件证据。")), buttons: [[button(t("返回订单"), `order:${id}`)]] };
                if (cmd === 'execute' && action === 'DISPUTE')
                    throw new Error(t("请用 /dispute 订单编号 争议理由，核对后二次确认"));
                if (cmd === 'act' && ['RELEASE', 'AGREE_REFUND', 'DISPUTE', 'CLOSE'].includes(action))
                    return {
                        text: (t("请再次确认：") + (action === 'RELEASE' ? t("验收／收款完成并提交放款") : action === 'AGREE_REFUND' ? t("同意向入金方退款") : action === 'DISPUTE' ? t("发起争议并暂停结算") : t("关闭未入金订单")) + "\n\n" + card.text + ""),
                        buttons: [[button(t("确认操作"), `execute:${action}:${id}`)], [button(t("返回订单"), `order:${id}`)]]
                    };
                await this.escrow.act(id, i.actor, action);
                return this.view(id, i.actor);
            }
            const d = await this.draft(i.actor);
            if (cmd === 'create') {
                const id = parts[1];
                if (!uuid.test(id))
                    throw new Error(t("无效创建请求"));
                if (!d || d.id !== id)
                    return this.view(id, i.actor);
                if (d.step !== 'REVIEW')
                    throw new Error(t("请先填写完整订单"));
                if (d.demo && !this.escrow.isAdmin(i.actor))
                    throw new Error(t("单账号演练权限已撤销"));
                const buyer = d.role === 'BUYER' ? i.actor : d.other!, seller = d.role === 'SELLER' ? i.actor : d.other!;
                const o = await this.escrow.create({ requestId: d.id, kind: d.kind!, buyerId: buyer, sellerId: seller, principal: d.principal!, fee: d.fee!, description: d.description!, buyerAddress: d.demo && buyer === DEMO_PEER ? `sim:demo_${i.actor}` : `sim:tg_${buyer}`, sellerAddress: d.demo && seller === DEMO_PEER ? `sim:demo_${i.actor}` : `sim:tg_${seller}` });
                await this.clear(i.actor);
                return this.view(o.id, i.actor);
            }
            if (!d || parts[2] !== d.id)
                throw new Error(t("创建步骤已过期，请重新点击创建交易"));
            if (cmd === 'type' && d.step === 'TYPE' && ['PRODUCT', 'P2P'].includes(parts[1])) {
                d.kind = parts[1] as Draft['kind'];
                d.step = 'ROLE';
            }
            else if (cmd === 'role' && d.step === 'ROLE' && ['BUYER', 'SELLER'].includes(parts[1])) {
                d.role = parts[1] as Draft['role'];
                d.step = d.demo ? 'AMOUNT' : 'OTHER';
            }
            else
                throw new Error(t("无效或过期按钮"));
            await this.save(i.actor, d);
            return this.prompt(d);
        }
        const d = await this.draft(i.actor);
        if (!d || !text)
            return { text: t("发送 /start 打开首页，或 /create 创建交易。"), buttons: [back] };
        if (d.step === 'OTHER') {
            if (!validId(text) || text === i.actor || text === DEMO_PEER)
                throw new Error(t("请输入与自己不同的有效数字 ID"));
            d.other = text;
            d.step = 'AMOUNT';
        }
        else if (d.step === 'AMOUNT') {
            d.fee = this.quote(text);
            d.principal = amount(units(text));
            d.step = 'DESCRIPTION';
        }
        else if (d.step === 'DESCRIPTION') {
            if (text.length > 1000 || text.startsWith('/'))
                throw new Error(t("约定须为1至1000字的普通文本"));
            d.description = text;
            d.step = 'REVIEW';
        }
        else
            return this.prompt(d);
        await this.save(i.actor, d);
        return this.prompt(d);
    }
}
