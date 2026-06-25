"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ADMIN_API_BASE_URL } from "@/config";
import { clearAdminToasts, showAdminToast } from "@/lib/adminNotify";
import { showCredentialsShareToast } from "@/lib/credentialsShareToast";
import { createAdminApiFetch } from "@/lib/fetchWithAutoRefresh";
import { AdminAppShell, type AdminShellTab, type TabBadges } from "@/components/AdminAppShell";
import { AdminLoginForm } from "@/components/AdminLoginForm";
import { RequestList } from "@/components/RequestList";
import { AuditList } from "@/components/AuditList";
import { DeadLetterList } from "@/components/DeadLetterList";
import { AdminUsersPanel } from "@/components/AdminUsersPanel";
import { AppUsersList } from "@/components/AppUsersList";
import { OrdersAdminPanel } from "@/components/OrdersAdminPanel";
import { WalletAdminPanel } from "@/components/WalletAdminPanel";
import { AppUserSupportPanel } from "@/components/AppUserSupportPanel";
import { AccessRequest, AdminUser, AppUser, AuditLog, DeadLetter } from "@/components/types";

export default function AdminPage() {
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [appUsers, setAppUsers] = useState<AppUser[]>([]);
  const [loadingAppUsers, setLoadingAppUsers] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminShellTab>("requests");
  const accessTokenRef = useRef("");
  const refreshTokenRef = useRef("");

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);
  useEffect(() => {
    refreshTokenRef.current = refreshToken;
  }, [refreshToken]);

  const setTokenPair = useCallback((next: { accessToken: string; refreshToken: string }) => {
    setAccessToken(next.accessToken);
    setRefreshToken(next.refreshToken);
    accessTokenRef.current = next.accessToken;
    refreshTokenRef.current = next.refreshToken;
  }, []);

  const getTokenPair = useCallback(
    () => ({ accessToken: accessTokenRef.current, refreshToken: refreshTokenRef.current }),
    []
  );

  const adminApiFetch = useMemo(
    () => createAdminApiFetch(ADMIN_API_BASE_URL, getTokenPair, setTokenPair),
    [getTokenPair, setTokenPair]
  );

  async function loadRequests() {
    setLoadingRequests(true);
    try {
      const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/requests`, { headers: {} });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || "Could not load requests.");
      }
      setRequests(payload.requests);
    } catch (error) {
      showAdminToast(error instanceof Error ? error.message : "Failed to load requests.", "error");
    } finally {
      setLoadingRequests(false);
    }
  }

  async function loadAudit() {
    try {
      const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/audit`, { headers: {} });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || "Could not load audit logs.");
      }
      setAuditLogs(payload.logs || []);
    } catch (error) {
      showAdminToast(error instanceof Error ? error.message : "Failed to load audit logs.", "error");
    }
  }

  async function loadDeadLetters() {
    try {
      const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/delivery-dead-letters`, { headers: {} });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Could not load dead letters.");
      setDeadLetters(payload.deadLetters || []);
    } catch (error) {
      showAdminToast(error instanceof Error ? error.message : "Failed to load dead letters.", "error");
    }
  }

  async function loadAdminUsers() {
    try {
      const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/users`, { headers: {} });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Could not load admin users.");
      setAdminUsers(payload.users || []);
    } catch (error) {
      showAdminToast(error instanceof Error ? error.message : "Failed to load admin users.", "error");
    }
  }

  async function loadAppUsers() {
    setLoadingAppUsers(true);
    try {
      const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/app-users`, { headers: {} });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Could not load app users.");
      setAppUsers(payload.users || []);
    } catch (error) {
      showAdminToast(error instanceof Error ? error.message : "Failed to load app users.", "error");
    } finally {
      setLoadingAppUsers(false);
    }
  }

  useEffect(() => {
    if (accessToken) {
      void loadRequests();
      void loadAudit();
      void loadDeadLetters();
      void loadAdminUsers();
      void loadAppUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load* close over stable getTokenPair/setTokenPair
  }, [accessToken]);

  const refreshAll = useCallback(() => {
    if (!accessToken) return;
    void loadRequests();
    void loadAudit();
    void loadDeadLetters();
    void loadAdminUsers();
    void loadAppUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const filteredRequests = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return requests;
    return requests.filter((r) => {
      const blob = [r.full_name, r.email, r.phone, r.organization, r.country, r.status].join(" ").toLowerCase();
      return blob.includes(q);
    });
  }, [requests, searchQuery]);

  const filteredAuditLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return auditLogs;
    return auditLogs.filter((log) => {
      const blob = [log.action, log.actor, log.target_user_email, log.target_request_id].join(" ").toLowerCase();
      return blob.includes(q);
    });
  }, [auditLogs, searchQuery]);

  const filteredDeadLetters = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return deadLetters;
    return deadLetters.filter((row) => {
      const payloadStr = JSON.stringify(row.payload ?? {}).toLowerCase();
      const blob = [row.channel, row.recipient, row.reason, payloadStr].join(" ").toLowerCase();
      return blob.includes(q);
    });
  }, [deadLetters, searchQuery]);

  const filteredAdminUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return adminUsers;
    return adminUsers.filter((u) => {
      const blob = [u.full_name, u.email, u.role, u.is_active ? "active" : "inactive"].join(" ").toLowerCase();
      return blob.includes(q);
    });
  }, [adminUsers, searchQuery]);

  const filteredAppUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return appUsers;
    return appUsers.filter((u) => {
      const blob = [u.full_name, u.email, u.phone, u.id].join(" ").toLowerCase();
      return blob.includes(q);
    });
  }, [appUsers, searchQuery]);

  const tabBadges: TabBadges = useMemo(
    () => ({
      requests: requests.filter((r) => r.status === "pending").length,
      "dead-letters": deadLetters.length,
    }),
    [requests, deadLetters]
  );

  function navigateTab(tab: AdminShellTab) {
    setActiveTab(tab);
    setSearchQuery("");
  }

  async function verifyRequest(requestId: string) {
    if (!accessToken) return;
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/requests/${requestId}/verify`, {
      method: "POST",
      headers: {},
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Verification failed."), "error");
      return;
    }
    const email = String(payload.credentials?.email ?? "");
    const pwd = String(payload.credentials?.password ?? "");
    showCredentialsShareToast({
      title: "Access request approved",
      email,
      password: pwd,
      note: "Share via a secure channel. User must enter this exact temporary password when changing it in the app.",
    });
    await loadRequests();
    await loadAudit();
    await loadDeadLetters();
    await loadAdminUsers();
    await loadAppUsers();
  }

  async function rejectRequest(requestId: string) {
    if (!accessToken) return;
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/requests/${requestId}/reject`, {
      method: "POST",
      headers: {},
    });
    const payload = await response.json();
    if (!response.ok) {
      showAdminToast(String(payload.message || "Reject failed."), "error");
      return;
    }
    showAdminToast("Request rejected.", "success");
    await loadRequests();
    await loadAudit();
    await loadDeadLetters();
    await loadAdminUsers();
    await loadAppUsers();
  }

  async function createAdminUser(payload: {
    fullName: string;
    email: string;
    password: string;
    role: "admin" | "super_admin";
  }) {
    if (!accessToken) return;
    clearAdminToasts();
    const response = await adminApiFetch(`${ADMIN_API_BASE_URL}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      showAdminToast(String(data.message || "Could not create admin user."), "error");
      return;
    }
    showAdminToast(`Admin created: ${String(data.user?.email ?? "")}`, "success");
    await loadAdminUsers();
    await loadAudit();
  }

  async function handleLogout() {
    if (refreshToken) {
      await fetch(`${ADMIN_API_BASE_URL}/api/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    }
    accessTokenRef.current = "";
    refreshTokenRef.current = "";
    setAccessToken("");
    setRefreshToken("");
    setAdminEmail("");
    setSearchQuery("");
    setRequests([]);
    setAuditLogs([]);
    setDeadLetters([]);
    setAdminUsers([]);
    setAppUsers([]);
    clearAdminToasts();
    showAdminToast("Signed out.", "info");
  }

  if (!accessToken) {
    return (
      <div className="min-h-screen bg-[var(--content-bg)]">
        <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 text-xl font-bold text-white shadow-lg shadow-indigo-900/50">
              GC
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">GrowthCapital operations</h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Run onboarding, treasury, trading oversight, and customer support from one place. Staff sign-in only.
            </p>
          </div>
          <AdminLoginForm
            onLoggedIn={({ accessToken: nextAccess, refreshToken: nextRefresh, email }) => {
              accessTokenRef.current = nextAccess;
              refreshTokenRef.current = nextRefresh;
              setAccessToken(nextAccess);
              setRefreshToken(nextRefresh);
              setAdminEmail(email);
              showAdminToast(`Signed in as ${email}`, "success");
            }}
          />
        </main>
      </div>
    );
  }

  return (
    <AdminAppShell
      activeTab={activeTab}
      onNavigate={navigateTab}
      badges={tabBadges}
      adminEmail={adminEmail}
      onLogout={handleLogout}
      onRefresh={refreshAll}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
    >
      {activeTab === "requests" ? (
        <RequestList
          requests={filteredRequests}
          loading={loadingRequests}
          totalBeforeFilter={requests.length}
          onVerify={(id) => void verifyRequest(id)}
          onReject={(id) => void rejectRequest(id)}
        />
      ) : activeTab === "audit" ? (
        <AuditList logs={filteredAuditLogs} totalBeforeFilter={auditLogs.length} />
      ) : activeTab === "dead-letters" ? (
        <DeadLetterList rows={filteredDeadLetters} totalBeforeFilter={deadLetters.length} />
      ) : activeTab === "admin-users" ? (
        <AdminUsersPanel users={filteredAdminUsers} totalBeforeFilter={adminUsers.length} onCreate={createAdminUser} />
      ) : activeTab === "app-users" ? (
        <AppUsersList
          users={filteredAppUsers}
          loading={loadingAppUsers}
          adminApiFetch={adminApiFetch}
          totalBeforeFilter={appUsers.length}
        />
      ) : activeTab === "orders" ? (
        <OrdersAdminPanel adminApiFetch={adminApiFetch} appUsers={filteredAppUsers} />
      ) : activeTab === "wallet" ? (
        <WalletAdminPanel adminApiFetch={adminApiFetch} appUsers={filteredAppUsers} />
      ) : activeTab === "app-support" ? (
        <AppUserSupportPanel adminApiFetch={adminApiFetch} appUsers={filteredAppUsers} />
      ) : null}
    </AdminAppShell>
  );
}
