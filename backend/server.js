require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const http = require("http");
const { randomUUID, createHash } = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");
const twilio = require("twilio");
const { WebSocketServer, WebSocket } = require("ws");
const { NSE_CATALOG, COMMODITY_CATALOG, COMMODITY_LOT_HINTS } = require("./market-catalogs");

const app = express();
const PORT = process.env.PORT || 5001;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || "replace-me-in-production";
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || "15m";
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || "7");
const RESET_TOKEN_TTL_MINUTES = Number(process.env.RESET_TOKEN_TTL_MINUTES || "20");
const DELIVERY_RETRY_COUNT = Number(process.env.DELIVERY_RETRY_COUNT || "3");
const DEMO_MODE = process.env.DEMO_MODE === "true";
const ROOT_ADMIN_ID = "00000000-0000-0000-0000-000000000001";
const INDIAN_STOCK_API_URL = String(process.env.INDIAN_STOCK_API_URL || "http://65.0.104.9").replace(/\/$/, "");
const INDIAN_STOCK_API_TIMEOUT_MS = Number(process.env.INDIAN_STOCK_API_TIMEOUT_MS || "8000");
const NSE_QUOTE_CACHE_TTL_MS = 30 * 1000;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Please configure PostgreSQL connection.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
});

app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function sanitizeUser(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    mustChangePassword: row.must_change_password,
    createdAt: row.created_at,
  };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizePasswordInput(password) {
  return String(password ?? "").trim();
}

