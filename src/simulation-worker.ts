import { Escrow } from './escrow.js';

// Exclusively a mock settlement worker: no RPC client, private key or actual broadcast.
export class SimulationWorker {
  private running=false;
  constructor(private escrow:Escrow){}
  async tick():Promise<void>{
    if(this.running)return;this.running=true;
    try{
      const orders=(await this.escrow.db.query<{id:string}>("SELECT id FROM orders WHERE state='SETTLING' ORDER BY created_at LIMIT 20")).rows;
      for(const o of orders){
        const payouts=await this.escrow.broadcast(o.id);
        for(const p of payouts)if(p.status!=='CONFIRMED')await this.escrow.confirmPayout(o.id,p.id,p.tx_hash!);
      }
    }finally{this.running=false;}
  }
}
