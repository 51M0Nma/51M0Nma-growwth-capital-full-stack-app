"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminApiFetch } from "@/lib/fetchWithAutoRefresh";
import { ADMIN_API_BASE_URL } from "@/config";
import { clearAdminToasts, showAdminToast } from "@/lib/adminNotify";
import { SearchableUserSelect } from "./SearchableUserSelect";
import { AdminOrderRow, AppUser, TradeSummary } from "./types";

type QuantityRulesPayload = {
  venue: string;
  qtyMin: number;
  qtyStep: number;
  qtyDecimals: number;
  qtyUnit: string;
  lotDescription?: string | null;
};

type Props = {
  adminApiFetch: AdminApiFetch;
  appUsers: AppUser[];
};

export function OrdersAdminPanel({ adminApiFetch, appUsers }: Props) {
  const [userFilter, setUserFilter] = useState("");
  const [venueFilter, setVenueFilter] = useState<"" | "crypto" | "nse" | "commodity">("");
  const [orders, setOrders] = useState<AdminOrderRow[]>([]);
  const [summary, setSummary] = useState<TradeSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [placeUserId, setPlaceUserId] = useState("");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("0.01");
  const [quoteSymbol, setQuoteSymbol] = useState("BTCUSDT");
  const [quote, setQuote] = useState<{ last: number; changePct: number } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quantityRules, setQuantityRules] = useState<QuantityRulesPayload | null>(null);
  const [placeUserBalance, setPlaceUserBalance] = useState<number | null>(null);
  const [placeUserBalanceLoading, setPlaceUserBalanceLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    clearAdminToasts();
    try {
      const params = new URLSearchParams();
      if (userFilter.trim()) params.set("userId", userFilter.trim());
      if (venueFilter) params.set("venue", venueFilter);
      const q = params.toString() ? `?${params.toString()}` : "";
      const [ordersRes, summaryRes] = await Promise.all([
        adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/orders${q}`, { headers: {} }),
        adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/trade-summary${q}`, { headers: {} }),
      ]);
      const [ordersPayload, summaryPayload] = await Promise.all([ordersRes.json(), summaryRes.json()]);
      if (!ordersRes.ok || !summaryRes.ok) {
        throw new Error(ordersPayload.message || summaryPayload.message || "Could not load orders.");
      }
      setOrders(ordersPayload.orders || []);
      setSummary(summaryPayload.summary || null);
    } catch (e) {
      showAdminToast(e instanceof Error ? e.message : "Load failed.", "error");
    } finally {
      setLoading(false);
    }
  }, [adminApiFetch, userFilter, venueFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setQuoteSymbol(symbol);
  }, [symbol]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        const sym = symbol.trim();
        if (!sym) {
          if (!cancelled) setQuantityRules(null);
          return;
        }
        try {
          const response = await adminApiFetch(
            `${ADMIN_API_BASE_URL}/api/market/quantity-rules?symbol=${encodeURIComponent(sym)}`,
            { headers: {} }
          );
          const payload = (await response.json()) as QuantityRulesPayload & { message?: string };
          if (cancelled) return;
          if (!response.ok) {
            setQuantityRules(null);
            return;
          }
          setQuantityRules(payload);
          const dec = Number(payload.qtyDecimals);
          const min = Number(payload.qtyMin);
          if (dec === 0) {
            setQuantity(String(Math.max(1, Number.isFinite(min) ? min : 1)));
          } else {
            setQuantity("0.01");
          }
        } catch {
          if (!cancelled) setQuantityRules(null);
        }
      })();
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [symbol, adminApiFetch]);

  useEffect(() => {
    let cancelled = false;
    if (!placeUserId) {
      setPlaceUserBalance(null);
      return;
    }
    setPlaceUserBalanceLoading(true);
    void (async () => {
      try {
        const response = await adminApiFetch(
          `${ADMIN_API_BASE_URL}/api/admin/app-users/${placeUserId}/wallet/balance`,
          { headers: {} }
        );
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setPlaceUserBalance(null);
          return;
        }
        setPlaceUserBalance(Number(payload.balance ?? 0));
      } catch {
        if (!cancelled) setPlaceUserBalance(null);
      } finally {
        if (!cancelled) setPlaceUserBalanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [placeUserId, adminApiFetch]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sym = symbol.trim() || "BTCUSDT";
      try {
        const response = await adminApiFetch(
          `${ADMIN_API_BASE_URL}/api/market/quote?symbol=${encodeURIComponent(sym)}`,
          { headers: {} }
        );
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || "Quote failed.");
        if (cancelled) return;
        setQuote({
          last: Number(payload.last || 0),
          changePct: Number(payload.changePct || 0),
        });
      } catch {
        if (!cancelled) setQuote(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, adminApiFetch]);

  async function closeOrder(id: string) {
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/orders/${id}/close`, {
      method: "POST",
      headers: {},
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Close failed."), "error");
      return;
    }
    showAdminToast(`Order ${id.slice(0, 8)} closed.`, "success");
    await load();
  }

  async function placeOrderForUser(e: React.FormEvent) {
    e.preventDefault();
    clearAdminToasts();
    if (!placeUserId) {
      showAdminToast("Select an app user to place an order.", "error");
      return;
    }
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/trade/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: placeUserId,
        symbol,
        side,
        quantity: Number(quantity),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      if (payload.code === "INSUFFICIENT_WALLET_BALANCE") {
        const shortfall = Number(payload.shortfall ?? 0);
        const balance = Number(payload.balance ?? 0);
        const required = Number(payload.required ?? 0);
        showAdminToast(
          `Insufficient wallet balance. User has ${balance.toFixed(2)} but buy needs ~${required.toFixed(2)} (short ${shortfall.toFixed(2)}). Add a deposit in Wallet first.`,
          "error"
        );
        setPlaceUserBalance(balance);
        return;
      }
      showAdminToast(String(payload.message || "Place order failed."), "error");
      return;
    }
    const exec = payload.execution as { estimatedNotional?: number } | undefined;
    const extra =
      exec?.estimatedNotional != null
        ? ` · ~$${Number(exec.estimatedNotional).toFixed(2)} notional`
        : "";
    showAdminToast(`Placed ${side.toUpperCase()} ${quantity} ${payload.order?.symbol || symbol} for user.${extra}`, "success");
    if (side === "buy") {
      const debited = Number(payload.walletDebited ?? exec?.estimatedNotional ?? 0);
      if (debited > 0) {
        setPlaceUserBalance((prev) => (prev != null ? Math.max(0, prev - debited) : prev));
      }
    }
    await load();
  }

  const estimatedBuyNotional =
    side === "buy" &&
    quote &&
    quoteSymbol.trim().toUpperCase() === symbol.trim().toUpperCase() &&
    Number(quantity) > 0
      ? quote.last * Number(quantity)
      : null;
  const buyShortfall =
    estimatedBuyNotional != null && placeUserBalance != null
      ? Math.max(0, estimatedBuyNotional - placeUserBalance)
      : null;

  async function refreshQuote() {
    setQuoteLoading(true);
    clearAdminToasts();
    try {
      const response = await adminApiFetch(
        `${ADMIN_API_BASE_URL}/api/market/quote?symbol=${encodeURIComponent(quoteSymbol.trim() || "BTCUSDT")}`,
        { headers: {} }
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Quote failed.");
      setQuote({
        last: Number(payload.last || 0),
        changePct: Number(payload.changePct || 0),
      });
    } catch (e) {
      showAdminToast(e instanceof Error ? e.message : "Quote failed.", "error");
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-[var(--muted)]">
        Oversee open positions, close trades when required, or open a trade on behalf of a customer. Use pricing
        reference when you need a live quote while handling tickets.
      </p>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-700 bg-slate-900/40 p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Pricing reference (symbol)</span>
          <input
            className="w-36 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm uppercase"
            value={quoteSymbol}
            onChange={(ev) => setQuoteSymbol(ev.target.value)}
          />
        </label>
        <button
          type="button"
          className="rounded-lg border border-slate-600 px-3 py-2 text-sm"
          onClick={() => void refreshQuote()}
          disabled={quoteLoading}
        >
          {quoteLoading ? "…" : "Refresh quote"}
        </button>
        {quote ? (
          <p className="text-sm">
            Last <span className="font-mono font-semibold">{quote.last.toFixed(4)}</span>
            <span className="ml-3 text-[var(--muted)]">Change {quote.changePct.toFixed(2)}%</span>
          </p>
        ) : (
          <p className="text-sm text-[var(--muted)]">No quote loaded.</p>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Ledger scope</span>
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
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Market</span>
          <select
            className="min-w-[160px] rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            value={venueFilter}
            onChange={(ev) => setVenueFilter(ev.target.value as typeof venueFilter)}
          >
            <option value="">All venues</option>
            <option value="crypto">Crypto</option>
            <option value="nse">NSE</option>
            <option value="commodity">Commodity</option>
          </select>
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

      {summary ? (
        <div className="flex flex-wrap gap-4 text-sm">
          <p>
            Open: <span className="font-semibold">{summary.open_count}</span>
          </p>
          <p>
            Closed: <span className="font-semibold">{summary.closed_count}</span>
          </p>
          <p>
            Total PnL: <span className="font-semibold">{Number(summary.total_pnl).toFixed(4)}</span>
          </p>
        </div>
      ) : null}

      <form
        onSubmit={placeOrderForUser}
        className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 space-y-4"
      >
        <p className="text-sm font-medium">Open trade for customer</p>
        <p className="text-xs text-[var(--muted)]">Use only when policy allows support-assisted execution.</p>
        <div className="flex flex-wrap gap-3">
          <SearchableUserSelect
            users={appUsers}
            value={placeUserId}
            onChange={setPlaceUserId}
            getOptionLabel={(u) => u.email}
            className="min-w-[200px]"
          />
          <input
            className="min-w-[200px] rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm uppercase"
            value={symbol}
            onChange={(ev) => setSymbol(ev.target.value.toUpperCase())}
            placeholder="BTCUSDT · NSE:TCS · CMDTY:GOLD"
          />
          <input
            className="w-28 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            value={quantity}
            onChange={(ev) => setQuantity(ev.target.value)}
            inputMode={quantityRules?.qtyDecimals === 0 ? "numeric" : "decimal"}
          />
        </div>
        {quantityRules ? (
          <p className="text-xs text-[var(--muted)]">
            <span className="uppercase">{quantityRules.venue}</span>
            {quantityRules.qtyUnit === "shares"
              ? " · Whole shares, min "
              : quantityRules.qtyUnit === "lots"
                ? " · Whole lots, min "
                : " · Fractional (crypto), min "}
            {quantityRules.qtyMin}, step {quantityRules.qtyStep}
            {quantityRules.lotDescription ? ` · ${quantityRules.lotDescription}` : ""}
          </p>
        ) : null}

        <div className="space-y-2">
          <span className="text-xs font-semibold uppercase text-[var(--muted)]">Side</span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`flex-1 min-w-[120px] rounded-lg border-2 px-4 py-3 text-sm font-bold transition ${
                side === "buy"
                  ? "border-emerald-500 bg-emerald-500/15 text-emerald-400"
                  : "border-slate-600 bg-slate-900 text-slate-400 hover:border-slate-500"
              }`}
              onClick={() => setSide("buy")}
            >
              Buy
            </button>
            <button
              type="button"
              className={`flex-1 min-w-[120px] rounded-lg border-2 px-4 py-3 text-sm font-bold transition ${
                side === "sell"
                  ? "border-rose-500 bg-rose-500/15 text-rose-400"
                  : "border-slate-600 bg-slate-900 text-slate-400 hover:border-slate-500"
              }`}
              onClick={() => setSide("sell")}
            >
              Sell
            </button>
          </div>
        </div>

        {placeUserId ? (
          <p className="text-sm text-[var(--muted)]">
            Wallet balance:{" "}
            {placeUserBalanceLoading ? (
              <span>…</span>
            ) : placeUserBalance != null ? (
              <span className="font-mono font-semibold text-slate-100">
                {placeUserBalance.toFixed(2)}
              </span>
            ) : (
              <span>unavailable</span>
            )}
            {side === "buy" && buyShortfall != null && buyShortfall > 0 ? (
              <span className="ml-2 text-amber-400">
                · Short {buyShortfall.toFixed(2)} for this buy — add deposit in Wallet panel first
              </span>
            ) : null}
          </p>
        ) : null}

        {quote &&
        quoteSymbol.trim().toUpperCase() === symbol.trim().toUpperCase() &&
        Number(quantity) > 0 ? (
          <p className="text-sm text-[var(--muted)]">
            Estimated notional at last{" "}
            <span className="font-mono font-semibold text-slate-200">{quote.last.toFixed(4)}</span>
            :{" "}
            <span className="font-mono font-semibold text-slate-100">
              ${(quote.last * Number(quantity)).toFixed(2)}
            </span>
          </p>
        ) : (
          <p className="text-xs text-[var(--muted)]">
            Refresh quote above with the same symbol as the trade to see estimated notional.
          </p>
        )}

        <button type="submit" className="w-full rounded-lg bg-[var(--primary)] px-4 py-3 text-sm font-semibold">
          Place {side === "buy" ? "buy" : "sell"} order
        </button>
      </form>

      {loading && !orders.length ? (
        <p className="text-sm text-[var(--muted)]">Loading orders…</p>
      ) : !orders.length ? (
        <p className="text-sm text-[var(--muted)]">No orders in this view.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-700">
          <table className="w-full min-w-[960px] border-collapse text-left text-sm">
            <thead className="border-b border-slate-700 bg-slate-900/80 text-xs uppercase text-[var(--muted)]">
              <tr>
                <th className="px-2 py-2">User</th>
                <th className="px-2 py-2">Symbol</th>
                <th className="px-2 py-2">Venue</th>
                <th className="px-2 py-2">Side</th>
                <th className="px-2 py-2">Qty</th>
                <th className="px-2 py-2">Entry</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">PnL</th>
                <th className="px-2 py-2">Created</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-slate-800/80">
                  <td className="px-2 py-2">
                    <div className="font-medium">{o.user_full_name}</div>
                    <div className="text-xs text-[var(--muted)]">{o.user_email}</div>
                  </td>
                  <td className="px-2 py-2">{o.symbol}</td>
                  <td className="px-2 py-2 text-xs uppercase text-[var(--muted)]">
                    {o.market_venue || "crypto"}
                  </td>
                  <td className="px-2 py-2 uppercase">{o.side}</td>
                  <td className="px-2 py-2">{o.quantity}</td>
                  <td className="px-2 py-2">{o.entry_price}</td>
                  <td className="px-2 py-2">{o.status}</td>
                  <td className="px-2 py-2">{o.pnl}</td>
                  <td className="px-2 py-2 text-xs text-[var(--muted)]">{new Date(o.created_at).toLocaleString()}</td>
                  <td className="px-2 py-2">
                    {o.status === "open" ? (
                      <button
                        type="button"
                        className="rounded bg-[var(--success)] px-2 py-1 text-xs font-medium text-black"
                        onClick={() => void closeOrder(o.id)}
                      >
                        Close
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