function createRandomPassword() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let base = "";
  for (let i = 0; i < 10; i += 1) {
    base += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${base}A1!`;
}

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set(["/api/change-password", "/api/me", "/api/logout"]);

const LEGACY_SYNTH_BASE = { EURUSD: 1.08, GBPUSD: 1.27, BTCUSD: 61000, XAUUSD: 2320 };

const NSE_QTY_RULES = { qtyMin: 1, qtyStep: 1, qtyDecimals: 0, qtyUnit: "shares" };
const COMMODITY_QTY_RULES = { qtyMin: 1, qtyStep: 1, qtyDecimals: 0, qtyUnit: "lots" };
const NSE_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const NSE_BATCH_SIZE = 20;

function buildCommodityInstruments() {
  return COMMODITY_CATALOG.map((row) => ({
    symbol: `CMDTY:${row.base}`,
    base: row.base,
    quote: "INR",
    name: row.name,
    type: "commodity",
    source: "synthetic",
    last: row.seedLast,
    changePct: row.seedChangePct,
    quoteVolume: row.seedLast * 1e4,
    ...COMMODITY_QTY_RULES,
    lotDescription: COMMODITY_LOT_HINTS[`CMDTY:${row.base}`] || "Futures-style contract; whole lots only (demo).",
  }));
}

const COMMODITY_INSTRUMENTS = buildCommodityInstruments();

const SYNTHETIC_PRICE_BASE = { ...LEGACY_SYNTH_BASE };
for (const row of NSE_CATALOG) SYNTHETIC_PRICE_BASE[`NSE:${row.base}`] = row.seedLast;
for (const row of COMMODITY_INSTRUMENTS) SYNTHETIC_PRICE_BASE[row.symbol] = row.last;

const CRYPTO_QTY_DEFAULTS = {
  qtyMin: 1e-8,
  qtyStep: 0.000001,
  qtyDecimals: 8,
  qtyUnit: "base",
};

let nseLiveCache = { byBase: {}, fetchedAt: 0 };
let nseCatalogCache = { instruments: [], source: "synthetic", fetchedAt: 0 };

function nseSymbolToBase(symbol) {
  const s = String(symbol).toUpperCase();
  return s.startsWith("NSE:") ? s.slice(4) : s;
}

function isNseMarketSymbol(symbol) {
  return String(symbol).toUpperCase().startsWith("NSE:");
}

function isCommodityMarketSymbol(symbol) {
  return String(symbol).toUpperCase().startsWith("CMDTY:");
}

async function fetchIndianStockApi(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INDIAN_STOCK_API_TIMEOUT_MS);
  try {
    const response = await fetch(`${INDIAN_STOCK_API_URL}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Indian stock API HTTP ${response.status}`);
    const data = await response.json();
    if (data.status === "error") throw new Error(data.message || "Indian stock API error");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function mapIndianStockRow(row) {
  if (!row) return null;
  const last = Number(row.last_price) || 0;
  if (last <= 0) return null;
  return {
    last,
    change: Number(row.change) || 0,
    changePct: Number(row.percent_change) || 0,
    volume: Number(row.volume) || 0,
    open: Number(row.open) || null,
    dayHigh: Number(row.day_high) || null,
    dayLow: Number(row.day_low) || null,
    companyName: row.company_name || null,
  };
}

async function fetchIndianNseStockList(bases) {
  if (!bases.length) return {};
  const byBase = {};
  for (let i = 0; i < bases.length; i += NSE_BATCH_SIZE) {
    const chunk = bases.slice(i, i + NSE_BATCH_SIZE);
    const symbols = chunk.join(",");
    try {
      const data = await fetchIndianStockApi(`/stock/list?symbols=${encodeURIComponent(symbols)}&res=num`);
      for (const row of data.stocks || []) {
        if (!row?.symbol) continue;
        const mapped = mapIndianStockRow(row);
        if (mapped) byBase[String(row.symbol).toUpperCase()] = mapped;
      }
    } catch (error) {
      console.warn(`Indian NSE batch quote failed (${chunk.length} symbols):`, error.message);
    }
  }
  return byBase;
}

async function fetchIndianNseSymbolCatalog() {
  const catalogMap = new Map(NSE_CATALOG.map((row) => [row.base, { ...row }]));
  try {
    const data = await fetchIndianStockApi("/symbols");
    for (const row of data.symbols || []) {
      const base = String(row.symbol || "").toUpperCase();
      if (!base) continue;
      if (!catalogMap.has(base)) {
        catalogMap.set(base, {
          base,
          name: String(row.search_term || base).replace(/\b\w/g, (c) => c.toUpperCase()),
          seedLast: 100,
          seedChangePct: 0,
        });
      }
    }
  } catch (error) {
    console.warn("Indian NSE /symbols fetch failed:", error.message);
  }
  return [...catalogMap.values()];
}

function buildNseInstrument(catalogRow, live) {
  const base = catalogRow.base;
  const sym = `NSE:${base}`;
  const hasLive = live?.last > 0;
  const last = hasLive ? live.last : catalogRow.seedLast;
  const changePct = hasLive ? live.changePct : catalogRow.seedChangePct;
  const volume = hasLive ? live.volume || 0 : last * 1e6;
  SYNTHETIC_PRICE_BASE[sym] = last;
  return {
    symbol: sym,
    base,
    quote: "INR",
    name: live?.companyName || catalogRow.name || base,
    type: "nse",
    source: hasLive ? "indian-stock-api" : "synthetic",
    last,
    changePct,
    quoteVolume: volume,
    ...NSE_QTY_RULES,
  };
}

function applyNseLivePrices(byBase) {
  for (const [base, live] of Object.entries(byBase)) {
    if (live?.last > 0) SYNTHETIC_PRICE_BASE[`NSE:${base}`] = live.last;
  }
}

async function refreshNseLiveCache(force = false) {
  const now = Date.now();
  if (!force && now - nseLiveCache.fetchedAt < NSE_QUOTE_CACHE_TTL_MS && Object.keys(nseLiveCache.byBase).length) {
    return nseLiveCache.byBase;
  }
  try {
    const catalog = nseCatalogCache.instruments.length
      ? nseCatalogCache.instruments.map((i) => i.base)
      : (await fetchIndianNseSymbolCatalog()).map((i) => i.base);
    const byBase = await fetchIndianNseStockList(catalog);
    nseLiveCache = { byBase, fetchedAt: now };
    applyNseLivePrices(byBase);
    return byBase;
  } catch (error) {
    console.warn("Indian NSE quote fetch failed:", error.message);
    return nseLiveCache.byBase;
  }
}

async function buildNseInstrumentCatalog(force = false) {
  const now = Date.now();
  if (!force && now - nseCatalogCache.fetchedAt < NSE_CATALOG_CACHE_TTL_MS && nseCatalogCache.instruments.length) {
    return nseCatalogCache;
  }
  const catalogRows = await fetchIndianNseSymbolCatalog();
  const bases = catalogRows.map((r) => r.base);
  const byBase = await fetchIndianNseStockList(bases);
  nseLiveCache = { byBase, fetchedAt: now };
  applyNseLivePrices(byBase);

  let liveCount = 0;
  const instruments = catalogRows
    .map((row) => {
      const inst = buildNseInstrument(row, byBase[row.base]);
      if (inst.source === "indian-stock-api") liveCount += 1;
      return inst;
    })
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  const source = liveCount > 0 ? "indian-stock-api" : "synthetic";
  nseCatalogCache = { instruments, source, fetchedAt: now, liveCount, totalCount: instruments.length };
  return nseCatalogCache;
}

async function searchIndianNseStocks(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const data = await fetchIndianStockApi(`/search?q=${encodeURIComponent(q)}`);
  const results = data.results || [];
  const bases = results
    .map((r) => String(r.symbol || "").toUpperCase())
    .filter(Boolean);
  if (!bases.length) return [];
  const byBase = await fetchIndianNseStockList(bases);
  applyNseLivePrices(byBase);
  nseLiveCache.byBase = { ...nseLiveCache.byBase, ...byBase };
  nseLiveCache.fetchedAt = Date.now();
  return results
    .map((r) => {
      const base = String(r.symbol || "").toUpperCase();
      const live = byBase[base];
      const catalogRow = {
        base,
        name: r.company_name || base,
        seedLast: live?.last || 100,
        seedChangePct: live?.changePct || 0,
      };
      const inst = buildNseInstrument(catalogRow, live);
      return inst;
    })
    .filter(Boolean);
}

async function fetchIndianNseQuote(nseSymbol) {
  const sym = String(nseSymbol).toUpperCase();
  const base = nseSymbolToBase(sym);
  const cached = nseLiveCache.byBase[base];
  if (cached?.last > 0 && Date.now() - nseLiveCache.fetchedAt < NSE_QUOTE_CACHE_TTL_MS) {
    return formatIndianNseQuote(sym, cached);
  }
  try {
    const data = await fetchIndianStockApi(`/stock?symbol=${encodeURIComponent(base)}&res=num`);
    const mapped = mapIndianStockRow(data.data);
    if (!mapped) throw new Error("No NSE price data");
    nseLiveCache.byBase[base] = mapped;
    nseLiveCache.fetchedAt = Date.now();
    SYNTHETIC_PRICE_BASE[sym] = mapped.last;
    return formatIndianNseQuote(sym, mapped);
  } catch (_error) {
    if (cached?.last > 0) return formatIndianNseQuote(sym, cached);
    return null;
  }
}

function formatIndianNseQuote(symbol, live) {
  const spread = Math.max(Math.abs(live.change) * 0.01, live.last * 0.0001);
  return {
    symbol,
    bid: live.last - spread,
    ask: live.last + spread,
    last: live.last,
    change: live.change,
    changePct: live.changePct,
    timestamp: Date.now(),
    source: "indian-stock-api",
    open: live.open,
    dayHigh: live.dayHigh,
    dayLow: live.dayLow,
  };
}

async function getNseInstrumentsWithLiveQuotes() {
  const catalog = await buildNseInstrumentCatalog();
  return {
    instruments: catalog.instruments,
    source: catalog.source,
    liveCount: catalog.liveCount ?? 0,
    totalCount: catalog.totalCount ?? catalog.instruments.length,
  };
}

function buildSyntheticQuoteFromCandles(sym) {
  const candles = buildCandles(sym, "1m", 3);
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2] || latest;
  const change = latest.close - previous.close;
  const changePct = previous.close ? (change / previous.close) * 100 : 0;
  return {
    symbol: sym,
    bid: latest.close - Math.abs(change) * 0.02,
    ask: latest.close + Math.abs(change) * 0.02,
    last: latest.close,
    change,
    changePct,
    timestamp: latest.timestamp,
    source: "synthetic",
  };
}

function buildCandles(symbol = "EURUSD", interval = "1m", limit = 50) {
  const points = [];
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 10), 500);
  const upper = String(symbol).toUpperCase();
  let price = SYNTHETIC_PRICE_BASE[upper] ?? 100;
  const now = Date.now();
  const intervalMs = interval === "5m" ? 300000 : interval === "15m" ? 900000 : 60000;
  for (let i = safeLimit - 1; i >= 0; i -= 1) {
    const timestamp = now - i * intervalMs;
    const drift = (Math.random() - 0.48) * (price > 1000 ? 120 : price * 0.0035);
    const open = price;
    const close = Math.max(0.0001, open + drift);
    const high = Math.max(open, close) + Math.abs(drift) * 0.45;
    const low = Math.min(open, close) - Math.abs(drift) * 0.45;
    const volume = Math.round(Math.random() * 900 + 100);
    price = close;
    points.push({ timestamp, open, high, low, close, volume });
  }
  return points;
}

function normalizeMarketSymbol(symbol = "BTCUSDT") {
  const input = String(symbol).toUpperCase().trim();
  const map = {
    BTCUSD: "BTCUSDT",
    ETHUSD: "ETHUSDT",
    BNBUSD: "BNBUSDT",
    SOLUSD: "SOLUSDT",
  };
  return map[input] || input;
}

function parseInterval(interval = "1m") {
  const allowed = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"]);
  return allowed.has(interval) ? interval : "1m";
}

async function fetchBinanceCandles(symbol, interval, limit) {
  const normalized = normalizeMarketSymbol(symbol);
  const safeInterval = parseInterval(interval);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 10), 1000);
  const url = `https://api.binance.com/api/v3/klines?symbol=${normalized}&interval=${safeInterval}&limit=${safeLimit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance candles failed (${response.status})`);
  }
  const data = await response.json();
  return data.map((k) => ({
    timestamp: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

const SYMBOL_NAMES = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  BNB: "Binance Coin",
  SOL: "Solana",
  XRP: "XRP",
  ADA: "Cardano",
  DOGE: "Dogecoin",
  TRX: "TRON",
  TON: "Toncoin",
  MATIC: "Polygon",
  POL: "Polygon",
  DOT: "Polkadot",
  AVAX: "Avalanche",
  LTC: "Litecoin",
  LINK: "Chainlink",
  UNI: "Uniswap",
  ATOM: "Cosmos",
  XLM: "Stellar",
  ETC: "Ethereum Classic",
  BCH: "Bitcoin Cash",
  NEAR: "NEAR Protocol",
  APT: "Aptos",
  ARB: "Arbitrum",
  OP: "Optimism",
  SUI: "Sui",
  PEPE: "Pepe",
  SHIB: "Shiba Inu",
  FIL: "Filecoin",
  ICP: "Internet Computer",
  HBAR: "Hedera",
  INJ: "Injective",
  RNDR: "Render",
  IMX: "Immutable",
  TIA: "Celestia",
  SEI: "Sei",
  ALGO: "Algorand",
  AAVE: "Aave",
  GRT: "The Graph",
  MKR: "Maker",
  LDO: "Lido DAO",
  XMR: "Monero",
  EGLD: "MultiversX",
  SAND: "The Sandbox",
  MANA: "Decentraland",
  AXS: "Axie Infinity",
  FLOW: "Flow",
  CRV: "Curve DAO",
  CHZ: "Chiliz",
  STX: "Stacks",
  EOS: "EOS",
  THETA: "Theta",
  XTZ: "Tezos",
  RUNE: "THORChain",
  KAVA: "Kava",
  ZIL: "Zilliqa",
  ENJ: "Enjin",
  GALA: "Gala",
  WIF: "dogwifhat",
  BONK: "Bonk",
  FET: "Fetch.ai",
  WLD: "Worldcoin",
  JUP: "Jupiter",
  PYTH: "Pyth Network",
  STRK: "Starknet",
  ORDI: "Ordinals",
  JTO: "Jito",
  CFX: "Conflux",
  IOTA: "IOTA",
  KSM: "Kusama",
  COMP: "Compound",
  SNX: "Synthetix",
  RPL: "Rocket Pool",
  MINA: "Mina Protocol",
  GMT: "STEPN",
  LRC: "Loopring",
  ENS: "Ethereum Name Service",
  BLUR: "Blur",
  WLFI: "World Liberty",
  PENDLE: "Pendle",
  DYM: "Dymension",
  ALT: "AltLayer",
  ARKM: "Arkham",
  AI: "Sleepless AI",
  NOT: "Notcoin",
  IO: "io.net",
  ZRO: "LayerZero",
  ETHFI: "ether.fi",
  TAO: "Bittensor",
};

const STABLE_OR_FIAT_BASES = new Set([
  "USDC",
  "FDUSD",
  "TUSD",
  "USDP",
  "USDD",
  "DAI",
  "BUSD",
  "EUR",
  "GBP",
  "AUD",
  "TRY",
  "BRL",
  "RUB",
  "PYUSD",
  "USTC",
  "USTD",
]);

let instrumentsCache = { items: null, fetchedAt: 0 };
const INSTRUMENTS_TTL_MS = 5 * 60 * 1000;

async function fetchBinanceInstruments() {
  const now = Date.now();
  if (instrumentsCache.items && now - instrumentsCache.fetchedAt < INSTRUMENTS_TTL_MS) {
    return instrumentsCache.items;
  }
  const [exchangeRes, tickerRes] = await Promise.all([
    fetch("https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT"),
    fetch("https://api.binance.com/api/v3/ticker/24hr"),
  ]);
  if (!exchangeRes.ok || !tickerRes.ok) {
    throw new Error("Binance instruments failed");
  }
  const [exchange, tickers] = await Promise.all([exchangeRes.json(), tickerRes.json()]);

  const tickerBySymbol = new Map();
  for (const t of tickers) {
    if (!t || !t.symbol) continue;
    tickerBySymbol.set(t.symbol, t);
  }

  const seen = new Set();
  const items = [];
  for (const sym of exchange.symbols || []) {
    if (sym.status !== "TRADING") continue;
    if (sym.quoteAsset !== "USDT") continue;
    const base = sym.baseAsset;
    if (!base) continue;
    if (STABLE_OR_FIAT_BASES.has(base)) continue;
    if (base.endsWith("UP") || base.endsWith("DOWN") || base.endsWith("BULL") || base.endsWith("BEAR")) continue;
    const symbol = sym.symbol;
    if (seen.has(symbol)) continue;
    seen.add(symbol);

    const t = tickerBySymbol.get(symbol);
    const quoteVolume = t ? Number(t.quoteVolume) || 0 : 0;
    const last = t ? Number(t.lastPrice) || 0 : 0;
    const changePct = t ? Number(t.priceChangePercent) || 0 : 0;
    items.push({
      symbol,
      base,
      quote: "USDT",
      name: SYMBOL_NAMES[base] || base,
      type: "crypto",
      source: "binance",
      last,
      changePct,
      quoteVolume,
      ...CRYPTO_QTY_DEFAULTS,
    });
  }
  items.sort((a, b) => b.quoteVolume - a.quoteVolume);
  instrumentsCache = { items, fetchedAt: now };
  return items;
}

async function fetchBinanceQuote(symbol) {
  const normalized = normalizeMarketSymbol(symbol);
  const tickerUrl = `https://api.binance.com/api/v3/ticker/24hr?symbol=${normalized}`;
  const bookUrl = `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${normalized}`;
  const [tickerRes, bookRes] = await Promise.all([fetch(tickerUrl), fetch(bookUrl)]);
  if (!tickerRes.ok || !bookRes.ok) {
    throw new Error("Binance quote failed");
  }
  const [ticker, book] = await Promise.all([tickerRes.json(), bookRes.json()]);
  return {
    symbol: normalized,
    bid: Number(book.bidPrice),
    ask: Number(book.askPrice),
    last: Number(ticker.lastPrice),
    change: Number(ticker.priceChange),
    changePct: Number(ticker.priceChangePercent),
    timestamp: Date.now(),
  };
}

function normalizeMarketVenue(v) {
  const s = String(v || "crypto").toLowerCase();
  if (s === "nse") return "nse";
  if (s === "commodity" || s === "commodities" || s === "mcx") return "commodity";
  return "crypto";
}

function isSyntheticMarketSymbol(symbol) {
  const s = String(symbol).toUpperCase();
  return s.startsWith("NSE:") || s.startsWith("CMDTY:");
}

function inferMarketVenue(symbol) {
  const s = String(symbol).toUpperCase();
  if (s.startsWith("NSE:")) return "nse";
  if (s.startsWith("CMDTY:")) return "commodity";
  return "crypto";
}

function getInstrumentQuantityRules(symbol) {
  const raw = String(symbol || "").trim();
  const s = raw.toUpperCase();
  if (s.startsWith("NSE:")) {
    const base = nseSymbolToBase(s);
    const cached = nseCatalogCache.instruments.find((i) => i.base === base);
    return {
      venue: "nse",
      symbol: cached?.symbol || s,
      ...NSE_QTY_RULES,
      lotDescription: null,
    };
  }
  if (s.startsWith("CMDTY:")) {
    const row = COMMODITY_INSTRUMENTS.find((i) => i.symbol.toUpperCase() === s);
    return {
      venue: "commodity",
      symbol: row?.symbol || s,
      qtyMin: 1,
      qtyStep: 1,
      qtyDecimals: 0,
      qtyUnit: "lots",
      lotDescription: row?.lotDescription || "Whole lots only (demo).",
    };
  }
  const norm = normalizeMarketSymbol(s);
  return {
    venue: "crypto",
    symbol: norm,
    qtyMin: CRYPTO_QTY_DEFAULTS.qtyMin,
    qtyStep: CRYPTO_QTY_DEFAULTS.qtyStep,
    qtyDecimals: CRYPTO_QTY_DEFAULTS.qtyDecimals,
    qtyUnit: "base",
    lotDescription: null,
  };
}

function countDecimalPlaces(n) {
  if (!Number.isFinite(n)) return 0;
  const t = String(n);
  if (/e/i.test(t)) {
    const fixed = n.toFixed(12).replace(/\.?0+$/, "");
    const parts = fixed.split(".");
    return parts[1] ? parts[1].length : 0;
  }
  const parts = t.split(".");
  return parts[1] ? parts[1].length : 0;
}

function validateOrderQuantity(symbol, quantity) {
  const rules = getInstrumentQuantityRules(symbol);
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) {
    return { ok: false, message: "Enter a valid quantity greater than zero.", rules };
  }
  if (q + 1e-15 < rules.qtyMin) {
    return { ok: false, message: `Minimum quantity is ${rules.qtyMin}.`, rules };
  }
  if (rules.venue === "crypto") {
    if (countDecimalPlaces(q) > rules.qtyDecimals) {
      return { ok: false, message: `Use at most ${rules.qtyDecimals} decimal places for this market.`, rules };
    }
    return { ok: true, rules };
  }
  const rounded = Math.round(q);
  if (Math.abs(q - rounded) > 1e-9) {
    const label = rules.qtyUnit === "shares" ? "shares" : "lots";
    return { ok: false, message: `Use whole ${label} only (no decimals).`, rules };
  }
  if (rounded < rules.qtyMin) {
    const unit = rules.qtyUnit === "shares" ? "share" : "lot";
    return { ok: false, message: `Minimum is ${rules.qtyMin} ${unit}.`, rules };
  }
  const steps = (rounded - rules.qtyMin) / rules.qtyStep;
  if (!Number.isInteger(steps)) {
    return { ok: false, message: `Quantity must be ${rules.qtyMin} plus a multiple of ${rules.qtyStep}.`, rules };
  }
  return { ok: true, rules };
}

async function fetchMarketQuote(symbol) {
  const sym = String(symbol).toUpperCase();
  if (isNseMarketSymbol(sym)) {
    const live = await fetchIndianNseQuote(sym);
    if (live) return live;
    return buildSyntheticQuoteFromCandles(sym);
  }
  if (isCommodityMarketSymbol(sym)) {
    return buildSyntheticQuoteFromCandles(sym);
  }
  if (!isSyntheticMarketSymbol(sym)) {
    try {
      const q = await fetchBinanceQuote(sym);
      return { ...q, source: "binance" };
    } catch (_e) {
      /* fall through to synthetic */
    }
  }
  return buildSyntheticQuoteFromCandles(sym);
}

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      adminRole: user.admin_role || null,
      name: user.full_name,
      tokenType: "access",
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

function signRefreshToken(user, sessionId) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      adminRole: user.admin_role || null,
      sessionId,
      tokenType: "refresh",
    },
    JWT_SECRET,
    { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` }
  );
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id UUID PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    CREATE TABLE IF NOT EXISTS admin_audit (
      id UUID PRIMARY KEY,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      target_request_id UUID,
      target_user_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS delivery_dead_letters (
      id UUID PRIMARY KEY,
      channel TEXT NOT NULL,
      recipient TEXT NOT NULL,
      payload JSONB NOT NULL,
      reason TEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    ALTER TABLE trades ADD COLUMN IF NOT EXISTS market_venue TEXT NOT NULL DEFAULT 'crypto'
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
    CREATE TABLE IF NOT EXISTS deposit_payment_intents (
      id UUID PRIMARY KEY,
      intent_payment_id TEXT NOT NULL,
      label TEXT DEFAULT '',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INT NOT NULL DEFAULT 0,
      last_assigned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE wallet_transactions
    ADD COLUMN IF NOT EXISTS intent_payment_id TEXT,
    ADD COLUMN IF NOT EXISTS payout_upi TEXT,
    ADD COLUMN IF NOT EXISTS payout_account_name TEXT,
    ADD COLUMN IF NOT EXISTS payment_intent_pool_id UUID
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE wallet_transactions
      ADD CONSTRAINT wallet_transactions_payment_intent_pool_fk
      FOREIGN KEY (payment_intent_pool_id) REFERENCES deposit_payment_intents(id) ON DELETE SET NULL;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
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
      notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE user_settings
    ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE
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

async function ensureRootAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@growthcapital.local";
  const adminPassword = process.env.ADMIN_PASSWORD || "Admin@123";
  const hash = await bcrypt.hash(adminPassword, 10);
  await pool.query(
    `INSERT INTO admin_users (id, full_name, email, password_hash, role, is_active, updated_at)
     VALUES ($1,$2,$3,$4,'super_admin',true,NOW())
     ON CONFLICT (email) DO UPDATE
     SET full_name = EXCLUDED.full_name,
         password_hash = EXCLUDED.password_hash,
         role = 'super_admin',
         is_active = true,
         updated_at = NOW()`,
    [ROOT_ADMIN_ID, "Root Admin", adminEmail, hash]
  );
}

async function ensureUserDefaults(userId) {
  await pool.query(
    `INSERT INTO user_settings (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  await pool.query(
    `INSERT INTO user_referrals (user_id, referral_code)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, `GC${String(userId).replace(/-/g, "").slice(0, 8).toUpperCase()}`]
  );
}

async function addNotification(userId, title, body) {
  await pool.query(
    `INSERT INTO user_notifications (id, user_id, title, body)
     VALUES ($1,$2,$3,$4)`,
    [randomUUID(), userId, title, body]
  );
}

async function seedDemoData() {
  const demoEmail = process.env.DEMO_USER_EMAIL || "demo.user@growthcapital.local";
  const demoPassword = process.env.DEMO_USER_PASSWORD || "Demo@12345";
  const demoPhone = process.env.DEMO_USER_PHONE || "+919999999999";
  const demoName = process.env.DEMO_USER_NAME || "Demo Trader";
  const demoOrg = process.env.DEMO_USER_ORG || "GrowthCapital Demo";

  let user;
  const existing = await pool.query("SELECT * FROM users WHERE email = $1 LIMIT 1", [demoEmail]);
  if (existing.rowCount) {
    user = existing.rows[0];
  } else {
    const hash = await bcrypt.hash(demoPassword, 10);
    const inserted = await pool.query(
      `INSERT INTO users (id, full_name, email, phone, role, password_hash, must_change_password)
       VALUES ($1,$2,$3,$4,'user',$5,false) RETURNING *`,
      [randomUUID(), demoName, demoEmail, demoPhone, hash]
    );
    user = inserted.rows[0];
    console.log(`Demo user created: ${demoEmail} / ${demoPassword}`);
  }

  await ensureUserDefaults(user.id);

  const txCount = await pool.query("SELECT COUNT(*)::int AS c FROM wallet_transactions WHERE user_id = $1", [user.id]);
  if (txCount.rows[0].c === 0) {
    await pool.query(
      `INSERT INTO wallet_transactions (id, user_id, type, amount, status, note)
       VALUES
       ($1,$2,'deposit',1500,'completed','Demo seed deposit'),
       ($3,$2,'withdrawal',120,'completed','Demo seed withdrawal')`,
      [randomUUID(), user.id, randomUUID()]
    );
  }

  const tradesCount = await pool.query("SELECT COUNT(*)::int AS c FROM trades WHERE user_id = $1", [user.id]);
  if (tradesCount.rows[0].c === 0) {
    await pool.query(
      `INSERT INTO trades (id, user_id, symbol, side, quantity, entry_price, status, exit_price, pnl, created_at, closed_at)
       VALUES
       ($1,$2,'BTCUSDT','buy',0.02,64000,'closed',65500,30,NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),
       ($3,$2,'ETHUSDT','sell',0.3,3200,'open',NULL,0,NOW() - INTERVAL '12 hours',NULL)`,
      [randomUUID(), user.id, randomUUID()]
    );
  }

  const notifCount = await pool.query("SELECT COUNT(*)::int AS c FROM user_notifications WHERE user_id = $1", [user.id]);
  if (notifCount.rows[0].c === 0) {
    await addNotification(user.id, "Demo Ready", "Your demo account has sample data.");
    await addNotification(user.id, "Sample Trade", "A sample open trade has been created.");
  }

  await pool.query(
    `INSERT INTO access_requests (id, full_name, email, phone, organization, country, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')
     ON CONFLICT (email) DO NOTHING`,
    [randomUUID(), "Pending Request User", "pending.user@growthcapital.local", "+918888888888", demoOrg, "IN"]
  );
}

async function sendCredentialsEmail(email, fullName, password) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: "GrowthCapital Account Credentials",
    text: `Hello ${fullName}, your access request is approved.\nEmail: ${email}\nPassword: ${password}\nPlease change password after login.`,
  });
}

async function sendCredentialsSms(phone, email, password) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) return;
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    body: `GrowthCapital approved. Login: ${email} Password: ${password}. Change password after login.`,
    from: process.env.TWILIO_FROM_NUMBER,
    to: phone,
  });
}

async function sendCredentialsTelegram(email, fullName, password) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `Approved user: ${fullName}\nEmail: ${email}\nPassword: ${password}`,
    }),
  });
}

async function sendPasswordResetEmail(email, fullName, resetToken) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const resetUrl = process.env.PASSWORD_RESET_URL || "http://localhost:3000";
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: "GrowthCapital Password Reset",
    text: `Hi ${fullName}, use this reset token within ${RESET_TOKEN_TTL_MINUTES} minutes:\n${resetToken}\nOr open ${resetUrl}?token=${resetToken}`,
  });
}

async function withRetry(channel, recipient, payload, fn) {
  let lastError = null;
  for (let attempt = 1; attempt <= DELIVERY_RETRY_COUNT; attempt += 1) {
    try {
      await fn();
      return { success: true, attempts: attempt };
    } catch (error) {
      lastError = error;
    }
  }
  await pool.query(
    `INSERT INTO delivery_dead_letters (id, channel, recipient, payload, reason, attempts)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
    [
      randomUUID(),
      channel,
      recipient,
      JSON.stringify(payload),
      lastError?.message || "Unknown delivery error",
      DELIVERY_RETRY_COUNT,
    ]
  );
  return { success: false, attempts: DELIVERY_RETRY_COUNT, reason: lastError?.message || "Unknown delivery error" };
}

async function deliverCredentials({ email, fullName, phone, password }) {
  const delivery = { emailSent: false, smsSent: false, telegramSent: false, failures: [] };
  if (process.env.SMTP_HOST) {
    const result = await withRetry(
      "email",
      email,
      { email, fullName },
      () => sendCredentialsEmail(email, fullName, password)
    );
    delivery.emailSent = result.success;
    if (!result.success) delivery.failures.push(`Email: ${result.reason}`);
  }
  if (process.env.TWILIO_ACCOUNT_SID) {
    const result = await withRetry(
      "sms",
      phone,
      { phone, email },
      () => sendCredentialsSms(phone, email, password)
    );
    delivery.smsSent = result.success;
    if (!result.success) delivery.failures.push(`SMS: ${result.reason}`);
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const result = await withRetry(
      "telegram",
      process.env.TELEGRAM_CHAT_ID,
      { email, fullName },
      () => sendCredentialsTelegram(email, fullName, password)
    );
    delivery.telegramSent = result.success;
    if (!result.success) delivery.failures.push(`Telegram: ${result.reason}`);
  }
  return delivery;
}

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Missing token." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tokenType !== "access") return res.status(401).json({ message: "Invalid access token." });
    req.auth = payload;
    if (payload.role === "user" && !PASSWORD_CHANGE_ALLOWED_PATHS.has(req.path)) {
      const userResult = await pool.query(
        "SELECT must_change_password FROM users WHERE id = $1 LIMIT 1",
        [payload.sub]
      );
      if (userResult.rows[0]?.must_change_password) {
        return res.status(403).json({
          message: "Change your temporary password before continuing.",
          code: "PASSWORD_CHANGE_REQUIRED",
          mustChangePassword: true,
        });
      }
    }
    next();
  } catch (_e) {
    return res.status(401).json({ message: "Invalid token." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== "admin") return res.status(403).json({ message: "Admin access required." });
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== "admin" || req.auth.adminRole !== "super_admin") {
    return res.status(403).json({ message: "Super admin access required." });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, db: "postgres" });
});

