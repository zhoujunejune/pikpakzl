import pg from 'pg';

/** Append-only PostgreSQL journal. Committed rows, not container disk, are authoritative. */
export class PgEventStore {
  constructor({connectionString=process.env.DATABASE_URL||process.env.POSTGRES_URI}={}) {
    if (!connectionString) throw new Error('POSTGRES_CONNECTION_REQUIRED');
    this.client=new pg.Client({connectionString, connectionTimeoutMillis:3500,
      query_timeout:3000, statement_timeout:3000,
      application_name:'zl-fast8-adaptive-shadow-v1'});
    this.failed=null;
    this.client.on('error',error=>{this.failed=String(error?.message||error)});
  }
  async open(){
    await this.client.connect();
    await this.client.query(`CREATE TABLE IF NOT EXISTS zl_fast8_adaptive_events (
      id BIGSERIAL PRIMARY KEY,
      policy TEXT NOT NULL,
      event JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.client.query('CREATE INDEX IF NOT EXISTS zl_fast8_adaptive_policy_idx ON zl_fast8_adaptive_events(policy,id)');
  }
  async replay(policy) {
    const {rows}=await this.client.query('SELECT event FROM zl_fast8_adaptive_events WHERE policy=$1 ORDER BY id ASC',[policy]);
    return rows.map(r=>r.event);
  }
  async append(event) {
    await this.client.query('INSERT INTO zl_fast8_adaptive_events(policy,event) VALUES ($1,$2::jsonb)',
      [event.policy,JSON.stringify(event)]);
    return event;
  }
  async close(){await this.client.end()}
}
