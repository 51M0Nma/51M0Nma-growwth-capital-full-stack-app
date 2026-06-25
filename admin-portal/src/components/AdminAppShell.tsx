"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export type AdminShellTab =
  | "requests"
  | "audit"
  | "dead-letters"
  | "admin-users"
  | "app-users"
  | "orders"
  | "wallet"
  | "app-support";

const TAB_CRUMBS: Record<AdminShellTab, { section: string; page: string }> = {
  requests: { section: "Onboarding", page: "Access queue" },
  "app-users": { section: "Customers", page: "Directory" },
  "app-support": { section: "Customers", page: "Messages & preferences" },
  wallet: { section: "Treasury", page: "Wallet & movements" },
  orders: { section: "Treasury", page: "Trades" },
  "admin-users": { section: "Platform", page: "Staff accounts" },
  audit: { section: "Platform", page: "Audit log" },
  "dead-letters": { section: "Platform", page: "Delivery failures" },
};

const SEARCHABLE_TABS = new Set<AdminShellTab>([
  "requests",
  "app-users",
  "audit",
  "dead-letters",
  "admin-users",
]);

type NavItem = {
  id: AdminShellTab;
  label: string;
  badgeKey?: AdminShellTab;
};

const SIDEBAR_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Onboarding",
    items: [{ id: "requests", label: "Access queue", badgeKey: "requests" }],
  },
  {
    title: "Customers",
    items: [
      { id: "app-users", label: "Directory" },
      { id: "app-support", label: "Messages & preferences" },
    ],
  },
  {
    title: "Treasury & trades",
    items: [
      { id: "wallet", label: "Wallet & movements" },
      { id: "orders", label: "Trades" },
    ],
  },
  {
    title: "Platform",
    items: [
      { id: "admin-users", label: "Staff accounts" },
      { id: "audit", label: "Audit log" },
      { id: "dead-letters", label: "Delivery failures", badgeKey: "dead-letters" },
    ],
  },
];