app.post("/api/access-request", async (req, res) => {
  const { fullName, email, phone, organization, country } = req.body ?? {};
  if (!fullName || !email || !phone) return res.status(400).json({ message: "fullName, email and phone are required." });
  const normalizedEmail = String(email).trim().toLowerCase();
  const existingUser = await pool.query("SELECT id FROM users WHERE email = $1 LIMIT 1", [normalizedEmail]);
  if (existingUser.rowCount) return res.status(409).json({ message: "An account already exists for this email." });
  const existingRequest = await pool.query("SELECT id FROM access_requests WHERE email = $1 AND status = 'pending' LIMIT 1", [normalizedEmail]);
  if (existingRequest.rowCount) return res.status(409).json({ message: "A pending request already exists for this email." });
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO access_requests (id, full_name, email, phone, organization, country, status) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
    [id, String(fullName).trim(), normalizedEmail, String(phone).trim(), String(organization || "").trim(), String(country || "").trim()]
  );
  res.status(201).json({ message: "Request submitted successfully. Admin will review it.", request: result.rows[0] });
});

async function createSessionTokens(user) {
  const sessionId = randomUUID();
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user, sessionId);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [sessionId, user.id, hashToken(refreshToken), expiresAt]
  );
  return { accessToken, refreshToken };
}

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = normalizePasswordInput(password);
  if (!normalizedEmail || !normalizedPassword) {
    return res.status(400).json({ message: "Email and password are required." });
  }
  const result = await pool.query("SELECT * FROM users WHERE email = $1 LIMIT 1", [normalizedEmail]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ message: "Invalid credentials." });
  const valid = await bcrypt.compare(normalizedPassword, user.password_hash);
  if (!valid) return res.status(401).json({ message: "Invalid credentials." });
  await ensureUserDefaults(user.id);
  const tokens = await createSessionTokens(user);
  res.json({ ...tokens, user: sanitizeUser(user) });
});

