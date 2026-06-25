"use client";

import { AccessRequest } from "./types";

type Props = {
  requests: AccessRequest[];
  loading: boolean;
  onVerify: (requestId: string) => void;
  onReject: (requestId: string) => void;
  /** When filtering, total rows before filter (for empty-state copy). */
  totalBeforeFilter?: number;
};

export function RequestList({ requests, loading, onVerify, onReject, totalBeforeFilter }: Props) {
  if (loading) return <p className="text-sm text-[var(--muted)]">Loading requests...</p>;
  if (!requests.length) {
    if (totalBeforeFilter && totalBeforeFilter > 0) {
      return <p className="text-sm text-[var(--muted)]">No requests match your filter.</p>;
    }
    return <p className="text-sm text-[var(--muted)]">No requests found.</p>;
  }

  return (
    <div className="space-y-3">
      {requests.map((item) => (
        <article key={item.id} className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">{item.full_name}</p>
            <span className="rounded bg-slate-800 px-2 py-1 text-xs uppercase tracking-wide">{item.status}</span>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">{item.email} | {item.phone}</p>
          <p className="text-xs text-[var(--muted)]">{item.organization || "No organization"} | {item.country || "No country"}</p>
          {item.status === "pending" ? (
            <div className="mt-3 flex gap-2">
              <button className="rounded bg-[var(--success)] px-3 py-1 text-sm font-medium text-black" onClick={() => onVerify(item.id)}>
                Verify & Send Credentials
              </button>
              <button className="rounded bg-[var(--danger)] px-3 py-1 text-sm font-medium" onClick={() => onReject(item.id)}>
                Reject
              </button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
