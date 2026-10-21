"use client";
import { useState } from "react";
export default function BenchmarkPage() {
  const [token,setToken]=useState("");
  const [action,setAction]=useState("catalog");
  const [busy,setBusy]=useState(false);
  const [results,setResults]=useState<string[]>([]);
  return <main className="mx-auto max-w-3xl space-y-4 p-6">
    <h1>Disposable #61 benchmark</h1>
    <p>Synthetic Preview data only. No provider calls. Workload operations run once. Cleanup is retryable; do not retry ambiguous workload results.</p>
    <form className="space-y-4" onSubmit={async event=>{
      event.preventDefault();setBusy(true);
      try {
        const started=performance.now();
        const response=await fetch("/api/bench61",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({token,action})});
        const text=await response.text();
        setResults(previous=>[...previous,JSON.stringify({action,status:response.status,browser_round_trip_ms:performance.now()-started,
          result:text?JSON.parse(text):"Denied before SQL"},null,2)]);
      } catch { setResults(previous=>[...previous,action === "cleanup" ? "Cleanup was not confirmed; retry cleanup." : "Request failed; do not retry ambiguous workload writes."]); }
      finally {setBusy(false);}
    }}>
      <label className="block">Benchmark token <input type="password" autoComplete="off" className="block min-h-11 border p-2" value={token} onChange={e=>setToken(e.target.value)} /></label>
      <label className="block">Operation <select className="block min-h-11 border p-2" value={action} onChange={e=>setAction(e.target.value)}>
        {["setup","run","cold1","cold2","cold3","catalog","cleanup"].map(value=><option key={value}>{value}</option>)}
      </select></label>
      <button disabled={busy} className="min-h-11 rounded border px-4">{busy?"Running…":"Run selected operation"}</button>
    </form>
    {results.map((result,i)=><pre className="overflow-auto whitespace-pre-wrap break-words" key={i}>{result}</pre>)}
  </main>;
}
