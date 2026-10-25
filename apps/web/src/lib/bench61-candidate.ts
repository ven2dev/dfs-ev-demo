// Unrouted, disposable local candidate. No client construction or environment reads.
export const candidateSchema = "bench61_candidate_20261024";
const s = '"' + candidateSchema + '"';
export type CandidateMode = "baseline" | "debit" | "correction";
export type CandidateContext = {owner:string;request:string;account:string;period:string};
type Rows = Record<string,unknown>[];
export type CandidateQuery = (text:string,params:unknown[])=>Promise<Rows>;
const guard = `WITH guard AS MATERIALIZED (SELECT ${s}.guard($1,$2))`;
const eligible = `account=$3 AND period=$4 AND active AND $5::bigint>0
  AND observed_at<=clock_timestamp() AND observed_at>=clock_timestamp()-interval '5 minutes'
  AND balance-$5::bigint>=CASE WHEN $6::boolean THEN floor ELSE 0 END`;
export const candidateSql = (mode:CandidateMode) => {
  if(mode==="baseline")return `${guard} SELECT balance FROM ${s}.budgets,guard WHERE ${eligible}`;
  if(mode==="debit")return `${guard} UPDATE ${s}.budgets SET balance=balance-$5::bigint FROM guard
    WHERE ${eligible} RETURNING balance`;
  if(mode==="correction")return `${guard} UPDATE ${s}.budgets
    SET balance=LEAST(balance,$5::bigint),observed_at=$6::timestamptz FROM guard
    WHERE account=$3 AND period=$4 AND active AND $5::bigint>=0
      AND $6::timestamptz>=observed_at AND $6::timestamptz<=clock_timestamp() RETURNING balance`;
  throw new Error("Unknown candidate mode");
};
export const candidateParams = (context:CandidateContext,value:number,interactiveOrObserved:boolean|string):unknown[] => {
  if(!Number.isSafeInteger(value)||value<0)throw new Error("Invalid candidate amount");
  return [context.owner,context.request,context.account,context.period,value,interactiveOrObserved];
};
// Counts successful/denied operations separately. No retries or provider sends.
// An error stops new dispatches; all already-started queries settle before return.
export const runCandidateBatch = async (query:CandidateQuery,mode:CandidateMode,params:unknown[],count:number,workers:number) => {
  if(!Number.isInteger(count)||count<1||count>1000||!Number.isInteger(workers)||workers<1||workers>20)
    throw new Error("Candidate workload outside local cap");
  const text=candidateSql(mode);
  let next=0,started=0,admitted=0,denied=0,failed=false,failure:unknown;
  const results=await Promise.allSettled(Array.from({length:Math.min(workers,count)},async()=>{
    while(!failed && next<count){
      next++;started++;
      try{const rows=await query(text,params);if(rows.length)admitted++;else denied++;}
      catch(error){if(!failed){failed=true;failure=error;}break;}
    }
  }));
  // Worker logic should not throw outside its query catch, but preserve draining
  // even if an unexpected injected adapter error occurs.
  const unexpected=results.find(result=>result.status==="rejected");
  if(unexpected?.status==="rejected")throw unexpected.reason;
  if(failed)throw failure;
  return {started,admitted,denied,roundTrips:started,submittedStatements:started};
};
