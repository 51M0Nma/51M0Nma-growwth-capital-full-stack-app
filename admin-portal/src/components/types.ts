export type AccessRequest = {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  organization: string;
  country: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
};

export type AuditLog = {
  id: string;
  action: string;
  actor: string;
  target_request_id: string;
  target_user_email: string;
  created_at: string;
};

export type DeadLetter = {
  id: string;
  channel: string;
  recipient: string;
  payload: Record<string, unknown>;
  reason: string;
  attempts: number;
  created_at: string;
};

export type AdminUser = {
  id: string;
  full_name: string;
  email: string;
  role: "super_admin" | "admin";
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** GrowthCapital mobile app end-users (from `users` table). */
export type AppUser = {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  must_change_password: boolean;
  created_at: string;
};

export type TradeSummary = {
  open_count: string;
  closed_count: string;
  total_pnl: string;
};

export type AdminOrderRow = {
  id: string;
  user_id: string;
  user_email: string;
  user_full_name: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
  entry_price: string;
  status: "open" | "closed";
  exit_price: string | null;
  pnl: string;
  created_at: string;
  closed_at: string | null;
  market_venue?: string;
};

export type AdminWalletTransactionRow = {
  id: string;
  user_id: string;
  user_email: string;
  user_full_name: string;
  type: "deposit" | "withdrawal";
  amount: string;
  status: "pending" | "completed" | "rejected";
  note: string;
  created_at: string;
  intent_payment_id?: string | null;
  payout_upi?: string | null;
  payout_account_name?: string | null;
  payment_intent_pool_id?: string | null;
};

export type DepositPaymentIntent = {
  id: string;
  intent_payment_id: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  last_assigned_at: string | null;
  created_at: string;
};

/** Mirrors GrowthCapital `NotificationItem`. */
export type NotificationItem = {
  id: string;
  title: string;
  body: string;
  is_read: boolean;
  created_at: string;
};

export type UserSettingsLanguage = "en" | "hi";

/** Mirrors GrowthCapital `SettingsPayload` / API `user_settings` row. */
export type UserSettingsRow = {
  user_id: string;
  theme: "dark" | "light";
  language: UserSettingsLanguage;
  price_alerts: boolean;
  order_alerts: boolean;
  notifications_enabled: boolean;
  updated_at: string;
};

/** Mirrors GrowthCapital `ReferralPayload`. */
export type ReferralPayload = {
  user_id: string;
  referral_code: string;
  referred_count: number;
  reward_total: string;
  updated_at: string;
};

export type Instrument = {
  symbol: string;
  name: string;
  type: string;
};

export type Candle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
