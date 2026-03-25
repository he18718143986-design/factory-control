'use strict';
/**
 * config/index.js — 集中配置管理
 * 优先读取环境变量，回退到默认值
 */

const path = require('path');
const fs   = require('fs');

// 尝试加载 .env 文件（开发时使用）
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  });
}

function parseCsv(input = '') {
  return String(input)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function parseTrustProxy(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return false;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  if (/^\d+$/.test(v)) return Number(v);
  return raw;
}

function parseBool(raw, fallback = false) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function defaultCsp() {
  return [
    "default-src 'self' data: blob:",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const config = {
  port:        Number(process.env.PORT) || 3000,
  nodeEnv:     process.env.NODE_ENV || 'development',
  isProd:      process.env.NODE_ENV === 'production',

  jwt: {
    secret:    process.env.JWT_SECRET || 'dev-secret-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  db: {
    path: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'factory.db'),
    autoMigrate: parseBool(process.env.DB_AUTO_MIGRATE, process.env.NODE_ENV !== 'production'),
  },

  superAdmin: {
    email:    process.env.SUPER_ADMIN_EMAIL || 'admin@factory.local',
    password: process.env.SUPER_ADMIN_PASSWORD || 'admin123456',
    name:     process.env.SUPER_ADMIN_NAME || '超级管理员',
  },

  pricing: {
    monthlyFen: Number(process.env.PRICE_MONTHLY_FEN) || 9900,   // 99.00 元
    yearlyFen:  Number(process.env.PRICE_YEARLY_FEN)  || 99900,  // 999.00 元
    trialDays:  Number(process.env.TRIAL_DAYS)        || 7,
  },

  subscription: {
    enableGracePeriod: parseBool(process.env.SUBSCRIPTION_ENABLE_GRACE_PERIOD, false),
    graceDays: Number(process.env.SUBSCRIPTION_GRACE_DAYS) || 3,
    allowIssueInGrace: parseBool(process.env.SUBSCRIPTION_ALLOW_ISSUE_IN_GRACE, false),
  },

  rebind: {
    highRiskScore: Math.max(0, Math.min(100, Number(process.env.REBIND_HIGH_RISK_SCORE) || 70)),
    minEvidenceForHighRisk: Math.max(0, Number(process.env.REBIND_HIGH_RISK_MIN_EVIDENCE_LEN) || 12),
  },

  payment: {
    alipay:     process.env.PAYMENT_ALIPAY_ACCOUNT || '',
    wechat:     process.env.PAYMENT_WECHAT_ID      || '',
    bankName:   process.env.PAYMENT_BANK_NAME      || '',
    bankAccount:process.env.PAYMENT_BANK_ACCOUNT   || '',
    bankHolder: process.env.PAYMENT_BANK_HOLDER    || '',
  },

  timing: {
    pairingTimeoutMs:  Number(process.env.PAIRING_TIMEOUT_MS)        || 10 * 60 * 1000,
    pairingExpireMs:   Number(process.env.PAIRING_EXPIRE_MS)         || 15 * 60 * 1000,
    waitingExpireMs:   30 * 60 * 1000,
    restrictedAlertMs: 12 * 60 * 60 * 1000,
    retryConnectMs:    Number(process.env.RETRY_CONNECT_COOLDOWN_MS) || 8000,
    lifecycleCheckMs:  60 * 1000,
    persistIntervalMs: 5 * 1000,
    sessionExitedCleanMs: 7 * 24 * 60 * 60 * 1000,
  },

  rateLimit: {
    checkin: {
      max: Number(process.env.CHECKIN_RATE_LIMIT_MAX) || 10,
      windowMs: Number(process.env.CHECKIN_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    },
    login: {
      max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 8,
      windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    },
    register: {
      max: Number(process.env.REGISTER_RATE_LIMIT_MAX) || 5,
      windowMs: Number(process.env.REGISTER_RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000,
    },
    adminWrite: {
      max: Number(process.env.ADMIN_WRITE_RATE_LIMIT_MAX) || 60,
      windowMs: Number(process.env.ADMIN_WRITE_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    },
    paymentReview: {
      max: Number(process.env.PAYMENT_REVIEW_RATE_LIMIT_MAX) || 20,
      windowMs: Number(process.env.PAYMENT_REVIEW_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    },
    rebindReview: {
      max: Number(process.env.REBIND_REVIEW_RATE_LIMIT_MAX) || 30,
      windowMs: Number(process.env.REBIND_REVIEW_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    },
  },

  http: {
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    allowedOrigins: parseCsv(process.env.ALLOWED_ORIGINS),
    enableHsts: String(process.env.ENABLE_HSTS || '').trim()
      ? ['true', '1', 'yes', 'on'].includes(String(process.env.ENABLE_HSTS).trim().toLowerCase())
      : process.env.NODE_ENV === 'production',
    hstsMaxAge: Number(process.env.HSTS_MAX_AGE || 31536000), // 1 year
  },

  security: {
    csp: process.env.CSP || defaultCsp(),
  },
};

module.exports = config;