app.post("/api/admin/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const normalizedEmail = String(email || "").toLowerCase().trim();
  const result = await pool.query(
    "SELECT * FROM admin_users WHERE email = $1 AND is_active = true LIMIT 1",
    [normalizedEmail]
  );
  const adminRecord = result.rows[0];
  if (!adminRecord) return res.status(401).json({ message: "Invalid admin credentials." });
  const valid = await bcrypt.compare(String(password || ""), adminRecord.password_hash);
  if (!valid) return res.status(401).json({ message: "Invalid admin credentials." });
  const adminUser = {
    id: adminRecord.id,
    email: adminRecord.email,
    role: "admin",
    admin_role: adminRecord.role,
    full_name: adminRecord.full_name,
  };
  const tokens = await createSessionTokens(adminUser);
  res.json({
    ...tokens,
    admin: {
      id: adminRecord.id,
      email: adminRecord.email,
      fullName: adminRecord.full_name,
      role: "admin",
      adminRole: adminRecord.role,
    },
  });
});

app.post("/api/auth/refresh", async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken) return res.status(400).json({ message: "refreshToken is required." });
  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.tokenType !== "refresh") return res.status(401).json({ message: "Invalid refresh token." });
    const tokenHash = hashToken(refreshToken);
    const tokenResult = await pool.query(
      "SELECT * FROM refresh_tokens WHERE id = $1 AND token_hash = $2 AND is_revoked = false AND expires_at > NOW() LIMIT 1",
      [payload.sessionId, tokenHash]
    );
    if (!tokenResult.rowCount) return res.status(401).json({ message: "Refresh token expired or revoked." });
    await pool.query("UPDATE refresh_tokens SET is_revoked = true WHERE id = $1", [payload.sessionId]);
    const userLike = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      admin_role: payload.adminRole || null,
      full_name: payload.email,
    };
    const rotated = await createSessionTokens(userLike);
    return res.json(rotated);
  } catch (_e) {
    return res.status(401).json({ message: "Invalid refresh token." });
  }
});

app.post("/api/logout", async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken) return res.status(400).json({ message: "refreshToken is required." });
  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.tokenType !== "refresh") return res.status(401).json({ message: "Invalid refresh token." });
    await pool.query("UPDATE refresh_tokens SET is_revoked = true WHERE id = $1", [payload.sessionId]);
    return res.json({ message: "Logged out successfully." });
  } catch (_e) {
    return res.status(401).json({ message: "Invalid refresh token." });
  }
});

app.get("/api/admin/requests", requireAuth, requireAdmin, async (_req, res) => {
  const result = await pool.query("SELECT * FROM access_requests ORDER BY created_at DESC");
  res.json({ requests: result.rows });
});

app.post("/api/admin/requests/:id/verify", requireAuth, requireAdmin, async (req, res) => {
  const requestId = req.params.id;
  const requestResult = await pool.query("SELECT * FROM access_requests WHERE id = $1 LIMIT 1", [requestId]);
  const requestItem = requestResult.rows[0];
  if (!requestItem) return res.status(404).json({ message: "Request not found." });
  if (requestItem.status !== "pending") return res.status(400).json({ message: "Request already reviewed." });
  const normalizedEmail = normalizeEmail(requestItem.email);
  const existingUser = await pool.query("SELECT id FROM users WHERE email = $1 LIMIT 1", [normalizedEmail]);
  if (existingUser.rowCount) {
    return res.status(409).json({ message: "An account already exists for this email." });
  }
  const plainPassword = createRandomPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);
  const userId = randomUUID();
  await pool.query("BEGIN");
  try {
    await pool.query(
      `INSERT INTO users (id, full_name, email, phone, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,'user',$5,true)`,
      [userId, requestItem.full_name, normalizedEmail, requestItem.phone, passwordHash]
    );
    await pool.query(`UPDATE access_requests SET status = 'approved', reviewed_at = NOW() WHERE id = $1`, [requestId]);
    await pool.query(
      `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), "APPROVE_REQUEST", req.auth.email, requestId, requestItem.email]
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
  await ensureUserDefaults(userId);
  const delivery = await deliverCredentials({
    email: normalizedEmail,
    fullName: requestItem.full_name,
    phone: requestItem.phone,
    password: plainPassword,
  });
  res.json({
    message: "Request approved. Credentials generated and delivery attempted.",
    credentials: { email: normalizedEmail, password: plainPassword },
    delivery,
  });
});

app.post("/api/admin/requests/:id/reject", requireAuth, requireAdmin, async (req, res) => {
  const requestId = req.params.id;
  const requestResult = await pool.query("SELECT * FROM access_requests WHERE id = $1 LIMIT 1", [requestId]);
  const requestItem = requestResult.rows[0];
  if (!requestItem) return res.status(404).json({ message: "Request not found." });
  if (requestItem.status !== "pending") return res.status(400).json({ message: "Request already reviewed." });
  await pool.query(`UPDATE access_requests SET status = 'rejected', reviewed_at = NOW() WHERE id = $1`, [requestId]);
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), "REJECT_REQUEST", req.auth.email, requestId, requestItem.email]
  );
  res.json({ message: "Request rejected." });
});

app.get("/api/admin/audit", requireAuth, requireAdmin, async (_req, res) => {
  const result = await pool.query("SELECT * FROM admin_audit ORDER BY created_at DESC");
  res.json({ logs: result.rows });
});

app.get("/api/admin/users", requireAuth, requireAdmin, async (_req, res) => {
  const result = await pool.query(
    "SELECT id, full_name, email, role, is_active, created_at, updated_at FROM admin_users ORDER BY created_at DESC"
  );
  res.json({ users: result.rows });
});

app.post("/api/admin/users", requireAuth, requireSuperAdmin, async (req, res) => {
  const { fullName, email, password, role } = req.body ?? {};
  const normalizedEmail = String(email || "").toLowerCase().trim();
  const normalizedRole = role === "super_admin" ? "super_admin" : "admin";
  if (!fullName || !normalizedEmail || !password || String(password).length < 8) {
    return res.status(400).json({
      message: "fullName, email and password(min 8 chars) are required.",
    });
  }
  const existing = await pool.query("SELECT id FROM admin_users WHERE email = $1 LIMIT 1", [normalizedEmail]);
  if (existing.rowCount) return res.status(409).json({ message: "Admin already exists for this email." });
  const hash = await bcrypt.hash(String(password), 10);
  const result = await pool.query(
    `INSERT INTO admin_users (id, full_name, email, password_hash, role, is_active, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,NOW())
     RETURNING id, full_name, email, role, is_active, created_at, updated_at`,
    [randomUUID(), String(fullName).trim(), normalizedEmail, hash, normalizedRole]
  );
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email)
     VALUES ($1,$2,$3,NULL,$4)`,
    [randomUUID(), "CREATE_ADMIN_USER", req.auth.email, normalizedEmail]
  );
  res.status(201).json({ user: result.rows[0], message: "Admin user created successfully." });
});

app.get("/api/me", requireAuth, async (req, res) => {
  if (req.auth.role === "admin") {
    return res.json({ user: { id: req.auth.sub, fullName: "Admin", email: req.auth.email, role: "admin" } });
  }
  const result = await pool.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [req.auth.sub]);
  if (!result.rowCount) return res.status(404).json({ message: "User not found." });
  return res.json({ user: sanitizeUser(result.rows[0]) });
});

app.post("/api/change-password", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(400).json({ message: "Only users can change password here." });
  const body = req.body ?? {};
  const currentPassword = normalizePasswordInput(
    body.currentPassword ?? body.oldPassword ?? body.current_password
  );
  const newPassword = normalizePasswordInput(body.newPassword ?? body.new_password);
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: "Current and new password are required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ message: "New password must be at least 8 characters." });
  }
  const result = await pool.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [req.auth.sub]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ message: "User not found." });
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) {
    const hint = user.must_change_password
      ? "Temporary password is incorrect. Use the exact password provided by your admin."
      : "Current password is incorrect.";
    return res.status(401).json({ message: hint });
  }
  const sameAsCurrent = await bcrypt.compare(newPassword, user.password_hash);
  if (sameAsCurrent) {
    return res.status(400).json({ message: "New password must be different from your current password." });
  }
  const hashed = await bcrypt.hash(newPassword, 10);
  const updated = await pool.query(
    "UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2 RETURNING *",
    [hashed, user.id]
  );
  await addNotification(user.id, "Password Updated", "Your account password was changed successfully.");
  return res.json({
    message: "Password updated successfully.",
    user: sanitizeUser(updated.rows[0]),
  });
});

app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body ?? {};
  const normalized = String(email || "").toLowerCase().trim();
  if (!normalized) return res.status(400).json({ message: "Email is required." });
  const result = await pool.query("SELECT * FROM users WHERE email = $1 LIMIT 1", [normalized]);
  if (!result.rowCount) {
    return res.json({ message: "If this email exists, reset instructions were sent." });
  }
  const user = result.rows[0];
  const plainToken = randomUUID();
  const tokenHash = hashToken(plainToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
  await pool.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [randomUUID(), user.id, tokenHash, expiresAt]
  );

  if (process.env.SMTP_HOST) {
    const emailResult = await withRetry(
      "password-reset-email",
      normalized,
      { userId: user.id, email: normalized },
      () => sendPasswordResetEmail(normalized, user.full_name, plainToken)
    );
    if (!emailResult.success) {
      return res.status(500).json({ message: "Could not send reset email right now." });
    }
  }

  return res.json({
    message: "If this email exists, reset instructions were sent.",
    resetTokenPreview: process.env.NODE_ENV !== "production" ? plainToken : undefined,
  });
});

