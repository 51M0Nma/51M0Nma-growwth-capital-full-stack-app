"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminApiFetch } from "@/lib/fetchWithAutoRefresh";
import { ADMIN_API_BASE_URL } from "@/config";
import { clearAdminToasts, showAdminToast } from "@/lib/adminNotify";
import { SearchableUserSelect } from "./SearchableUserSelect";
import { AdminWalletTransactionRow, AppUser, DepositPaymentIntent } from "./types";

type Props = {
  adminApiFetch: AdminApiFetch;
  appUsers: AppUser[];
};

type WalletPanelSection = "setup" | "ledger";

export function WalletAdminPanel({ adminApiFetch, appUsers }: Props) {
  const [panelSection, setPanelSection] = useState<WalletPanelSection>("ledger");
  const [userFilter, setUserFilter] = useState("");
  const [rows, setRows] = useState<AdminWalletTransactionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<Record<string, { status: string; note: string }>>({});
  const [actionUserId, setActionUserId] = useState("");
  const [actionAmount, setActionAmount] = useState("100");
  const [actionNote, setActionNote] = useState("");
  const [actionStatus, setActionStatus] = useState<"pending" | "completed">("completed");
  const [bookBalance, setBookBalance] = useState<number | null>(null);
  const [paymentIntents, setPaymentIntents] = useState<DepositPaymentIntent[]>([]);
  const [intentMaxActive, setIntentMaxActive] = useState(20);
  const [intentActiveCount, setIntentActiveCount] = useState(0);
  const [newIntentId, setNewIntentId] = useState("");
  const [newIntentLabel, setNewIntentLabel] = useState("");
  const [newIntentSort, setNewIntentSort] = useState("0");
  const [loadingIntents, setLoadingIntents] = useState(false);

  const loadIntents = useCallback(async () => {
    setLoadingIntents(true);
    try {
      const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/deposit-payment-intents`, { headers: {} });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Could not load payment IDs.");
      setPaymentIntents(payload.intents || []);
      setIntentMaxActive(Number(payload.maxActive ?? 20));
      setIntentActiveCount(Number(payload.activeCount ?? 0));
    } catch (e) {
      showAdminToast(e instanceof Error ? e.message : "Could not load payment IDs.", "error");
    } finally {
      setLoadingIntents(false);
    }
  }, [adminApiFetch]);

  const load = useCallback(async () => {
    setLoading(true);
    clearAdminToasts();
    try {
      const q = userFilter.trim() ? `?userId=${encodeURIComponent(userFilter.trim())}` : "";
      const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/wallet-transactions${q}`, { headers: {} });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Could not load wallet activity.");
      const list = payload.transactions || [];
      setRows(list);
      const nextEdits: Record<string, { status: string; note: string }> = {};
      for (const t of list) {
        nextEdits[t.id] = { status: t.status, note: t.note || "" };
      }
      setEdits(nextEdits);
    } catch (e) {
      showAdminToast(e instanceof Error ? e.message : "Load failed.", "error");
    } finally {
      setLoading(false);
    }
  }, [adminApiFetch, userFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadIntents();
  }, [loadIntents]);

  useEffect(() => {
    if (!actionUserId) {
      setBookBalance(null);
      return;
    }
    let cancelled = false;
    async function run() {
      const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users/${actionUserId}/wallet/balance`, {
        headers: {},
      });
      const payload = await response.json();
      if (!cancelled && response.ok) setBookBalance(Number(payload.balance ?? 0));
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [adminApiFetch, actionUserId]);

  async function postMovement(kind: "deposit" | "withdrawal") {
    if (!actionUserId) {
      showAdminToast("Select a customer for this wallet movement.", "error");
      return;
    }
    const amount = Number(actionAmount);
    if (!amount || amount <= 0) {
      showAdminToast("Enter a valid amount.", "error");
      return;
    }
    clearAdminToasts();
    const path =
      kind === "deposit"
        ? `${ADMIN_API_BASE_URL}/api/admin/app-users/${actionUserId}/wallet/deposit`
        : `${ADMIN_API_BASE_URL}/api/admin/app-users/${actionUserId}/wallet/withdraw`;
    const response = await adminApiFetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        note: actionNote.trim() || undefined,
        status: actionStatus,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Could not record movement."), "error");
      return;
    }
    showAdminToast(`${kind === "deposit" ? "Deposit" : "Withdrawal"} recorded (${actionStatus}).`, "success");
    setActionNote("");
    const balRes = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users/${actionUserId}/wallet/balance`, {
      headers: {},
    });
    const balPayload = await balRes.json();
    if (balRes.ok) setBookBalance(Number(balPayload.balance ?? 0));
    await load();
  }

  async function saveRow(id: string) {
    const edit = edits[id];
    if (!edit) return;
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/wallet-transactions/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: edit.status, note: edit.note }),
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Update failed."), "error");
      return;
    }
    showAdminToast(`Transaction ${id.slice(0, 8)} updated to ${edit.status}.`, "success");
    await load();
  }

  async function addPaymentIntent() {
    const intent_payment_id = newIntentId.trim();
    if (!intent_payment_id) {
      showAdminToast("Enter a payment / UPI / intent ID.", "error");
      return;
    }
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/deposit-payment-intents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent_payment_id,
        label: newIntentLabel.trim() || undefined,
        sort_order: Number(newIntentSort) || 0,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Could not add payment ID."), "error");
      return;
    }
    setNewIntentId("");
    setNewIntentLabel("");
    setNewIntentSort("0");
    showAdminToast("Payment ID added.", "success");
    await loadIntents();
  }

  async function toggleIntentActive(intent: DepositPaymentIntent) {
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/deposit-payment-intents/${intent.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ is_active: !intent.is_active }),
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Update failed."), "error");
      return;
    }
    await loadIntents();
  }

  async function removeIntent(id: string) {
    if (!globalThis.confirm("Remove this payment ID from the pool?")) return;
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/deposit-payment-intents/${id}`, {
      method: "DELETE",
      headers: {},
    });
    if (!response.ok) {
      const payload = await response.json();
      showAdminToast(String(payload.message || "Delete failed."), "error");
      return;
    }
    await loadIntents();
  }

  const tabBtn = (id: WalletPanelSection, label: string, extra?: React.ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={panelSection === id}
      className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
        panelSection === id
          ? "bg-[var(--primary)] text-white"
          : "border border-slate-600 bg-slate-900/40 text-slate-200 hover:bg-slate-800/60"
      }`}
      onClick={() => setPanelSection(id)}
    >
      {label}
      {extra}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-700 pb-3" role="tablist" aria-label="Wallet sections">
        {tabBtn("setup", "Setup & movements")}
        {tabBtn(
          "ledger",
          "Ledger",
          rows.length > 0 ? (
            <span className="rounded-md bg-black/25 px-1.5 py-0.5 text-xs font-normal tabular-nums opacity-90">{rows.length}</span>
          ) : null
        )}
      </div>

      {panelSection === "setup" ? (
        <div className="space-y-4">
      <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 space-y-3">
        <p className="text-sm font-medium">Add-money payment IDs (rotating pool)</p>
        <p className="text-xs text-[var(--muted)]">
          Up to {intentMaxActive} can be active at once. When a customer starts an add-money request, the app assigns
          the next ID in rotation so different users see different destinations. Confirm pending deposits on the Ledger
          tab after you verify their payment.
        </p>
        <p className="text-xs font-mono text-[var(--text)]">
          Active now: {intentActiveCount} / {intentMaxActive}
          {loadingIntents ? " · loading…" : ""}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm min-w-[200px] flex-1">
            <span className="text-[var(--muted)]">Intent / UPI / payment ID</span>
            <input
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm font-mono"
              value={newIntentId}
              onChange={(ev) => setNewIntentId(ev.target.value)}
              placeholder="e.g. merchant@upi or reference"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm w-40">
            <span className="text-[var(--muted)]">Label (optional)</span>
            <input
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
              value={newIntentLabel}
              onChange={(ev) => setNewIntentLabel(ev.target.value)}
              placeholder="Account name"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm w-24">
            <span className="text-[var(--muted)]">Sort</span>
            <input
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
              value={newIntentSort}
              onChange={(ev) => setNewIntentSort(ev.target.value)}
              inputMode="numeric"
            />
          </label>
          <button
            type="button"
            className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium"
            onClick={() => void addPaymentIntent()}
          >
            Add ID
          </button>
        </div>
        {paymentIntents.length ? (
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead className="border-b border-slate-700 bg-slate-900/80 text-xs uppercase text-[var(--muted)]">
                <tr>
                  <th className="px-2 py-2">Payment ID</th>
                  <th className="px-2 py-2">Label</th>
                  <th className="px-2 py-2">Active</th>
                  <th className="px-2 py-2">Last assigned</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {paymentIntents.map((row) => (
                  <tr key={row.id} className="border-b border-slate-800/80">
                    <td className="px-2 py-2 font-mono text-xs break-all">{row.intent_payment_id}</td>
                    <td className="px-2 py-2">{row.label || "—"}</td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        className={`rounded px-2 py-1 text-xs font-medium ${
                          row.is_active ? "bg-emerald-900/50 text-emerald-200" : "bg-slate-800 text-slate-400"
                        }`}
                        onClick={() => void toggleIntentActive(row)}
                      >
                        {row.is_active ? "on" : "off"}
                      </button>
                    </td>
                    <td className="px-2 py-2 text-xs text-[var(--muted)]">
                      {row.last_assigned_at ? new Date(row.last_assigned_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        className="text-xs text-rose-300 hover:underline"
                        onClick={() => void removeIntent(row.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !loadingIntents && (
            <p className="text-xs text-[var(--muted)]">No payment IDs yet — customers cannot start add-money until you add at least one active ID.</p>
          )
        )}
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 space-y-3">
        <p className="text-sm font-medium">Record wallet movement</p>
        <p className="text-xs text-[var(--muted)]">
          Post credits or debits for a customer (pending until you reconcile, or completed immediately). Completed
          withdrawals require enough settled balance.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Customer</span>
            <SearchableUserSelect
              users={appUsers}
              value={actionUserId}
              onChange={setActionUserId}
              placeholder="Select…"
              emptyLabel="Select…"
              getOptionLabel={(u) => `${u.full_name} (${u.email})`}
              className="min-w-[220px]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Amount</span>
            <input
              className="w-28 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
              value={actionAmount}
              onChange={(ev) => setActionAmount(ev.target.value)}
              inputMode="decimal"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Initial status</span>
            <select
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
              value={actionStatus}
              onChange={(ev) => setActionStatus(ev.target.value as "pending" | "completed")}
            >
              <option value="completed">completed</option>
              <option value="pending">pending</option>
            </select>
          </label>
        </div>
        <input
          className="w-full max-w-lg rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
          placeholder="Note (optional)"
          value={actionNote}
          onChange={(ev) => setActionNote(ev.target.value)}
        />
        {actionUserId && bookBalance !== null ? (
          <p className="text-xs text-[var(--muted)]">
            Settled balance (completed txs only): <span className="font-mono text-[var(--text)]">{bookBalance.toFixed(4)}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg bg-[var(--success)] px-4 py-2 text-sm font-medium text-black"
            onClick={() => void postMovement("deposit")}
          >
            Record deposit
          </button>
          <button
            type="button"
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white"
            onClick={() => void postMovement("withdrawal")}
          >
            Record withdrawal
          </button>
        </div>
      </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Ledger filter</span>
              <SearchableUserSelect
                users={appUsers}
                value={userFilter}
                onChange={setUserFilter}
                placeholder="All users"
                emptyLabel="All users"
                getOptionLabel={(u) => `${u.full_name} (${u.email})`}
                className="min-w-[220px]"
              />
            </label>
            <button
              type="button"
              className="rounded-lg border border-slate-600 px-3 py-2 text-sm"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? "Loading…" : "Reload"}
            </button>
          </div>

          <p className="text-xs text-[var(--muted)]">
            Update status or notes on any row. For customer add-money, set pending deposits to completed after you verify
            payment. For withdrawals, use payout UPI / name to pay the user manually, then mark completed (or rejected).
            This list scrolls inside the panel so it stays manageable as volume grows.
          </p>

          {loading && !rows.length ? (
            <p className="text-sm text-[var(--muted)]">Loading…</p>
          ) : !rows.length ? (
            <p className="text-sm text-[var(--muted)]">No transactions.</p>
          ) : (
            <div className="max-h-[min(70vh,56rem)] overflow-auto rounded-lg border border-slate-700">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
                  <thead className="sticky top-0 z-10 border-b border-slate-700 bg-slate-900/95 text-xs uppercase text-[var(--muted)] shadow-sm backdrop-blur-sm">
                    <tr>
                      <th className="px-2 py-2">User</th>
                      <th className="px-2 py-2">Type</th>
                      <th className="px-2 py-2">Amount</th>
                      <th className="px-2 py-2">Pay-in ID</th>
                      <th className="px-2 py-2">Payout UPI</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2">Note</th>
                      <th className="px-2 py-2">Created</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.id} className="border-b border-slate-800/80">
                        <td className="px-2 py-2">
                          <div className="font-medium">{t.user_full_name}</div>
                          <div className="text-xs text-[var(--muted)]">{t.user_email}</div>
                        </td>
                        <td className="px-2 py-2">{t.type}</td>
                        <td className="px-2 py-2">{t.amount}</td>
                        <td className="px-2 py-2 font-mono text-xs break-all max-w-[140px]">
                          {t.intent_payment_id || "—"}
                        </td>
                        <td className="px-2 py-2 text-xs max-w-[160px]">
                          {t.payout_upi ? (
                            <>
                              <div className="font-mono break-all">{t.payout_upi}</div>
                              {t.payout_account_name ? (
                                <div className="text-[var(--muted)]">{t.payout_account_name}</div>
                              ) : null}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <select
                            className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
                            value={edits[t.id]?.status ?? t.status}
                            onChange={(ev) =>
                              setEdits((prev) => ({
                                ...prev,
                                [t.id]: { ...prev[t.id], status: ev.target.value, note: prev[t.id]?.note ?? t.note ?? "" },
                              }))
                            }
                          >
                            <option value="pending">pending</option>
                            <option value="completed">completed</option>
                            <option value="rejected">rejected</option>
                          </select>
                        </td>
                        <td className="px-2 py-2">
                          <input
                            className="w-full min-w-[120px] rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
                            value={edits[t.id]?.note ?? ""}
                            onChange={(ev) =>
                              setEdits((prev) => ({
                                ...prev,
                                [t.id]: {
                                  status: prev[t.id]?.status ?? t.status,
                                  note: ev.target.value,
                                },
                              }))
                            }
                          />
                        </td>
                        <td className="px-2 py-2 text-xs text-[var(--muted)]">{new Date(t.created_at).toLocaleString()}</td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            className="rounded bg-[var(--primary)] px-2 py-1 text-xs font-medium"
                            onClick={() => void saveRow(t.id)}
                          >
                            Save
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
