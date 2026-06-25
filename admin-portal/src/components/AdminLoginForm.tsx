"use client";

import { FormEvent, useState } from "react";
import { ADMIN_API_BASE_URL } from "@/config";
import { showAdminToast } from "@/lib/adminNotify";

type Props = {
  onLoggedIn: (tokens: { accessToken: string; refreshToken: string; email: string }) => void;
};

export function AdminLoginForm({ onLoggedIn }: Props) {
  const [email, setEmail] = useState("admin@growthcapital.local");
  const [password, setPassword] = useState("Admin@123");

  async function handleAdminLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const response = await fetch(`${ADMIN_API_BASE_URL}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(String(payload.message || "Admin login failed."));
      onLoggedIn({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        email: String(payload.admin?.email ?? email),
      });
    } catch (e) {
      showAdminToast(e instanceof Error ? e.message : "Admin login failed.", "error");
    }
  }

  return (
    <form className="mt-6 max-w-md space-y-4 rounded-2xl border border-slate-700 bg-[var(--panel)] p-6" onSubmit={handleAdminLogin}>
      <input className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Admin email" />
      <input className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Admin password" type="password" />
      <button className="w-full rounded-lg bg-[var(--primary)] px-4 py-2 font-medium">Login as Admin</button>
    </form>
  );
}