app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body ?? {};
  if (!token || !newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ message: "Token and valid new password are required." });
  }
  const tokenHash = hashToken(String(token));
  const result = await pool.query(
    `SELECT * FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  if (!result.rowCount) return res.status(400).json({ message: "Reset token is invalid or expired." });
  const resetRecord = result.rows[0];
  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  await pool.query("BEGIN");
  try {
    await pool.query(
      "UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2",
      [passwordHash, resetRecord.user_id]
    );
    await pool.query(
      "UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1",
      [resetRecord.id]
    );
    await pool.query(
      "UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1 AND is_revoked = false",
      [resetRecord.user_id]
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
  await addNotification(resetRecord.user_id, "Password Reset", "Your password was reset and active sessions were revoked.");
  return res.json({ message: "Password has been reset successfully." });
});

const FALLBACK_INSTRUMENTS = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT", name: "Bitcoin", type: "crypto", source: "fallback", last: 0, changePct: 0, quoteVolume: 0, ...CRYPTO_QTY_DEFAULTS },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT", name: "Ethereum", type: "crypto", source: "fallback", last: 0, changePct: 0, quoteVolume: 0, ...CRYPTO_QTY_DEFAULTS },
  { symbol: "BNBUSDT", base: "BNB", quote: "USDT", name: "Binance Coin", type: "crypto", source: "fallback", last: 0, changePct: 0, quoteVolume: 0, ...CRYPTO_QTY_DEFAULTS },
  { symbol: "SOLUSDT", base: "SOL", quote: "USDT", name: "Solana", type: "crypto", source: "fallback", last: 0, changePct: 0, quoteVolume: 0, ...CRYPTO_QTY_DEFAULTS },
  { symbol: "XRPUSDT", base: "XRP", quote: "USDT", name: "XRP", type: "crypto", source: "fallback", last: 0, changePct: 0, quoteVolume: 0, ...CRYPTO_QTY_DEFAULTS },
  { symbol: "ADAUSDT", base: "ADA", quote: "USDT", name: "Cardano", type: "crypto", source: "fallback", last: 0, changePct: 0, quoteVolume: 0, ...CRYPTO_QTY_DEFAULTS },
  { symbol: "DOGEUSDT", base: "DOGE", quote: "USDT", name: "Dogecoin", type: "crypto", source: "fallback", last: 0, changePct: 0, quoteVolume: 0, ...CRYPTO_QTY_DEFAULTS },
  { symbol: "TRXUSDT", base: "TRX", quote: "USDT", name: "TRON", type: "crypto", source: "fallback", last: 0, changePct: 0, quoteVolume: 0, ...CRYPTO_QTY_DEFAULTS },
];

app.get("/api/market/instruments", requireAuth, async (req, res) => {
  const limitParam = Number(req.query.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 150;
  const venue = normalizeMarketVenue(req.query.venue);
  if (venue === "nse") {
    const { instruments: all, source, liveCount, totalCount } = await getNseInstrumentsWithLiveQuotes();
    return res.json({
      instruments: all.slice(0, limit),
      total: all.length,
      source,
      venue: "nse",
      liveCount: liveCount ?? 0,
      totalCount: totalCount ?? all.length,
    });
  }
  if (venue === "commodity") {
    const all = COMMODITY_INSTRUMENTS;
    return res.json({
      instruments: all.slice(0, limit),
      total: all.length,
      source: "synthetic",
      venue: "commodity",
    });
  }
  try {
    const all = await fetchBinanceInstruments();
    res.json({
      instruments: all.slice(0, limit),
      total: all.length,
      source: "binance",
      venue: "crypto",
    });
  } catch (_error) {
    res.json({
      instruments: FALLBACK_INSTRUMENTS.slice(0, limit),
      total: FALLBACK_INSTRUMENTS.length,
      source: "fallback",
      venue: "crypto",
    });
  }
});

app.get("/api/market/candles", requireAuth, async (req, res) => {
  const { symbol = "BTCUSDT", interval = "1m", limit = 80 } = req.query;
  const symU = String(symbol).toUpperCase();
  if (isNseMarketSymbol(symU)) {
    await refreshNseLiveCache();
    const candles = buildCandles(symU, String(interval), Number(limit));
    const live = nseLiveCache.byBase[nseSymbolToBase(symU)];
    return res.json({
      symbol: symU,
      interval: parseInterval(String(interval)),
      candles,
      source: live?.last > 0 ? "indian-stock-api-synthetic-candles" : "synthetic",
    });
  }
  if (isSyntheticMarketSymbol(symU)) {
    const candles = buildCandles(symU, String(interval), Number(limit));
    return res.json({
      symbol: symU,
      interval: parseInterval(String(interval)),
      candles,
      source: "synthetic",
    });
  }
  try {
    const candles = await fetchBinanceCandles(String(symbol), String(interval), Number(limit));
    res.json({ symbol: normalizeMarketSymbol(String(symbol)), interval: parseInterval(String(interval)), candles, source: "binance" });
  } catch (_error) {
    const candles = buildCandles(String(symbol), String(interval), Number(limit));
    res.json({ symbol: normalizeMarketSymbol(String(symbol)), interval: parseInterval(String(interval)), candles, source: "synthetic-fallback" });
  }
});

app.get("/api/market/quote", requireAuth, async (req, res) => {
  const symbol = String(req.query.symbol || "BTCUSDT");
  const quote = await fetchMarketQuote(symbol);
  res.json(quote);
});

app.get("/api/market/search", requireAuth, async (req, res) => {
  const venue = normalizeMarketVenue(req.query.venue);
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ message: "q query parameter is required." });
  if (venue !== "nse") {
    return res.status(400).json({ message: "Search is supported for NSE venue only." });
  }
  try {
    const instruments = await searchIndianNseStocks(q);
    return res.json({ instruments, total: instruments.length, source: "indian-stock-api", venue: "nse" });
  } catch (error) {
    return res.status(502).json({ message: error.message || "NSE search failed." });
  }
});

app.get("/api/market/quantity-rules", requireAuth, async (req, res) => {
  const symbol = String(req.query.symbol || "").trim();
  if (!symbol) return res.status(400).json({ message: "symbol query parameter is required." });
  res.json(getInstrumentQuantityRules(symbol));
});

app.get("/api/admin/delivery-dead-letters", requireAuth, requireAdmin, async (_req, res) => {
  const result = await pool.query("SELECT * FROM delivery_dead_letters ORDER BY created_at DESC LIMIT 200");
  res.json({ deadLetters: result.rows });
});

app.get("/api/admin/app-users", requireAuth, requireAdmin, async (_req, res) => {
  const result = await pool.query(
    `SELECT id, full_name, email, phone, must_change_password, created_at
     FROM users
     ORDER BY created_at DESC`
  );
  res.json({ users: result.rows });
});

app.get("/api/admin/orders", requireAuth, requireAdmin, async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId) : null;
  const venueQ = req.query.venue ? String(req.query.venue).toLowerCase() : null;
  const params = [];
  const conds = [];
  let i = 1;
  if (userId) {
    conds.push(`t.user_id = $${i++}`);
    params.push(userId);
  }
  if (venueQ && ["crypto", "nse", "commodity"].includes(venueQ)) {
    conds.push(`t.market_venue = $${i++}`);
    params.push(venueQ);
  }
  const whereClause = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT t.*, u.email AS user_email, u.full_name AS user_full_name
     FROM trades t
     INNER JOIN users u ON u.id = t.user_id
     ${whereClause}
     ORDER BY t.created_at DESC
     LIMIT 500`,
    params
  );
  res.json({ orders: result.rows });
});

app.get("/api/admin/trade-summary", requireAuth, requireAdmin, async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId) : null;
  const venueQ = req.query.venue ? String(req.query.venue).toLowerCase() : null;
  const params = [];
  const conds = [];
  let i = 1;
  if (userId) {
    conds.push(`user_id = $${i++}`);
    params.push(userId);
  }
  if (venueQ && ["crypto", "nse", "commodity"].includes(venueQ)) {
    conds.push(`market_venue = $${i++}`);
    params.push(venueQ);
  }
  const whereClause = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT
      COUNT(*) FILTER (WHERE status = 'open') AS open_count,
      COUNT(*) FILTER (WHERE status = 'closed') AS closed_count,
      COALESCE(SUM(pnl), 0) AS total_pnl
     FROM trades
     ${whereClause}`,
    params
  );
  res.json({ summary: result.rows[0] });
});

app.post("/api/admin/orders/:id/close", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const orderResult = await pool.query("SELECT * FROM trades WHERE id = $1 LIMIT 1", [id]);
  const order = orderResult.rows[0];
  if (!order) return res.status(404).json({ message: "Order not found." });
  const userResult = await pool.query("SELECT email FROM users WHERE id = $1 LIMIT 1", [order.user_id]);
  const traderEmail = userResult.rows[0]?.email || "";
  const closed = await closeTradeOrder(order);
  if (!closed.ok) return res.status(closed.status).json(closed.body);
  await addNotification(
    order.user_id,
    "Position Closed (Admin)",
    `Order ${id.slice(0, 8)} was closed by support. PnL ${Number(closed.pnl).toFixed(4)}`
  );
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), `ADMIN_CLOSE_ORDER:${id}`, req.auth.email, null, traderEmail]
  );
  res.json({ order: closed.order });
});

app.get("/api/admin/wallet-transactions", requireAuth, requireAdmin, async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId) : null;
  const params = [];
  let whereClause = "";
  if (userId) {
    whereClause = "WHERE w.user_id = $1";
    params.push(userId);
  }
  const result = await pool.query(
    `SELECT w.*, u.email AS user_email, u.full_name AS user_full_name
     FROM wallet_transactions w
     INNER JOIN users u ON u.id = w.user_id
     ${whereClause}
     ORDER BY w.created_at DESC
     LIMIT 500`,
    params
  );
  res.json({ transactions: result.rows });
});

app.patch("/api/admin/wallet-transactions/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const status = String(req.body?.status || "").toLowerCase();
  const note = req.body?.note != null ? String(req.body.note) : null;
  if (!["pending", "completed", "rejected"].includes(status)) {
    return res.status(400).json({ message: "status must be pending, completed, or rejected." });
  }
  const existingResult = await pool.query(
    `SELECT w.*, u.email AS user_email
     FROM wallet_transactions w
     INNER JOIN users u ON u.id = w.user_id
     WHERE w.id = $1 LIMIT 1`,
    [id]
  );
  const row = existingResult.rows[0];
  if (!row) return res.status(404).json({ message: "Transaction not found." });
  const prevStatus = row.status;
  if (
    row.type === "withdrawal" &&
    status === "completed" &&
    prevStatus !== "completed"
  ) {
    const settled = await walletCompletedBalance(row.user_id);
    const amt = Number(row.amount);
    if (settled < amt) {
      return res.status(400).json({
        message: "Insufficient settled wallet balance to complete this withdrawal.",
      });
    }
  }
  const updated = await pool.query(
    `UPDATE wallet_transactions
     SET status = $1,
         note = COALESCE($2, note)
     WHERE id = $3
     RETURNING *`,
    [status, note, id]
  );
  const tx = updated.rows[0];
  const amtStr = Number(tx.amount).toFixed(2);
  if (row.type === "deposit" && status === "completed" && prevStatus === "pending") {
    await addNotification(
      row.user_id,
      "Deposit confirmed",
      `Your deposit of ${amtStr} was confirmed and credited to your wallet.`
    );
  }
  if (row.type === "withdrawal" && status === "completed" && prevStatus === "pending") {
    await addNotification(
      row.user_id,
      "Withdrawal paid",
      `Your withdrawal of ${amtStr} was marked paid by support.`
    );
  }
  if (row.type === "withdrawal" && status === "rejected" && prevStatus === "pending") {
    await addNotification(
      row.user_id,
      "Withdrawal request declined",
      `Your withdrawal request for ${amtStr} was declined. Contact support if you need help.`
    );
  }
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [
      randomUUID(),
      `ADMIN_UPDATE_WALLET_TX:${id}:${status}`,
      req.auth.email,
      null,
      row.user_email || "",
    ]
  );
  res.json({ transaction: tx });
});

app.get("/api/admin/deposit-payment-intents", requireAuth, requireAdmin, async (_req, res) => {
  const result = await pool.query(
    `SELECT * FROM deposit_payment_intents ORDER BY sort_order ASC, created_at ASC`
  );
  const activeCount = await countActiveDepositPaymentIntents();
  res.json({
    intents: result.rows,
    maxActive: MAX_ACTIVE_DEPOSIT_PAYMENT_INTENTS,
    activeCount,
  });
});

app.post("/api/admin/deposit-payment-intents", requireAuth, requireAdmin, async (req, res) => {
  const intent_payment_id = String(req.body?.intent_payment_id || "").trim();
  if (!intent_payment_id) {
    return res.status(400).json({ message: "intent_payment_id is required." });
  }
  const label = String(req.body?.label || "").trim().slice(0, 200);
  const sort_order = Number.isFinite(Number(req.body?.sort_order)) ? Number(req.body.sort_order) : 0;
  const is_active =
    req.body && Object.prototype.hasOwnProperty.call(req.body, "is_active")
      ? Boolean(req.body.is_active)
      : true;
  if (is_active) {
    const n = await countActiveDepositPaymentIntents();
    if (n >= MAX_ACTIVE_DEPOSIT_PAYMENT_INTENTS) {
      return res.status(400).json({
        message: `At most ${MAX_ACTIVE_DEPOSIT_PAYMENT_INTENTS} active payment IDs are allowed. Deactivate one first.`,
      });
    }
  }
  const id = randomUUID();
  const inserted = await pool.query(
    `INSERT INTO deposit_payment_intents (id, intent_payment_id, label, is_active, sort_order)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, intent_payment_id.slice(0, 500), label, is_active, sort_order]
  );
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), `ADMIN_PAYMENT_INTENT_CREATE:${id}`, req.auth.email, null, ""]
  );
  res.status(201).json({ intent: inserted.rows[0] });
});

