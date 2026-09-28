"use client";

import { useEffect, useState } from "react";
import { getAuthHeaders } from "@/lib/authHeaders";
import { useAuthStatus } from "@/store/hooks";
import type { CreatorSubmissionSummary } from "@/lib/creatorSubmissionsRepo";

// Internal-only tool (#34) -- no nav link anywhere. Not gated by an
// independently-duplicated admin-uid check on the client: the real
// authorization boundary is the API route's requireAdminUid, so this
// page just attempts the authenticated GET and lets that call's actual
// 403 (vs. 200) decide what renders. Two sources of truth for the same
// decision would only risk drifting out of sync with each other.
type LoadState = "loading" | "forbidden" | "error" | "ready";

const emptyForm = { channelName: "", videoUrl: "", videoTitle: "", transcriptText: "" };

export default function CreatorSubmissionsPage() {
  const authStatus = useAuthStatus();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [submissions, setSubmissions] = useState<CreatorSubmissionSummary[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  // Pure fetch, no setState -- kept separate from applyFetchResult below
  // so the same fetch logic can be reused both by the mount effect
  // (which needs the ignore-flag race-guard pattern) and by
  // handleSubmit's post-submit refresh (a plain event handler, no
  // race-guard needed there).
  type FetchResult =
    | { status: "forbidden" }
    | { status: "error" }
    | { status: "ok"; submissions: CreatorSubmissionSummary[] };

  const fetchSubmissions = async (): Promise<FetchResult> => {
    try {
      const res = await fetch("/api/creator-submissions", { headers: await getAuthHeaders() });
      if (res.status === 403 || res.status === 401) return { status: "forbidden" };
      const data = await res.json();
      if (!data.success) return { status: "error" };
      return { status: "ok", submissions: data.submissions };
    } catch {
      return { status: "error" };
    }
  };

  const applyFetchResult = (result: FetchResult) => {
    if (result.status === "forbidden") setLoadState("forbidden");
    else if (result.status === "error") setLoadState("error");
    else {
      setSubmissions(result.submissions);
      setLoadState("ready");
    }
  };

  useEffect(() => {
    if (authStatus !== "signed-in") return;
    let ignore = false;
    fetchSubmissions().then((result) => {
      if (!ignore) applyFetchResult(result);
    });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchSubmissions/applyFetchResult are recreated every render but stable in behavior; only a genuine sign-in transition should re-trigger this fetch
  }, [authStatus]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setSubmitMessage(null);

    try {
      const res = await fetch("/api/creator-submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!data.success) {
        setSubmitMessage(`Failed: ${data.reason ?? "unknown error"}`);
        return;
      }
      setSubmitMessage(
        data.result.status === "already-submitted"
          ? "Already had this video (matched by URL) — no duplicate created."
          : "Submitted."
      );
      setForm(emptyForm);
      applyFetchResult(await fetchSubmissions());
    } catch (err) {
      setSubmitMessage(`Failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (authStatus === "loading") {
    return <p className="text-sm text-zinc-500">…</p>;
  }
  if (authStatus === "unavailable") {
    return <p className="text-sm text-zinc-500">Sign-in is currently unavailable.</p>;
  }
  if (authStatus !== "signed-in") {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">Sign in to view this page.</p>;
  }
  if (loadState === "loading") {
    return <p className="text-sm text-zinc-500">…</p>;
  }
  if (loadState === "forbidden") {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">Not authorized.</p>;
  }
  if (loadState === "error") {
    return <p className="text-sm text-red-600">Failed to load. Refresh to retry.</p>;
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-lg font-medium">Submit a creator transcript</h2>
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <input
            type="text"
            required
            placeholder="Channel name"
            value={form.channelName}
            onChange={(e) => setForm({ ...form, channelName: e.target.value })}
            className="w-full rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            type="text"
            placeholder="Video URL (optional)"
            value={form.videoUrl}
            onChange={(e) => setForm({ ...form, videoUrl: e.target.value })}
            className="w-full rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            type="text"
            placeholder="Video title (optional)"
            value={form.videoTitle}
            onChange={(e) => setForm({ ...form, videoTitle: e.target.value })}
            className="w-full rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <textarea
            required
            placeholder="Transcript text"
            rows={10}
            value={form.transcriptText}
            onChange={(e) => setForm({ ...form, transcriptText: e.target.value })}
            className="w-full rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {submitting ? "Submitting…" : "Submit"}
          </button>
          {submitMessage && <p className="text-sm text-zinc-600 dark:text-zinc-400">{submitMessage}</p>}
        </form>
      </section>

      <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-lg font-medium">Past submissions</h2>
        {submissions.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">None yet.</p>
        ) : (
          <ul className="mt-4 space-y-2 text-sm">
            {submissions.map((s) => (
              <li key={s.id} className="flex justify-between border-b border-zinc-100 pb-2 dark:border-zinc-800">
                <span>
                  {s.channelName} —{" "}
                  {s.videoUrl ? (
                    <a href={s.videoUrl} target="_blank" rel="noreferrer" className="underline">
                      {s.videoTitle || s.videoUrl}
                    </a>
                  ) : (
                    s.videoTitle || "(untitled)"
                  )}
                </span>
                <span className="text-zinc-400">
                  {new Date(s.submittedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
