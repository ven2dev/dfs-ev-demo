import { Client,type ClientConfig } from "pg";
import { runDerivedJob,type DerivedRequest,type CodeIdentity } from "../../src/featureStore/derived.ts";
import { assertNoApplicationCredentials } from "../../../../packages/db/tests/target.mts";

// Test-only worker: stdin avoids placing even throwaway credentials in argv.
assertNoApplicationCredentials(process.env);
const chunks:Buffer[]=[];
for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
const {config,request,code}=JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
 config:ClientConfig;request:DerivedRequest;code:CodeIdentity;
};
if(!["127.0.0.1","::1"].includes(String(config.host))||config.port!==54329||
 !/^dfs_ev_test_[a-f0-9]+$/.test(String(config.database))||!/^fs138_job_[a-f0-9]+$/.test(String(config.user))||
 config.password!=="fs138_throwaway"||config.ssl!==false)throw new Error("cold-worker-target-refused");
const client=new Client(config);
let queries=0;
const measured=new Proxy(client,{get(target,property){
 if(property!=="query")return Reflect.get(target,property,target);
 return (...args:unknown[])=>{queries++;return Reflect.apply(target.query,target,args);};
}});
try{
 await client.connect();
 const result=await runDerivedJob(measured,"features",request,code);
 console.log(JSON.stringify({result,queries,processId:process.pid}));
}finally{await client.end();}