app.patch("/api/admin/deposit-payment-intents/:intentId", requireAuth, requireAdmin, async (req, res) => {
  const { intentId } = req.params;
  const existingResult = await pool.query(`SELECT * FROM deposit_payment_intents WHERE id = $1`, [intentId]);
  const existing = existingResult.rows[0];
  if (!existing) return res.status(404).json({ message: "Payment intent not found." });
  const intent_payment_id =
    req.body?.intent_payment_id != null
      ? String(req.body.intent_payment_id).trim().slice(0, 500)
      : existing.intent_payment_id;
  if (!intent_payment_id) {
    return res.status(400).json({ message: "intent_payment_id cannot be empty." });
  }
  const label =
    req.body?.label != null ? String(req.body.label).trim().slice(0, 200) : existing.label;
  const sort_order =
    req.body?.sort_order != null && Number.isFinite(Number(req.body.sort_order))
      ? Number(req.body.sort_order)
      : existing.sort_order;
  let is_active = existing.is_active;
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, "is_active")) {
    is_active = Boolean(req.body.is_active);
  }
  if (is_active && !existing.is_active) {
    const n = await countActiveDepositPaymentIntents();
    if (n >= MAX_ACTIVE_DEPOSIT_PAYMENT_INTENTS) {
      return res.status(400).json({
        message: `At most ${MAX_ACTIVE_DEPOSIT_PAYMENT_INTENTS} active payment IDs are allowed.`,
      });
    }
  }
  const updated = await pool.query(
    `UPDATE deposit_payment_intents
     SET intent_payment_id = $1,
         label = $2,
         sort_order = $3,
         is_active = $4
     WHERE id = $5
     RETURNING *`,
    [intent_payment_id, label, sort_order, is_active, intentId]
  );
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), `ADMIN_PAYMENT_INTENT_UPDATE:${intentId}`, req.auth.email, null, ""]
  );
  res.json({ intent: updated.rows[0] });
});

app.delete("/api/admin/deposit-payment-intents/:intentId", requireAuth, requireAdmin, async (req, res) => {
  const { intentId } = req.params;
  const del = await pool.query(`DELETE FROM deposit_payment_intents WHERE id = $1 RETURNING id`, [intentId]);
  if (!del.rowCount) return res.status(404).json({ message: "Payment intent not found." });
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), `ADMIN_PAYMENT_INTENT_DELETE:${intentId}`, req.auth.email, null, ""]
  );
  res.status(204).send();
});

async function requireAppUserById(userId) {
  const result = await pool.query("SELECT id, email FROM users WHERE id = $1 AND role = 'user' LIMIT 1", [userId]);
  return result.rows[0] || null;
}

async function walletCompletedBalance(userId, db = pool) {
  const balanceResult = await db.query(
    `SELECT
      COALESCE(SUM(CASE WHEN type='deposit' AND status='completed' THEN amount ELSE 0 END),0) -
      COALESCE(SUM(CASE WHEN type='withdrawal' AND status='completed' THEN amount ELSE 0 END),0) AS balance
     FROM wallet_transactions WHERE user_id = $1`,
    [userId]
  );
  return Number(balanceResult.rows[0].balance || 0);
}

function insufficientWalletPayload(balance, required) {
  const shortfall = Math.max(0, Number((required - balance).toFixed(8)));
  return {
    message: "Insufficient wallet balance. Add money to your wallet before buying.",
    code: "INSUFFICIENT_WALLET_BALANCE",
    balance: Number(balance.toFixed(8)),
    required: Number(required.toFixed(8)),
    shortfall,
    estimatedNotional: Number(required.toFixed(8)),
  };
}

async function postTradeWalletDebit(client, userId, tradeId, amount, symbol) {
  const note = `Trade buy ${normalizeMarketSymbol(symbol)} · order ${tradeId.slice(0, 8)}`;
  await client.query(
    `INSERT INTO wallet_transactions (id, user_id, type, amount, status, note)
     VALUES ($1,$2,'withdrawal',$3,'completed',$4)`,
    [randomUUID(), userId, amount, note.slice(0, 500)]
  );
}

async function postTradeWalletCredit(client, userId, tradeId, amount, symbol, side) {
  if (!amount || amount <= 0) return;
  const note = `Trade close ${side} ${normalizeMarketSymbol(symbol)} · order ${tradeId.slice(0, 8)}`;
  await client.query(
    `INSERT INTO wallet_transactions (id, user_id, type, amount, status, note)
     VALUES ($1,$2,'deposit',$3,'completed',$4)`,
    [randomUUID(), userId, amount, note.slice(0, 500)]
  );
}

async function placeTradeOrderForUser(userId, { symbol, side, quantity }) {
  const qty = Number(quantity);
  const normalizedSide = String(side || "").toLowerCase();
  if (!symbol || !["buy", "sell"].includes(normalizedSide) || !qty || qty <= 0) {
    return { ok: false, status: 400, body: { message: "symbol, side (buy/sell), quantity are required." } };
  }
  const qtyCheck = validateOrderQuantity(String(symbol), qty);
  if (!qtyCheck.ok) return { ok: false, status: 400, body: { message: qtyCheck.message } };
  const orderQty = qtyCheck.rules.qtyDecimals === 0 ? Math.round(qty) : qty;
  let quote;
  try {
    quote = await fetchMarketQuote(String(symbol));
  } catch (_e) {
    quote = { last: 0 };
  }
  const entryPrice = Number(quote.last || 0);
  const normSym = normalizeMarketSymbol(String(symbol));
  const mVenue = inferMarketVenue(normSym);
  const estimatedNotional =
    entryPrice > 0 ? Number((entryPrice * orderQty).toFixed(8)) : null;

  if (normalizedSide === "buy") {
    if (!estimatedNotional || estimatedNotional <= 0) {
      return {
        ok: false,
        status: 400,
        body: { message: "Market price is unavailable. Try again in a moment." },
      };
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const balance = await walletCompletedBalance(userId, client);
      if (balance + 1e-9 < estimatedNotional) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          status: 402,
          body: insufficientWalletPayload(balance, estimatedNotional),
        };
      }
      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO trades (id, user_id, symbol, side, quantity, entry_price, status, market_venue)
         VALUES ($1,$2,$3,$4,$5,$6,'open',$7) RETURNING *`,
        [id, userId, normSym, normalizedSide, orderQty, entryPrice, mVenue]
      );
      await postTradeWalletDebit(client, userId, id, estimatedNotional, normSym);
      await client.query("COMMIT");
      return {
        ok: true,
        order: result.rows[0],
        execution: {
          symbol: normSym,
          side: normalizedSide,
          quantity: orderQty,
          lastPrice: entryPrice,
          estimatedNotional,
        },
        walletDebited: estimatedNotional,
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO trades (id, user_id, symbol, side, quantity, entry_price, status, market_venue)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7) RETURNING *`,
    [id, userId, normSym, normalizedSide, orderQty, entryPrice, mVenue]
  );
  return {
    ok: true,
    order: result.rows[0],
    execution: {
      symbol: normSym,
      side: normalizedSide,
      quantity: orderQty,
      lastPrice: entryPrice,
      estimatedNotional,
    },
  };
}

async function closeTradeOrder(order) {
  if (order.status !== "open") {
    return { ok: false, status: 400, body: { message: "Order already closed." } };
  }
  let quote;
  try {
    quote = await fetchMarketQuote(order.symbol);
  } catch (_e) {
    quote = { last: Number(order.entry_price) };
  }
  const exitPrice = Number(quote.last || order.entry_price);
  const qty = Number(order.quantity);
  const pnl =
    order.side === "buy"
      ? (exitPrice - Number(order.entry_price)) * qty
      : (Number(order.entry_price) - exitPrice) * qty;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE trades
       SET status = 'closed', exit_price = $1, pnl = $2, closed_at = NOW()
       WHERE id = $3 RETURNING *`,
      [exitPrice, pnl, order.id]
    );
    if (order.side === "buy") {
      const proceeds = Number((exitPrice * qty).toFixed(8));
      await postTradeWalletCredit(client, order.user_id, order.id, proceeds, order.symbol, order.side);
    }
    await client.query("COMMIT");
    return { ok: true, order: updated.rows[0], exitPrice, pnl };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const MAX_ACTIVE_DEPOSIT_PAYMENT_INTENTS = 20;

/** Settled balance minus amounts already tied up in pending withdrawal requests. */
async function walletWithdrawAvailableBalance(userId) {
  const result = await pool.query(
    `SELECT
      COALESCE(SUM(CASE WHEN type='deposit' AND status='completed' THEN amount ELSE 0 END),0) -
      COALESCE(SUM(CASE WHEN type='withdrawal' AND status='completed' THEN amount ELSE 0 END),0) -
      COALESCE(SUM(CASE WHEN type='withdrawal' AND status='pending' THEN amount ELSE 0 END),0) AS available
     FROM wallet_transactions WHERE user_id = $1`,
    [userId]
  );
  return Number(result.rows[0].available || 0);
}

async function countActiveDepositPaymentIntents() {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM deposit_payment_intents WHERE is_active = true`
  );
  return result.rows[0]?.n ?? 0;
}

