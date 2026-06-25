require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
});

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user')),
      password_hash TEXT NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_requests (
      id UUID PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      organization TEXT DEFAULT '',
      country TEXT DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      quantity NUMERIC(18,8) NOT NULL,
      entry_price NUMERIC(18,8) NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      exit_price NUMERIC(18,8),
      pnl NUMERIC(18,8) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal')),
      amount NUMERIC(18,8) NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'rejected')),
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id UUID PRIMARY KEY,
      theme TEXT NOT NULL DEFAULT 'dark',
      language TEXT NOT NULL DEFAULT 'en',
      price_alerts BOOLEAN NOT NULL DEFAULT TRUE,
      order_alerts BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_referrals (
      user_id UUID PRIMARY KEY,
      referral_code TEXT NOT NULL UNIQUE,
      referred_count INT NOT NULL DEFAULT 0,
      reward_total NUMERIC(18,8) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function seedDemo() {
  const demoEmail = process.env.DEMO_USER_EMAIL || "demo.user@growthcapital.local";
  const demoPassword = process.env.DEMO_USER_PASSWORD || "Demo@12345";
  const demoPhone = process.env.DEMO_USER_PHONE || "+919999999999";
  const demoName = process.env.DEMO_USER_NAME || "Demo Trader";
  const demoOrg = process.env.DEMO_USER_ORG || "GrowthCapital Demo";

  const existing = await pool.query("SELECT * FROM users WHERE email = $1 LIMIT 1", [demoEmail]);
  let user = existing.rows[0];
  if (!user) {
    const id = randomUUID();
    const hash = await bcrypt.hash(demoPassword, 10);
    const inserted = await pool.query(
      `INSERT INTO users (id, full_name, email, phone, role, password_hash, must_change_password)
       VALUES ($1,$2,$3,$4,'user',$5,false) RETURNING *`,
      [id, demoName, demoEmail, demoPhone, hash]
    );
    user = inserted.rows[0];
    console.log(`Seeded demo user: ${demoEmail} / ${demoPassword}`);
  } else {
    console.log(`Demo user already exists: ${demoEmail}`);
  }

  await pool.query(
    `INSERT INTO user_settings (user_id, theme, language, price_alerts, order_alerts, updated_at)
     VALUES ($1,'dark','en',true,true,NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );
  await pool.query(
    `INSERT INTO user_referrals (user_id, referral_code, referred_count, reward_total, updated_at)
     VALUES ($1,$2,2,25,NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id, `GC${String(user.id).replace(/-/g, "").slice(0, 8).toUpperCase()}`]
  );

  const countTx = await pool.query("SELECT COUNT(*)::int AS c FROM wallet_transactions WHERE user_id = $1", [user.id]);
  if (countTx.rows[0].c === 0) {
    await pool.query(
      `INSERT INTO wallet_transactions (id, user_id, type, amount, status, note)
       VALUES
       ($1,$2,'deposit',1000,'completed','Seed deposit'),
       ($3,$2,'withdrawal',100,'completed','Seed withdrawal')`,
      [randomUUID(), user.id, randomUUID()]
    );
  }

  const countTrades = await pool.query("SELECT COUNT(*)::int AS c FROM trades WHERE user_id = $1", [user.id]);
  if (countTrades.rows[0].c === 0) {
    await pool.query(
      `INSERT INTO trades (id, user_id, symbol, side, quantity, entry_price, status, exit_price, pnl, created_at, closed_at)
       VALUES
       ($1,$2,'BTCUSDT','buy',0.01,65000,'closed',66000,10,NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),
       ($3,$2,'ETHUSDT','sell',0.2,3100,'open',NULL,0,NOW() - INTERVAL '1 day',NULL)`,
      [randomUUID(), user.id, randomUUID()]
    );
  }

  const countNotifs = await pool.query("SELECT COUNT(*)::int AS c FROM user_notifications WHERE user_id = $1", [user.id]);
  if (countNotifs.rows[0].c === 0) {
    await pool.query(
      `INSERT INTO user_notifications (id, user_id, title, body)
       VALUES
       ($1,$2,'Welcome to Demo Mode','Your demo data is ready.'),
       ($3,$2,'Referral Reward','You have earned demo referral rewards.')`,
      [randomUUID(), user.id, randomUUID()]
    );
  }

  await pool.query(
    `INSERT INTO access_requests (id, full_name, email, phone, organization, country, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')
     ON CONFLICT (email) DO NOTHING`,
    [randomUUID(), "Pending Request User", "pending.user@growthcapital.local", "+918888888888", demoOrg, "IN"]
  );
}

async function run() {
  try {
    await createTables();
    await seedDemo();
    console.log("Seed complete.");
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