function IconInbox({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function IconUsers({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconMessage({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconWallet({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </svg>
  );
}

function IconChart({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 3v18h18" />
      <path d="m19 9-5 5-4-4-3 3" />
    </svg>
  );
}

function IconShield({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function IconScroll({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  );
}

function IconAlert({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function IconMenu({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function IconSearch({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function IconRefresh({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function IconChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

const TAB_ICONS: Record<AdminShellTab, ReactNode> = {
  requests: <IconInbox className="shrink-0 opacity-80" />,
  "app-users": <IconUsers className="shrink-0 opacity-80" />,
  "app-support": <IconMessage className="shrink-0 opacity-80" />,
  wallet: <IconWallet className="shrink-0 opacity-80" />,
  orders: <IconChart className="shrink-0 opacity-80" />,
  "admin-users": <IconShield className="shrink-0 opacity-80" />,
  audit: <IconScroll className="shrink-0 opacity-80" />,
  "dead-letters": <IconAlert className="shrink-0 opacity-80" />,
};

export type TabBadges = Partial<Record<AdminShellTab, number>>;

type Props = {
  activeTab: AdminShellTab;
  onNavigate: (tab: AdminShellTab) => void;
  badges: TabBadges;
  adminEmail: string;
  onLogout: () => void;
  onRefresh: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  children: React.ReactNode;
  banner?: React.ReactNode;
};

export function AdminAppShell({
  activeTab,
  onNavigate,
  badges,
  adminEmail,
  onLogout,
  onRefresh,
  searchQuery,
  onSearchChange,
  children,
  banner,
}: Props) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [activeTab]);

  const crumbs = TAB_CRUMBS[activeTab];
  const searchEnabled = SEARCHABLE_TABS.has(activeTab);
  const workspaceLabel = process.env.NEXT_PUBLIC_OPS_WORKSPACE_LABEL || "Default workspace";

  function badgeForItem(item: NavItem): number | undefined {
    const key = item.badgeKey ?? item.id;
    const v = badges[key];
    return v !== undefined && v > 0 ? v : undefined;
  }

  const sidebarInner = (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-800/80 px-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600/90 text-sm font-bold text-white shadow-lg shadow-indigo-900/40">
          GC
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight text-white">GrowthCapital</p>
          <p className="truncate text-[10px] font-medium uppercase tracking-wider text-slate-500">Operations</p>
        </div>
      </div>

      <div className="border-b border-slate-800/80 px-3 py-3">
        <label className="sr-only" htmlFor="workspace-select">
          Workspace
        </label>
        <select
          id="workspace-select"
          className="w-full rounded-lg border border-slate-700 bg-slate-900/80 px-2.5 py-2 text-xs font-medium text-slate-200 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          defaultValue="default"
        >
          <option value="default">{workspaceLabel}</option>
        </select>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-4" aria-label="Operations sections">
        {SIDEBAR_GROUPS.map((group) => (
          <div key={group.title} className="mb-6 last:mb-0">
            <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-slate-500">{group.title}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = activeTab === item.id;
                const b = badgeForItem(item);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onNavigate(item.id)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        active
                          ? "bg-indigo-600/25 font-medium text-white ring-1 ring-indigo-500/40"
                          : "text-slate-300 hover:bg-slate-800/70 hover:text-white"
                      }`}
                    >
                      {TAB_ICONS[item.id]}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {b !== undefined ? (
                        <span className="shrink-0 rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-200">
                          {b}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-slate-800/80 p-3">
        <p className="px-2 text-[10px] leading-relaxed text-slate-500">Staff console — not the customer trading app.</p>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen">
      {/* Mobile overlay */}
      {mobileNavOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          aria-label="Close menu"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}

      {/* Sidebar */}
      <aside
        id="ops-sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col border-r border-slate-800 bg-[var(--sidebar)] transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileNavOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        {sidebarInner}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:ml-0">
        <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[var(--header-bg)]/95 backdrop-blur-md">
          <div className="flex h-14 items-center gap-3 px-3 sm:px-4 lg:px-6">
            <button
              type="button"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/50 text-slate-200 lg:hidden"
              onClick={() => setMobileNavOpen((o) => !o)}
              aria-expanded={mobileNavOpen}
              aria-controls="ops-sidebar"
            >
              <IconMenu />
            </button>

            <nav className="hidden min-w-0 items-center gap-2 text-sm sm:flex" aria-label="Breadcrumb">
              <span className="shrink-0 font-medium text-slate-400">Operations</span>
              <span className="text-slate-600" aria-hidden>
                /
              </span>
              <span className="shrink-0 truncate text-slate-400">{crumbs.section}</span>
              <span className="text-slate-600" aria-hidden>
                /
              </span>
              <span className="min-w-0 truncate font-medium text-white">{crumbs.page}</span>
            </nav>

            <div className="flex-1" />

            <div
              className={`hidden max-w-md flex-1 items-center gap-2 rounded-xl border px-3 py-1.5 md:flex ${
                searchEnabled ? "border-slate-600 bg-slate-900/50" : "border-slate-800 bg-slate-900/30 opacity-60"
              }`}
              title={searchEnabled ? undefined : "Open a list view (queue, directory, audit, delivery, staff) to filter rows."}
            >
              <IconSearch className="shrink-0 text-slate-500" />
              <input
                className="min-w-0 flex-1 border-0 bg-transparent py-1 text-sm text-white outline-none placeholder:text-slate-500"
                placeholder={searchEnabled ? "Filter this list…" : "Search available in list views"}
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                disabled={!searchEnabled}
                aria-label="Filter list"
              />
            </div>

            <button
              type="button"
              onClick={() => void onRefresh()}
              className="flex h-10 items-center gap-2 rounded-lg border border-slate-600 bg-slate-900/40 px-3 text-sm text-slate-200 hover:bg-slate-800/80"
              title="Reload data"
            >
              <IconRefresh className="shrink-0" />
              <span className="hidden sm:inline">Refresh</span>
            </button>

            <div className="relative" ref={userMenuRef}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setUserMenuOpen((o) => !o);
                }}
                className="flex h-10 max-w-[200px] items-center gap-2 rounded-lg border border-slate-600 bg-slate-900/40 px-2.5 text-left text-sm hover:bg-slate-800/80"
                aria-expanded={userMenuOpen}
                aria-haspopup="menu"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-xs font-bold text-white">
                  {adminEmail ? adminEmail.charAt(0).toUpperCase() : "?"}
                </span>
                <span className="hidden min-w-0 flex-1 truncate text-slate-200 lg:block">{adminEmail || "Staff"}</span>
                <IconChevronDown className={`shrink-0 text-slate-400 transition ${userMenuOpen ? "rotate-180" : ""}`} />
              </button>
              {userMenuOpen ? (
                <div
                  className="absolute right-0 mt-1 w-56 rounded-xl border border-slate-700 bg-[var(--panel)] py-1 shadow-xl shadow-black/40"
                  role="menu"
                >
                  <div className="border-b border-slate-700 px-3 py-2">
                    <p className="text-xs text-slate-500">Signed in as</p>
                    <p className="truncate text-sm font-medium text-white">{adminEmail}</p>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full px-3 py-2.5 text-left text-sm text-red-300 hover:bg-slate-800/80"
                    onClick={() => {
                      setUserMenuOpen(false);
                      void onLogout();
                    }}
                  >
                    Log out
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {/* Mobile search row */}
          <div className="border-t border-slate-800/80 px-3 py-2 md:hidden">
            <div
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${
                searchEnabled ? "border-slate-600 bg-slate-900/50" : "border-slate-800 bg-slate-900/30 opacity-60"
              }`}
            >
              <IconSearch className="shrink-0 text-slate-500" />
              <input
                className="min-w-0 flex-1 border-0 bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
                placeholder={searchEnabled ? "Filter this list…" : "Search in list views"}
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                disabled={!searchEnabled}
              />
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-auto bg-[var(--content-bg)]">
          <div className="mx-auto max-w-[1600px] px-3 py-4 sm:px-4 sm:py-6 lg:px-8">
            <div className="mb-4 sm:hidden">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{crumbs.section}</p>
              <p className="text-lg font-semibold text-white">{crumbs.page}</p>
            </div>

            {banner}

            <section className="rounded-2xl border border-slate-800 bg-[var(--panel)]/90 p-4 shadow-xl shadow-black/20 sm:p-6">{children}</section>
          </div>
        </div>
      </div>
    </div>
  );
}
