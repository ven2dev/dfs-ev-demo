import {Pool} from "pg";
import {candidateCleanupStatements,candidateRole,candidateSchema,candidateSetupStatements,type CandidateContext,type CandidateStatement} from "@/lib/bench61-candidate";

// Fixed disposable local fixture only. No environment URL is read, so these tests
// cannot reach a hosted database by accident.
export const local=process.env.BENCH61_LOCAL_TEST==="1";
export const target={host:"127.0.0.1",port:54361,database:"bench61",user:"bench61",password:"disposable-local-only",connectionTimeoutMillis:3000};
const workerPassword="disposable-candidate-only";
export const operatorPool=()=>new Pool({...target,max:4});
// `options` applies settings at login; used to compare commit durability modes.
export const workerPool=(options?:string)=>new Pool({...target,user:candidateRole,password:workerPassword,max:20,...(options?{options}:{})});
const absent=async(op:Pool)=>(await op.query(
  "SELECT to_regnamespace($1) IS NULL AS schema_absent,NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role_absent",
  [candidateSchema,candidateRole])).rows[0] as {schema_absent:boolean;role_absent:boolean};
const transaction=async(op:Pool,statements:CandidateStatement[])=>{
  const c=await op.connect();
  try{
    await c.query("BEGIN");
    for(const statement of statements)await c.query(statement.text,statement.params ?? []);
    await c.query("COMMIT");
  }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
};
export const setupCandidate=async(op:Pool,context:CandidateContext)=>{
  const before=await absent(op);
  if(!before.schema_absent||!before.role_absent)throw new Error("Refusing existing candidate schema or role");
  await transaction(op,candidateSetupStatements(context,workerPassword));
};
export const cleanupCandidate=async(op:Pool,owner:string)=>{
  await transaction(op,candidateCleanupStatements(owner));
  const after=await absent(op);
  if(!after.schema_absent||!after.role_absent)throw new Error("Candidate schema or role survived cleanup");
};
