"use client";

import { DeadLetter } from "./types";

type Props = {
  rows: DeadLetter[];
  totalBeforeFilter?: number;
};

export function DeadLetterList({ rows, totalBeforeFilter }: Props) {
  if (!rows.length) {
    if (totalBeforeFilter && totalBeforeFilter > 0) {
      return <p className="text-sm text-[var(--muted)]">No delivery failures match your filter.</p>;
    }
    return <p className="text-sm text-[var(--muted)]">No dead-letter records.</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((item) => (
        <article key={item.id} className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <p className="text-sm font-medium uppercase">{item.channel}</p>
          <p className="text-xs text-[var(--muted)]">Recipient: {item.recipient}</p>
          <p className="text-xs text-[var(--muted)]">Attempts: {item.attempts}</p>
          <p className="text-xs text-red-300">Reason: {item.reason}</p>
          <p className="text-xs text-[var(--muted)]">{new Date(item.created_at).toLocaleString()}</p>
        </article>
      ))}
    </div>
  );
}
