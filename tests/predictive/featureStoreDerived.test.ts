import { describe,it,expect } from "vitest";
import type { Client } from "pg";
import { runDerivedJob } from "@/lib/featureStore/derived";

describe("derived job connection ownership",()=>{
 it("never sends rollback or another query after a client read timeout",async()=>{
  const calls:string[]=[];
  const client={query:async(input:string|{text:string})=>{
   const text=typeof input==="string"?input:input.text;calls.push(text);
   if(text.startsWith("ANALYZE"))return {rows:[]};
   if(text.includes("WITH clock"))return {rows:[{checkpoint:"2026-10-17T12:00:00Z",valid:true,inputs:[]}]};
   if(text.includes("INSERT INTO fs138.job_runs"))return {rows:[{job_id:"00000000-0000-0000-0000-000000000001",status:"running"}]};
   if(typeof input!=="string")throw new Error("Query read timeout");
   return {rows:[]};
  }};
  await expect(runDerivedJob(client as unknown as Pick<Client,"query">,"features",
   {season:2025,mode:"retrospective-reconstruction-v1"},{gitSha:"a".repeat(40),contentSha256:"b".repeat(64)}))
   .rejects.toThrow("derived-connection-interrupted-replace");
  expect(calls).toHaveLength(5);
  expect(calls.some(text=>text.startsWith("ANALYZE"))).toBe(false);
  expect(calls.some(text=>text==="ROLLBACK"||text==="COMMIT"||text.includes("UPDATE fs138.job_runs"))).toBe(false);
 });
});