app.post("/api/admin/app-users/:userId/wallet/deposit", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note || "Admin deposit").slice(0, 500);
  const status = String(req.body?.status || "completed").toLowerCase();
  if (!amount || amount <= 0) return res.status(400).json({ message: "Valid amount is required." });
  if (!["pending", "completed", "rejected"].includes(status)) {
    return res.status(400).json({ message: "status must be pending, completed, or rejected." });
  }
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO wallet_transactions (id, user_id, type, amount, status, note)
     VALUES ($1,$2,'deposit',$3,$4,$5) RETURNING *`,
    [id, appUser.id, amount, status, note]
  );
  if (status === "completed") {
    await addNotification(
      appUser.id,
      "Wallet credit",
      `A deposit of ${amount.toFixed(2)} was posted to your wallet.`
    );
  }
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), `ADMIN_WALLET_DEPOSIT:${id}:${status}`, req.auth.email, null, appUser.email || ""]
  );
  res.status(201).json({ transaction: result.rows[0] });
});

app.post("/api/admin/app-users/:userId/wallet/withdraw", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note || "Admin withdrawal").slice(0, 500);
  const status = String(req.body?.status || "completed").toLowerCase();
  if (!amount || amount <= 0) return res.status(400).json({ message: "Valid amount is required." });
  if (!["pending", "completed", "rejected"].includes(status)) {
    return res.status(400).json({ message: "status must be pending, completed, or rejected." });
  }
  if (status === "completed") {
    const balance = await walletCompletedBalance(appUser.id);
    if (balance < amount) return res.status(400).json({ message: "Insufficient completed balance for this withdrawal." });
  }
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO wallet_transactions (id, user_id, type, amount, status, note)
     VALUES ($1,$2,'withdrawal',$3,$4,$5) RETURNING *`,
    [id, appUser.id, amount, status, note]
  );
  if (status === "completed") {
    await addNotification(
      appUser.id,
      "Wallet debit",
      `A withdrawal of ${amount.toFixed(2)} was posted to your wallet.`
    );
  }
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), `ADMIN_WALLET_WITHDRAW:${id}:${status}`, req.auth.email, null, appUser.email || ""]
  );
  res.status(201).json({ transaction: result.rows[0] });
});

app.get("/api/admin/app-users/:userId/wallet/balance", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  const balance = await walletCompletedBalance(appUser.id);
  res.json({ balance });
});

app.post("/api/admin/app-users/:userId/reset-password", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  const plainPassword = createRandomPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);
  await pool.query("UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2", [
    passwordHash,
    appUser.id,
  ]);
  await addNotification(
    appUser.id,
    "Password reset",
    "Your password was reset by support. Use the new temporary password you receive from support, then change it in the app."
  );
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), "ADMIN_RESET_USER_PASSWORD", req.auth.email, null, appUser.email || ""]
  );
  res.json({
    message: "Password reset. Share the temporary password with the user through a secure channel.",
    email: appUser.email,
    temporaryPassword: plainPassword,
  });
});

app.get("/api/admin/app-users/:userId/notifications", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  const result = await pool.query(
    "SELECT * FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 300",
    [appUser.id]
  );
  res.json({ notifications: result.rows });
});

app.post("/api/admin/app-users/:userId/notifications/:notifId/read", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  const result = await pool.query(
    `UPDATE user_notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *`,
    [req.params.notifId, appUser.id]
  );
  if (!result.rowCount) return res.status(404).json({ message: "Notification not found." });
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), `ADMIN_NOTIF_READ:${req.params.notifId}`, req.auth.email, null, appUser.email || ""]
  );
  res.json({ notification: result.rows[0] });
});

app.post("/api/admin/app-users/:userId/notifications", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  await ensureUserDefaults(appUser.id);
  const pref = await pool.query("SELECT notifications_enabled FROM user_settings WHERE user_id = $1", [
    appUser.id,
  ]);
  if (pref.rows[0] && pref.rows[0].notifications_enabled === false) {
    return res.status(403).json({
      message: "This user has disabled notifications from the team in the app.",
    });
  }
  const title = String(req.body?.title || "").trim();
  const body = String(req.body?.body || "").trim();
  if (!title || !body) return res.status(400).json({ message: "title and body are required." });
  const id = randomUUID();
  await pool.query(`INSERT INTO user_notifications (id, user_id, title, body) VALUES ($1,$2,$3,$4)`, [
    id,
    appUser.id,
    title,
    body,
  ]);
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), `ADMIN_NOTIF_CREATE:${id}`, req.auth.email, null, appUser.email || ""]
  );
  const row = await pool.query("SELECT * FROM user_notifications WHERE id = $1", [id]);
  res.status(201).json({ notification: row.rows[0] });
});

app.get("/api/admin/app-users/:userId/settings", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  await ensureUserDefaults(appUser.id);
  const result = await pool.query("SELECT * FROM user_settings WHERE user_id = $1", [appUser.id]);
  res.json({ settings: result.rows[0] });
});

app.put("/api/admin/app-users/:userId/settings", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  await ensureUserDefaults(appUser.id);
  const existing = await pool.query("SELECT * FROM user_settings WHERE user_id = $1", [appUser.id]);
  const prev = existing.rows[0] || {};
  const theme = ["dark", "light"].includes(String(req.body?.theme)) ? String(req.body.theme) : "dark";
  const requestedLanguage = String(req.body?.language ?? "").toLowerCase();
  const language = requestedLanguage === "en" || requestedLanguage === "hi"
    ? requestedLanguage
    : prev.language === "hi"
      ? "hi"
      : "en";
  const priceAlerts = Boolean(req.body?.price_alerts);
  const orderAlerts = Boolean(req.body?.order_alerts);
  const notificationsEnabled =
    req.body && Object.prototype.hasOwnProperty.call(req.body, "notifications_enabled")
      ? Boolean(req.body.notifications_enabled)
      : prev.notifications_enabled !== false;
  const result = await pool.query(
    `INSERT INTO user_settings (user_id, theme, language, price_alerts, order_alerts, notifications_enabled, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET theme = EXCLUDED.theme,
         language = EXCLUDED.language,
         price_alerts = EXCLUDED.price_alerts,
         order_alerts = EXCLUDED.order_alerts,
         notifications_enabled = EXCLUDED.notifications_enabled,
         updated_at = NOW()
     RETURNING *`,
    [appUser.id, theme, language, priceAlerts, orderAlerts, notificationsEnabled]
  );
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), "ADMIN_UPDATE_USER_SETTINGS", req.auth.email, null, appUser.email || ""]
  );
  res.json({ settings: result.rows[0] });
});

app.get("/api/admin/app-users/:userId/referrals", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  await ensureUserDefaults(appUser.id);
  const result = await pool.query("SELECT * FROM user_referrals WHERE user_id = $1", [appUser.id]);
  res.json({ referral: result.rows[0] });
});

app.post("/api/admin/app-users/:userId/referrals/simulate", requireAuth, requireAdmin, async (req, res) => {
  const appUser = await requireAppUserById(req.params.userId);
  if (!appUser) return res.status(404).json({ message: "App user not found." });
  await ensureUserDefaults(appUser.id);
  const reward = Number(req.body?.reward || 10);
  const result = await pool.query(
    `UPDATE user_referrals
     SET referred_count = referred_count + 1,
         reward_total = reward_total + $2,
         updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [appUser.id, reward]
  );
  if (!result.rowCount) {
    const seeded = await pool.query("SELECT * FROM user_referrals WHERE user_id = $1", [appUser.id]);
    return res.json({ referral: seeded.rows[0] });
  }
  await addNotification(appUser.id, "Referral Reward", `You earned ${reward.toFixed(2)} referral reward.`);
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), `ADMIN_REFERRAL_SIMULATE:${reward}`, req.auth.email, null, appUser.email || ""]
  );
  res.json({ referral: result.rows[0] });
});

app.post("/api/admin/trade/orders", requireAuth, requireAdmin, async (req, res) => {
  const userId = req.body?.userId ? String(req.body.userId) : "";
  const { symbol, side, quantity } = req.body ?? {};
  const appUser = await requireAppUserById(userId);
  if (!appUser) return res.status(400).json({ message: "Valid app userId is required." });
  const placed = await placeTradeOrderForUser(appUser.id, { symbol, side, quantity });
  if (!placed.ok) return res.status(placed.status).json(placed.body);
  await addNotification(
    appUser.id,
    "Order Placed (Admin)",
    `Support placed ${placed.execution.side.toUpperCase()} ${placed.execution.quantity} ${placed.execution.symbol}`
  );
  await pool.query(
    `INSERT INTO admin_audit (id, action, actor, target_request_id, target_user_email) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), `ADMIN_PLACE_ORDER:${placed.order.id}`, req.auth.email, null, appUser.email || ""]
  );
  res.status(201).json({
    order: placed.order,
    execution: placed.execution,
    walletDebited: placed.walletDebited ?? null,
  });
});

app.get("/api/trade/orders", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const result = await pool.query(
    "SELECT * FROM trades WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200",
    [req.auth.sub]
  );
  res.json({ orders: result.rows });
});

app.post("/api/trade/orders", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const { symbol, side, quantity } = req.body ?? {};
  const placed = await placeTradeOrderForUser(req.auth.sub, { symbol, side, quantity });
  if (!placed.ok) return res.status(placed.status).json(placed.body);
  await addNotification(
    req.auth.sub,
    "Order Placed",
    `Placed ${placed.execution.side.toUpperCase()} ${placed.execution.quantity} ${placed.execution.symbol}`
  );
  res.status(201).json({
    order: placed.order,
    execution: placed.execution,
    walletDebited: placed.walletDebited ?? null,
  });
});

app.post("/api/trade/orders/:id/close", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const { id } = req.params;
  const orderResult = await pool.query(
    "SELECT * FROM trades WHERE id = $1 AND user_id = $2 LIMIT 1",
    [id, req.auth.sub]
  );
  const order = orderResult.rows[0];
  if (!order) return res.status(404).json({ message: "Order not found." });
  const closed = await closeTradeOrder(order);
  if (!closed.ok) return res.status(closed.status).json(closed.body);
  await addNotification(
    req.auth.sub,
    "Position Closed",
    `Order ${id.slice(0, 8)} closed with PnL ${Number(closed.pnl).toFixed(4)}`
  );
  res.json({ order: closed.order });
});

app.get("/api/trade/summary", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const result = await pool.query(
    `SELECT
      COUNT(*) FILTER (WHERE status = 'open') AS open_count,
      COUNT(*) FILTER (WHERE status = 'closed') AS closed_count,
      COALESCE(SUM(pnl),0) AS total_pnl
     FROM trades WHERE user_id = $1`,
    [req.auth.sub]
  );
  res.json({ summary: result.rows[0] });
});

