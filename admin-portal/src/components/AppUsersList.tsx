"use client";

import { useState } from "react";
import type { AdminApiFetch } from "@/lib/fetchWithAutoRefresh";
import { ADMIN_API_BASE_URL } from "@/config";
import { clearAdminToasts, showAdminToast } from "@/lib/adminNotify";
import { showCredentialsShareToast } from "@/lib/credentialsShareToast";
import { AppUser } from "./types";

type Props = {
  users: AppUser[];
  loading: boolean;
  adminApiFetch: AdminApiFetch;
  totalBeforeFilter?: number;
};

export function AppUsersList({ users, loading, adminApiFetch, totalBeforeFilter }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function resetPassword(u: AppUser) {
    const ok = window.confirm(
      `Generate a temporary password for ${u.email}? They will be required to change it after signing in.`
    );
    if (!ok) return;
    setBusyId(u.id);
    clearAdminToasts();
    try {
      const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users/${u.id}/reset-password`, {
        method: "POST",
        headers: {},
      });
      const payload = await response.json();
      if (!response.ok) {
        showAdminToast(String(payload.message || "Password reset failed."), "error");
        return;
      }
      showCredentialsShareToast({
        title: `Password reset for ${String(payload.email ?? u.email)}`,
        email: String(payload.email ?? u.email),
        password: String(payload.temporaryPassword ?? ""),
        note: "User must change their password after sign-in.",
      });
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p className="text-sm text-[var(--muted)]">Loading customers…</p>;
  if (!users.length) {
    if (totalBeforeFilter && totalBeforeFilter > 0) {
      return <p className="text-sm text-[var(--muted)]">No customers match your filter.</p>;
    }
    return <p className="text-sm text-[var(--muted)]">No customers yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-700">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead className="border-b border-slate-700 bg-slate-900/80 text-xs uppercase tracking-wide text-[var(--muted)]">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Email</th>
            <th className="px-3 py-2">Phone</th>
            <th className="px-3 py-2">Must change password</th>
            <th className="px-3 py-2">User ID</th>
            <th className="px-3 py-2">Created</th>
            <th className="px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-slate-800/80">
              <td className="px-3 py-2 font-medium">{u.full_name}</td>
              <td className="px-3 py-2 text-[var(--muted)]">{u.email}</td>
              <td className="px-3 py-2 text-[var(--muted)]">{u.phone || "—"}</td>
              <td className="px-3 py-2">{u.must_change_password ? "Yes" : "No"}</td>
              <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">{u.id}</td>
              <td className="px-3 py-2 text-[var(--muted)]">{new Date(u.created_at).toLocaleString()}</td>
              <td className="px-3 py-2">
                <button
                  type="button"
                  className="rounded border border-amber-600/60 px-2 py-1 text-xs text-amber-200 hover:bg-amber-950/40 disabled:opacity-50"
                  disabled={busyId !== null}
                  onClick={() => void resetPassword(u)}
                >
                  {busyId === u.id ? "…" : "Reset password"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
