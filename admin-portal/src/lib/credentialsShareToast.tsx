"use client";

import { toast } from "sonner";
import { showAdminToast } from "./adminNotify";

async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

async function copyWithFeedback(label: string, text: string) {
  const ok = await copyText(text);
  if (ok) showAdminToast(`${label} copied to clipboard.`, "success");
  else showAdminToast("Could not copy to clipboard.", "error");
}

/** Toast with one-click copy for sharing generated credentials. */
export function showCredentialsShareToast(opts: {
  title: string;
  email: string;
  password: string;
  note?: string;
}) {
  const { title, email, password, note } = opts;
  const allText = `Email: ${email}\nTemporary password: ${password}`;

  toast.custom(
    (t) => (
      <div className="w-full max-w-md rounded-lg border border-emerald-800/50 bg-slate-900 p-4 text-slate-100 shadow-lg">
        <p className="font-medium text-emerald-300">{title}</p>
        <p className="mt-2 text-sm text-slate-300">
          <span className="text-slate-400">Email: </span>
          <span className="font-mono">{email}</span>
        </p>
        <p className="mt-1 text-sm text-slate-300">
          <span className="text-slate-400">Temporary password: </span>
          <span className="font-mono">{password}</span>
        </p>
        {note ? <p className="mt-2 text-xs text-slate-400">{note}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-black hover:bg-emerald-500"
            onClick={() => void copyWithFeedback("Password", password)}
          >
            Copy password
          </button>
          <button
            type="button"
            className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
            onClick={() => void copyWithFeedback("Email", email)}
          >
            Copy email
          </button>
          <button
            type="button"
            className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
            onClick={() => void copyWithFeedback("Credentials", allText)}
          >
            Copy all
          </button>
          <button
            type="button"
            className="ml-auto rounded px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            onClick={() => toast.dismiss(t)}
          >
            Dismiss
          </button>
        </div>
      </div>
    ),
    { duration: 60_000 }
  );
}
