// Scratch DB adapter process. Fixed public disposable loopback target; no dotenv,
// HTTP, provider client, named statements or ambient database configuration.
import pg from 'pg';
import { performance } from 'node:perf_hooks';
const cfg={host:'127.0.0.1',port:54339,user:'dfs_ev_test',password:'dfs_ev_test',database:'dfs_ev_test',ssl:false,max:10,statement_timeout:5000,connectionTimeoutMillis:5000};
const pool=new pg.Pool(cfg);
process.on('message',async msg=>{
 if(msg.op==='stop'){await pool.end();process.disconnect();return;}
 try{
 const started=performance.now();let row,statements=0;
 const q=async(text,params)=>{statements++;return pool.query(text,params);};
 const args=[JSON.stringify(msg.dims),msg.enforce??true,100,9];
 if(msg.variant==='combined')row=(await q('SELECT * FROM spike223.admit($1::jsonb,$2,$3,$4)',args)).rows[0];
 else if(msg.variant==='separate'){
  row=(await q('SELECT * FROM spike223.admit($1::jsonb,$2,$3,$4,false)',args)).rows[0];
  if(row.outcome==='allow'){
   const r=(await q('SELECT remaining FROM spike223.quota WHERE remaining IS NOT NULL ORDER BY requested_at DESC LIMIT 1')).rows[0];
   if(r&&r.remaining<=109)row.outcome='quota-floor';
  }
 }else if(msg.variant==='floor-only'){
  const r=(await q('SELECT remaining FROM spike223.quota WHERE remaining IS NOT NULL ORDER BY requested_at DESC LIMIT 1')).rows[0];
  row={outcome:r&&r.remaining<=109?'quota-floor':'allow'};
 }else throw new Error('unknown variant');
 process.send({id:msg.id,row,elapsedMs:performance.now()-started,statements,pid:process.pid});
 }catch(error){process.send({id:msg.id,error:{name:error.name,code:error.code,message:error.message}});}
});
await pool.query('SELECT 1');process.send({ready:true,pid:process.pid});
