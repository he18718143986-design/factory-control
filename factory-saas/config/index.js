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
    max:    Number(process.env.CHECKIN_RATE_LIMIT_MAX) || 10,
    windowMs: 60 * 1000,
  },
};

module.exports = config;
