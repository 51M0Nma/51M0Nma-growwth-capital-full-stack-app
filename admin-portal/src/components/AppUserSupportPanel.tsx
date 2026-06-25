"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminApiFetch } from "@/lib/fetchWithAutoRefresh";
import { ADMIN_API_BASE_URL } from "@/config";
import { clearAdminToasts, showAdminToast } from "@/lib/adminNotify";
import { SearchableUserSelect } from "./SearchableUserSelect";
import {
  AppUser,
  NotificationItem,
  ReferralPayload,
  UserSettingsLanguage,
  UserSettingsRow,
} from "./types";

const SUPPORTED_LANGUAGES: ReadonlyArray<{ code: UserSettingsLanguage; label: string }> = [
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
];

function normalizeLanguage(value: unknown): UserSettingsLanguage {
  return value === "hi" ? "hi" : "en";
}

function normalizeSettings(row: UserSettingsRow | null): UserSettingsRow | null {
  if (!row) return null;
  return { ...row, language: normalizeLanguage(row.language) };
}

type Props = {
  adminApiFetch: AdminApiFetch;
  appUsers: AppUser[];
};

type SubTab = "notifications" | "settings" | "referrals";

export function AppUserSupportPanel({ adminApiFetch, appUsers }: Props) {
  const [userId, setUserId] = useState("");
  const [subTab, setSubTab] = useState<SubTab>("notifications");
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [settings, setSettings] = useState<UserSettingsRow | null>(null);
  const [referral, setReferral] = useState<ReferralPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [simReward, setSimReward] = useState("12.5");

  const loadNotifications = useCallback(async () => {
    if (!userId) return;
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users/${userId}/notifications`, {
      headers: {},
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "Could not load notifications.");
    setNotifications(payload.notifications || []);
  }, [adminApiFetch, userId]);

  const loadSettings = useCallback(async () => {
    if (!userId) return;
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users/${userId}/settings`, {
      headers: {},
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "Could not load settings.");
    setSettings(normalizeSettings(payload.settings || null));
  }, [adminApiFetch, userId]);

  const loadReferral = useCallback(async () => {
    if (!userId) return;
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users/${userId}/referrals`, {
      headers: {},
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "Could not load referrals.");
    setReferral(payload.referral || null);
  }, [adminApiFetch, userId]);

  useEffect(() => {
    if (!userId) {
      setNotifications([]);
      setSettings(null);
      setReferral(null);
      return;
    }
    setLoading(true);
    clearAdminToasts();
    const run = async () => {
      try {
        if (subTab === "notifications") await Promise.all([loadNotifications(), loadSettings()]);
        else if (subTab === "settings") await loadSettings();
        else await loadReferral();
      } catch (e) {
        showAdminToast(e instanceof Error ? e.message : "Load failed.", "error");
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [userId, subTab, loadNotifications, loadSettings, loadReferral]);

  async function markRead(notifId: string) {
    if (!userId) return;
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users/${userId}/notifications/${notifId}/read`, {
      method: "POST",
      headers: {},
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Mark read failed."), "error");
      return;
    }
    await loadNotifications();
  }

  async function sendNotification(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || !newTitle.trim() || !newBody.trim()) return;
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users/${userId}/notifications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: newTitle.trim(), body: newBody.trim() }),
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Could not send notification."), "error");
      return;
    }
    setNewTitle("");
    setNewBody("");
    showAdminToast("Notification created for user.", "success");
    await loadNotifications();
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || !settings) return;
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users/${userId}/settings`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Save failed."), "error");
      return;
    }
    setSettings(normalizeSettings(payload.settings));
    showAdminToast("Settings saved for user.", "success");
  }

  async function simulateReferral() {
    if (!userId) return;
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users/${userId}/referrals/simulate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reward: Number(simReward) }),
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Simulate failed."), "error");
      return;
    }
    setReferral(payload.referral);
    showAdminToast("Referral reward simulated for user.", "success");
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--muted)]">
        Customer operations: push in-app messages, adjust saved preferences, or adjust referral test data. This is
        for support and compliance workflows, not a copy of the mobile UI.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Customer</span>
          <SearchableUserSelect users={appUsers} value={userId} onChange={setUserId} />
        </label>
      </div>

      {!userId ? (
        <p className="text-sm text-[var(--muted)]">Select a customer to work with notifications, preferences, or referrals.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {(["notifications", "settings", "referrals"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={`rounded-lg px-3 py-1 text-sm capitalize ${
                  subTab === key ? "bg-[var(--primary)]" : "border border-slate-600"
                }`}
                onClick={() => setSubTab(key)}
              >
                {key}
              </button>
            ))}
          </div>

          {loading ? (
            <p className="text-sm text-[var(--muted)]">Loading…</p>
          ) : subTab === "notifications" ? (
            <div className="space-y-4">
              {settings && settings.notifications_enabled === false ? (
                <p className="rounded-lg border border-amber-600/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-100">
                  This customer turned off <span className="font-semibold">team messages</span> in the app profile.
                  New admin messages cannot be delivered until they opt back in.
                </p>
              ) : null}
              <form onSubmit={sendNotification} className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 space-y-2">
                <p className="text-sm font-medium">Send notification to device</p>
                <input
                  className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
                  placeholder="Title"
                  value={newTitle}
                  onChange={(ev) => setNewTitle(ev.target.value)}
                  disabled={settings ? settings.notifications_enabled === false : false}
                />
                <textarea
                  className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
                  placeholder="Body"
                  rows={3}
                  value={newBody}
                  onChange={(ev) => setNewBody(ev.target.value)}
                  disabled={settings ? settings.notifications_enabled === false : false}
                />
                <button
                  type="submit"
                  disabled={settings ? settings.notifications_enabled === false : false}
                  className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Send
                </button>
              </form>
              <div className="space-y-2">
                {notifications.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No notifications.</p>
                ) : (
                  notifications.map((n) => (
                    <div
                      key={n.id}
                      className={`rounded-lg border p-3 text-sm ${
                        n.is_read ? "border-slate-700 bg-slate-900/30" : "border-indigo-500/40 bg-indigo-950/20"
                      }`}
                    >
                      <p className="font-semibold">{n.title}</p>
                      <p className="text-[var(--muted)]">{n.body}</p>
                      <p className="mt-1 text-xs text-[var(--muted)]">{new Date(n.created_at).toLocaleString()}</p>
                      {!n.is_read ? (
                        <button
                          type="button"
                          className="mt-2 rounded bg-slate-700 px-2 py-1 text-xs"
                          onClick={() => void markRead(n.id)}
                        >
                          Mark read
                        </button>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : subTab === "settings" ? (
            settings ? (
              <form onSubmit={saveSettings} className="max-w-md space-y-3 rounded-xl border border-slate-700 bg-slate-900/40 p-4">
                <p className="text-sm text-[var(--muted)]">Theme</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={`rounded-lg px-3 py-1 text-sm ${settings.theme === "dark" ? "bg-[var(--primary)]" : "border border-slate-600"}`}
                    onClick={() => setSettings({ ...settings, theme: "dark" })}
                  >
                    Dark
                  </button>
                  <button
                    type="button"
                    className={`rounded-lg px-3 py-1 text-sm ${settings.theme === "light" ? "bg-[var(--primary)]" : "border border-slate-600"}`}
                    onClick={() => setSettings({ ...settings, theme: "light" })}
                  >
                    Light
                  </button>
                </div>
                <div className="text-sm">
                  <span className="text-[var(--muted)]">Language</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {SUPPORTED_LANGUAGES.map((option) => {
                      const selected = settings.language === option.code;
                      return (
                        <button
                          key={option.code}
                          type="button"
                          aria-pressed={selected}
                          className={`rounded-lg px-3 py-1 text-sm ${selected ? "bg-[var(--primary)]" : "border border-slate-600"}`}
                          onClick={() => setSettings({ ...settings, language: option.code })}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={`rounded-lg px-3 py-1 text-sm ${settings.price_alerts ? "bg-[var(--primary)]" : "border border-slate-600"}`}
                    onClick={() => setSettings({ ...settings, price_alerts: !settings.price_alerts })}
                  >
                    Price alerts
                  </button>
                  <button
                    type="button"
                    className={`rounded-lg px-3 py-1 text-sm ${settings.order_alerts ? "bg-[var(--primary)]" : "border border-slate-600"}`}
                    onClick={() => setSettings({ ...settings, order_alerts: !settings.order_alerts })}
                  >
                    Order alerts
                  </button>
                  <button
                    type="button"
                    className={`rounded-lg px-3 py-1 text-sm ${settings.notifications_enabled !== false ? "bg-[var(--primary)]" : "border border-slate-600"}`}
                    onClick={() =>
                      setSettings({
                        ...settings,
                        notifications_enabled: !(settings.notifications_enabled !== false),
                      })
                    }
                  >
                    Team messages
                  </button>
                </div>
                <button type="submit" className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium">
                  Save settings
                </button>
              </form>
            ) : (
              <p className="text-sm text-[var(--muted)]">No settings row.</p>
            )
          ) : (
            <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-900/40 p-4">
              {referral ? (
                <>
                  <p className="text-sm">
                    Code: <span className="font-mono font-semibold">{referral.referral_code}</span>
                  </p>
                  <p className="text-sm">Referred users: {referral.referred_count}</p>
                  <p className="text-sm">Reward total: {Number(referral.reward_total).toFixed(2)}</p>
                </>
              ) : (
                <p className="text-sm text-[var(--muted)]">No referral row.</p>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm">
                  <span className="text-[var(--muted)]">Reward amount</span>
                  <input
                    className="ml-2 w-24 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm"
                    value={simReward}
                    onChange={(ev) => setSimReward(ev.target.value)}
                    inputMode="decimal"
                  />
                </label>
                <button
                  type="button"
                  className="rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-medium"
                  onClick={() => void simulateReferral()}
                >
                  Simulate referral reward
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
