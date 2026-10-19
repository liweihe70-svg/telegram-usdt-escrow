import {Pool, type PoolConfig} from 'pg';

export interface QueryResult<Row>{rows:Row[]}
export interface QueryClient {
  query<Row=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<QueryResult<Row>>;
}
export interface TransactionClient extends QueryClient{exec(sql:string):Promise<void>}
export interface TransactionConnection extends QueryClient{release(destroy?:boolean):void}
export interface ConnectionPool extends QueryClient {
  connect():Promise<TransactionConnection>;
  end():Promise<void>;
}
// Transactions always use one checked-out client. A failed rollback discards it.
export class PostgresDatabase implements QueryClient {
  private closed=false;
  constructor(private readonly pool:ConnectionPool){}
  static open(config:PoolConfig){
    const pool=new Pool({max:10,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,...config});
    let backgroundError=false;
    pool.on('error',()=>{backgroundError=true;});
    const database=new PostgresDatabase(pool as unknown as ConnectionPool);
    return {database,hasBackgroundError:()=>backgroundError};
  }
  async query<Row=Record<string,unknown>>(sql:string,values?:unknown[]){
    if(this.closed)throw Error('Database closed');
    return this.pool.query<Row>(sql,values);
  }
  async transaction<T>(work:(client:TransactionClient)=>Promise<T>):Promise<T>{
    if(this.closed)throw Error('Database closed');
    const client=await this.pool.connect();
    let destroy=false;
    const tx:TransactionClient={query:(sql,values)=>client.query(sql,values),exec:async sql=>{await client.query(sql);}};
    try{
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='30s'");
      await client.query("SET LOCAL lock_timeout='5s'");
      const result=await work(tx);
      await client.query('COMMIT');
      return result;
    }catch(error){
      try{await client.query('ROLLBACK');}catch{destroy=true;}
      throw error;
    }finally{client.release(destroy);}
  }
  async close(){if(!this.closed){this.closed=true;await this.pool.end();}}
}
