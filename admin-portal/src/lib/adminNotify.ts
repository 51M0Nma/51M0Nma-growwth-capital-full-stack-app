"use client";

import { toast } from "sonner";

export type AdminToastVariant = "success" | "error" | "info";

/** Empty message dismisses all toasts (replaces prior “clear banner” behaviour). */
export function showAdminToast(message: string, variant: AdminToastVariant = "info") {
  const t = message.trim();
  if (!t) {
    toast.dismiss();
    return;
  }
  const duration = variant === "error" ? 10_000 : variant === "success" ? 12_000 : 6000;
  if (variant === "error") toast.error(t, { duration });
  else if (variant === "success") toast.success(t, { duration });
  else toast.message(t, { duration });
}

export function showAdminToastWithDescription(
  variant: "success" | "error",
  title: string,
  description: string,
  duration = 22_000
) {
  const tt = title.trim();
  const dd = description.trim();
  if (!tt && !dd) {
    toast.dismiss();
    return;
  }
  if (variant === "error") toast.error(tt || "Error", { description: dd || undefined, duration });
  else toast.success(tt || "Done", { description: dd || undefined, duration });
}

export function clearAdminToasts() {
  toast.dismiss();
}
