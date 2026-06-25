"use client";

import { AuditLog } from "./types";

type Props = {
  logs: AuditLog[];
  totalBeforeFilter?: number;
};

export function AuditList({ logs, totalBeforeFilter }: Props) {
  if (!logs.length) {
    if (totalBeforeFilter && totalBeforeFilter > 0) {
      return <p className="text-sm text-[var(--muted)]">No audit entries match your filter.</p>;
    }
    return <p className="text-sm text-[var(--muted)]">No audit logs yet.</p>;
  }
  return (
    <div className="space-y-2">
      {logs.map((log) => (
        <article key={log.id} className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <p className="text-sm font-medium">{log.action}</p>
          <p className="text-xs text-[var(--muted)]">Actor: {log.actor} | User: {log.target_user_email}</p>
          <p className="text-xs text-[var(--muted)]">Request ID: {log.target_request_id} | {new Date(log.created_at).toLocaleString()}</p>
        </article>
      ))}
    </div>
  );
}
