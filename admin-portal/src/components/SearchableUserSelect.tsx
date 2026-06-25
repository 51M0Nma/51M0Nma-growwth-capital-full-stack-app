"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AppUser } from "./types";

function defaultLabel(user: AppUser): string {
  return `${user.full_name} — ${user.email}`;
}

function matchesQuery(user: AppUser, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    user.full_name.toLowerCase().includes(needle) ||
    user.email.toLowerCase().includes(needle) ||
    user.phone.toLowerCase().includes(needle) ||
    user.id.toLowerCase().includes(needle)
  );
}

type Props = {
  users: AppUser[];
  value: string;
  onChange: (userId: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  allowEmpty?: boolean;
  emptyLabel?: string;
  getOptionLabel?: (user: AppUser) => string;
  className?: string;
  id?: string;
  disabled?: boolean;
};

export function SearchableUserSelect({
  users,
  value,
  onChange,
  placeholder = "Select user…",
  searchPlaceholder = "Search by name, email, phone, or ID…",
  allowEmpty = true,
  emptyLabel,
  getOptionLabel = defaultLabel,
  className = "min-w-[260px]",
  id: idProp,
  disabled = false,
}: Props) {
  const reactId = useId();
  const controlId = idProp ?? reactId;
  const listboxId = `${controlId}-listbox`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => users.find((u) => u.id === value) ?? null, [users, value]);

  const filtered = useMemo(() => users.filter((u) => matchesQuery(u, query)), [users, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  function select(userId: string) {
    onChange(userId);
    setOpen(false);
    setQuery("");
  }

  const triggerLabel = selected ? getOptionLabel(selected) : placeholder;
  const clearLabel = emptyLabel ?? placeholder;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        id={controlId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60"
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
      >
        <span className={`truncate ${selected ? "" : "text-[var(--muted)]"}`}>{triggerLabel}</span>
        <span className="shrink-0 text-[var(--muted)]" aria-hidden>
          ▾
        </span>
      </button>

      {open ? (
        <div className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-lg border border-slate-600 bg-slate-900 shadow-lg">
          <div className="border-b border-slate-700 p-2">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              className="w-full rounded-md border border-slate-600 bg-slate-950 px-2.5 py-1.5 text-sm outline-none focus:border-[var(--primary)]"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setOpen(false);
                  setQuery("");
                }
              }}
            />
          </div>
          <ul
            id={listboxId}
            role="listbox"
            aria-labelledby={controlId}
            className="max-h-56 overflow-y-auto py-1"
          >
            {allowEmpty ? (
              <li role="option" aria-selected={!value}>
                <button
                  type="button"
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-800 ${
                    !value ? "bg-slate-800/80 text-[var(--text)]" : "text-[var(--muted)]"
                  }`}
                  onClick={() => select("")}
                >
                  {clearLabel}
                </button>
              </li>
            ) : null}
            {filtered.map((user) => (
              <li key={user.id} role="option" aria-selected={user.id === value}>
                <button
                  type="button"
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-800 ${
                    user.id === value ? "bg-slate-800/80" : ""
                  }`}
                  onClick={() => select(user.id)}
                >
                  {getOptionLabel(user)}
                </button>
              </li>
            ))}
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-[var(--muted)]">No matching customers</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
