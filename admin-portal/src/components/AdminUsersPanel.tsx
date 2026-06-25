"use client";

import { FormEvent, useState } from "react";
import { AdminUser } from "./types";

type Props = {
  users: AdminUser[];
  totalBeforeFilter?: number;
  onCreate: (payload: {
    fullName: string;
    email: string;
    password: string;
    role: "admin" | "super_admin";
  }) => Promise<void>;
};

export function AdminUsersPanel({ users, onCreate, totalBeforeFilter }: Props) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "super_admin">("admin");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onCreate({ fullName, email, password, role });
    setFullName("");
    setEmail("");
    setPassword("");
    setRole("admin");
  }

  return (
    <div className="space-y-4">
      <form className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/50 p-4" onSubmit={submit}>
        <p className="text-sm font-semibold">Create Admin User</p>
        <input className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-sm" placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <input className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-sm" placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-sm" placeholder="Password (min 8)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-sm" value={role} onChange={(e) => setRole(e.target.value as "admin" | "super_admin")}>
          <option value="admin">Admin</option>
          <option value="super_admin">Super Admin</option>
        </select>
        <button className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium">Create Admin</button>
      </form>

      <div className="space-y-2">
        {users.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            {totalBeforeFilter && totalBeforeFilter > 0 ? "No staff accounts match your filter." : "No admin users."}
          </p>
        ) : (
          users.map((u) => (
            <article key={u.id} className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
              <p className="font-medium">{u.full_name}</p>
              <p className="text-xs text-[var(--muted)]">
                {u.email} | {u.role} | {u.is_active ? "active" : "inactive"}
              </p>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