app.get("/api/wallet/balance", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const balance = await walletCompletedBalance(req.auth.sub);
  const available = await walletWithdrawAvailableBalance(req.auth.sub);
  res.json({ balance, available_balance: available });
});

app.get("/api/wallet/transactions", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const txResult = await pool.query(
    "SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 300",
    [req.auth.sub]
  );
  const settled = await walletCompletedBalance(req.auth.sub);
  const available = await walletWithdrawAvailableBalance(req.auth.sub);
  const holdResult = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS h FROM wallet_transactions
     WHERE user_id = $1 AND type = 'withdrawal' AND status = 'pending'`,
    [req.auth.sub]
  );
  const pendingWithdrawalHold = Number(holdResult.rows[0]?.h || 0);
  res.json({
    transactions: txResult.rows,
    balance: settled,
    available_balance: available,
    pending_withdrawal_hold: pendingWithdrawalHold,
  });
});

/** User starts add-money: assigns next rotating payment ID and creates a pending deposit for admin approval. */
app.post("/api/wallet/deposit-request", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const amount = Number(req.body?.amount);
  if (!amount || amount <= 0) return res.status(400).json({ message: "Valid amount is required." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pick = await client.query(
      `SELECT id, intent_payment_id, label
       FROM deposit_payment_intents
       WHERE is_active = true
       ORDER BY last_assigned_at ASC NULLS FIRST, sort_order ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );
    let intentRow = pick.rows[0];
    if (!intentRow) {
      const fallback = await client.query(
        `SELECT id, intent_payment_id, label
         FROM deposit_payment_intents
         WHERE is_active = true
         ORDER BY last_assigned_at ASC NULLS FIRST, sort_order ASC, created_at ASC
         LIMIT 1
         FOR UPDATE`
      );
      intentRow = fallback.rows[0];
    }
    if (!intentRow) {
      await client.query("ROLLBACK");
      return res.status(503).json({
        message:
          "Add-money is not available yet. Ask support to activate payment IDs in the admin portal.",
      });
    }
    await client.query(`UPDATE deposit_payment_intents SET last_assigned_at = NOW() WHERE id = $1`, [
      intentRow.id,
    ]);
    const txId = randomUUID();
    const ref = txId.replace(/-/g, "").slice(0, 10).toUpperCase();
    const note = `Pending deposit — use assigned payment ID. Ref ${ref}`;
    await client.query(
      `INSERT INTO wallet_transactions (
         id, user_id, type, amount, status, note,
         payment_intent_pool_id, intent_payment_id
       ) VALUES ($1,$2,'deposit',$3,'pending',$4,$5,$6)`,
      [txId, req.auth.sub, amount, note, intentRow.id, intentRow.intent_payment_id]
    );
    await client.query("COMMIT");
    await addNotification(
      req.auth.sub,
      "Deposit started",
      `Pay ${amount.toFixed(2)} using the payment ID shown in Wallet. Pending until support confirms.`
    );
    const txRow = await pool.query("SELECT * FROM wallet_transactions WHERE id = $1", [txId]);
    res.status(201).json({
      transaction: txRow.rows[0],
      intent_payment_id: intentRow.intent_payment_id,
      intent_label: intentRow.label || null,
      reference_code: ref,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

/** User requests withdrawal: pending until admin pays out using supplied UPI / details. */
app.post("/api/wallet/withdraw-request", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const amount = Number(req.body?.amount);
  const payoutUpi = String(req.body?.payout_upi || "").trim();
  const payoutName = String(req.body?.payout_account_name || "").trim().slice(0, 120);
  const extraNote = String(req.body?.note || "").trim().slice(0, 300);
  if (!amount || amount <= 0) return res.status(400).json({ message: "Valid amount is required." });
  if (!payoutUpi) {
    return res.status(400).json({ message: "UPI ID or payout detail is required for withdrawal." });
  }
  const available = await walletWithdrawAvailableBalance(req.auth.sub);
  if (available < amount) {
    return res.status(400).json({
      message:
        "Insufficient available balance. Funds may be reserved for other pending withdrawal requests.",
    });
  }
  const noteParts = [
    "Withdrawal request",
    extraNote ? `— ${extraNote}` : "",
    `— pay to: ${payoutUpi}`,
    payoutName ? `(${payoutName})` : "",
  ];
  const note = noteParts.join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO wallet_transactions (
       id, user_id, type, amount, status, note, payout_upi, payout_account_name
     ) VALUES ($1,$2,'withdrawal',$3,'pending',$4,$5,$6) RETURNING *`,
    [id, req.auth.sub, amount, note, payoutUpi, payoutName || null]
  );
  await addNotification(
    req.auth.sub,
    "Withdrawal requested",
    `Request for ${amount.toFixed(2)} submitted. Support will pay out to your UPI when processed.`
  );
  res.status(201).json({ transaction: result.rows[0] });
});

app.get("/api/notifications", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const result = await pool.query(
    "SELECT * FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 300",
    [req.auth.sub]
  );
  res.json({ notifications: result.rows });
});

app.get("/api/notifications/unread-count", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const result = await pool.query(
    "SELECT COUNT(*)::int AS c FROM user_notifications WHERE user_id = $1 AND is_read = false",
    [req.auth.sub]
  );
  res.json({ unreadCount: result.rows[0]?.c ?? 0 });
});

app.post("/api/notifications/:id/read", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const result = await pool.query(
    `UPDATE user_notifications
     SET is_read = true
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [req.params.id, req.auth.sub]
  );
  if (!result.rowCount) return res.status(404).json({ message: "Notification not found." });
  res.json({ notification: result.rows[0] });
});

app.get("/api/settings", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  await ensureUserDefaults(req.auth.sub);
  const result = await pool.query("SELECT * FROM user_settings WHERE user_id = $1", [req.auth.sub]);
  res.json({ settings: result.rows[0] });
});

app.put("/api/settings", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  await ensureUserDefaults(req.auth.sub);
  const existing = await pool.query("SELECT * FROM user_settings WHERE user_id = $1", [req.auth.sub]);
  const prev = existing.rows[0] || {};
  const theme = ["dark", "light"].includes(String(req.body?.theme)) ? String(req.body.theme) : "dark";
  const requestedLanguage = String(req.body?.language ?? "").toLowerCase();
  const language = requestedLanguage === "en" || requestedLanguage === "hi"
    ? requestedLanguage
    : prev.language === "hi"
      ? "hi"
      : "en";
  const priceAlerts = Boolean(req.body?.price_alerts);
  const orderAlerts = Boolean(req.body?.order_alerts);
  const notificationsEnabled =
    req.body && Object.prototype.hasOwnProperty.call(req.body, "notifications_enabled")
      ? Boolean(req.body.notifications_enabled)
      : prev.notifications_enabled !== false;
  const result = await pool.query(
    `INSERT INTO user_settings (user_id, theme, language, price_alerts, order_alerts, notifications_enabled, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET theme = EXCLUDED.theme,
         language = EXCLUDED.language,
         price_alerts = EXCLUDED.price_alerts,
         order_alerts = EXCLUDED.order_alerts,
         notifications_enabled = EXCLUDED.notifications_enabled,
         updated_at = NOW()
     RETURNING *`,
    [req.auth.sub, theme, language, priceAlerts, orderAlerts, notificationsEnabled]
  );
  res.json({ settings: result.rows[0] });
});

app.get("/api/referrals", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  await ensureUserDefaults(req.auth.sub);
  const result = await pool.query("SELECT * FROM user_referrals WHERE user_id = $1", [req.auth.sub]);
  res.json({ referral: result.rows[0] });
});

app.post("/api/referrals/simulate", requireAuth, async (req, res) => {
  if (req.auth.role !== "user") return res.status(403).json({ message: "User role required." });
  const reward = Number(req.body?.reward || 10);
  const result = await pool.query(
    `UPDATE user_referrals
     SET referred_count = referred_count + 1,
         reward_total = reward_total + $2,
         updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [req.auth.sub, reward]
  );
  if (!result.rowCount) {
    await ensureUserDefaults(req.auth.sub);
    const seeded = await pool.query("SELECT * FROM user_referrals WHERE user_id = $1", [req.auth.sub]);
    return res.json({ referral: seeded.rows[0] });
  }
  await addNotification(req.auth.sub, "Referral Reward", `You earned ${reward.toFixed(2)} referral reward.`);
  res.json({ referral: result.rows[0] });
});

const server = http.createServer(app);
const marketWss = new WebSocketServer({ server, path: "/ws/market" });

marketWss.on("connection", (client, req) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  const rawSym = String(url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
  const binanceSymbol = normalizeMarketSymbol(rawSym);
  if (!token) {
    client.send(JSON.stringify({ type: "error", message: "Missing token" }));
    client.close(1008, "Missing token");
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.tokenType !== "access") {
      client.close(1008, "Invalid token type");
      return;
    }
  } catch (_error) {
    client.close(1008, "Invalid token");
    return;
  }

  const streamKey = isSyntheticMarketSymbol(rawSym) ? rawSym : binanceSymbol;
  if (isSyntheticMarketSymbol(streamKey)) {
    let last = SYNTHETIC_PRICE_BASE[streamKey] ?? 100;
    let refreshTimer = null;
    if (isNseMarketSymbol(streamKey)) {
      fetchIndianNseQuote(streamKey)
        .then((q) => {
          if (q?.last > 0) last = q.last;
        })
        .catch(() => {});
      refreshTimer = setInterval(() => {
        fetchIndianNseQuote(streamKey)
          .then((q) => {
            if (q?.last > 0) last = q.last;
          })
          .catch(() => {});
      }, NSE_QUOTE_CACHE_TTL_MS);
    }
    const tick = setInterval(() => {
      if (client.readyState !== WebSocket.OPEN) return;
      const driftScale = isNseMarketSymbol(streamKey) ? 0.00035 : 0.0012;
      const drift = (Math.random() - 0.5) * last * driftScale;
      last = Math.max(0.01, last + drift);
      const bucket = Date.now() - (Date.now() % 60000);
      client.send(
        JSON.stringify({
          type: "kline",
          symbol: streamKey,
          data: {
            timestamp: bucket,
            open: last - drift * 0.5,
            high: last + Math.abs(drift),
            low: last - Math.abs(drift),
            close: last,
            volume: Math.round(500 + Math.random() * 800),
            isFinal: false,
          },
        })
      );
    }, 2500);
    client.on("close", () => {
      clearInterval(tick);
      if (refreshTimer) clearInterval(refreshTimer);
    });
    return;
  }

  const upstream = new WebSocket(`wss://stream.binance.com:9443/ws/${binanceSymbol.toLowerCase()}@kline_1m`);
  upstream.on("message", (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());
      const k = parsed.k;
      client.send(
        JSON.stringify({
          type: "kline",
          symbol: binanceSymbol,
          data: {
            timestamp: Number(k.t),
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v),
            isFinal: Boolean(k.x),
          },
        })
      );
    } catch (_e) {}
  });
  upstream.on("error", () => {
    client.send(JSON.stringify({ type: "error", message: "Upstream stream error" }));
  });
  client.on("close", () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });
});

initDb().then(() => {
  ensureRootAdmin().catch((error) => {
    console.error("Failed to ensure root admin:", error);
  });
  if (DEMO_MODE) {
    seedDemoData()
      .then(() => console.log("Demo mode seed complete."))
      .catch((error) => console.error("Demo mode seed failed:", error));
  }
  server.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
});
