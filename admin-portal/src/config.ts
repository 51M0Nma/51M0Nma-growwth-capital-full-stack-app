/** API origin for admin portal — always from env at build time (Next inlines NEXT_PUBLIC_*). */
export const ADMIN_API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5001"
).replace(/\/$/, "");
