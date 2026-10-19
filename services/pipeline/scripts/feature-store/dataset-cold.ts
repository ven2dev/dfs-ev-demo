import { Client,type ClientConfig } from "pg";
import { buildDataset,type DatasetSpec } from "../../src/featureStore/datasets.ts";
import type { CodeIdentity } from "../../src/featureStore/derived.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { assertNoApplicationCredentials } from "../../../../packages/db/tests/target.mts";
assertNoApplicationCredentials(process.env);
const chunks:Buffer[]=[];
for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
const {config,spec,code,storageRoot}=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
 config:ClientConfig;spec:DatasetSpec;code:CodeIdentity;storageRoot:string;
};
if(!['127.0.0.1','::1'].includes(String(config.host))||config.port!==54329||
 !/^dfs_ev_test_[a-f0-9]+$/.test(String(config.database))||!/^fs138_job_[a-f0-9]+$/.test(String(config.user))||
 config.password!=='fs138_throwaway'||config.ssl!==false)throw new Error('dataset-cold-target-refused');
const client=new Client(config);let statements=0;let rightsQueries=0;
const measured=new Proxy(client,{get(target,property){
 if(property!=='query')return Reflect.get(target,property,target);
 return(...args:unknown[])=>{statements++;const q=args[0];const text=typeof q==='string'?q:(q as {text:string}).text;
  if(text.includes('decisions AS MATERIALIZED'))rightsQueries++;
  return Reflect.apply(target.query,target,args);
 };
}});
try{await client.connect();const store=await openLocalObjectStore(storageRoot);
 const result=await buildDataset(measured,store,spec,code);
 console.log(JSON.stringify({result,statements,rightsQueries,processId:process.pid,peakRssBytes:process.resourceUsage().maxRSS*1024}));
}finally{await client.end();}
