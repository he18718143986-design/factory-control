'use strict';
/**
 * middleware/subscription.js — 订阅验证 + WiFi IP 绑定检查
 */

const { stmts, isSubscriptionActive, refreshSubStatus } = require('../db');
const { getClientIp, ipToSubnet, isValidIPv4 } = require('../utils/network');

/**
 * 验证请求中的 subscriptionId 属于当前用户且仍有效
 * 读取 req.params.subId 或 req.body.subscriptionId
 * 验证通过后设置 req.subscription
 */
function requireActiveSubscription(req, res, next) {
  const subId = req.params.subId || req.body?.subscriptionId;
  if (!subId) return res.status(400).json({ error: 'MISSING_SUBSCRIPTION_ID' });

  const sub = stmts.getSubById.get(subId);
  if (!sub) return res.status(404).json({ error: 'SUBSCRIPTION_NOT_FOUND' });
  if (sub.user_id !== req.user.id && !req.user.is_super_admin) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  refreshSubStatus(sub);
  if (!isSubscriptionActive(sub)) {
    return res.status(402).json({
      error:  'SUBSCRIPTION_EXPIRED',
      status: sub.status,
      message: '订阅已过期，请续费后继续使用',
    });
  }

  req.subscription = sub;
  next();
}

/**
 * 访客 checkin 时验证 WiFi IP 绑定
 * 如果订阅已绑定 WiFi 子网，访客 IP 必须来自同一子网
 * 如果尚未绑定，自动绑定当前 IP（首次使用）
 */
function enforceIpBinding(req, res, next) {
  const sub       = req.subscription;
  const clientIp  = getClientIp(req);
  const isPrivate = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(clientIp);

  // 本地回环或非私有 IP（开发/特殊网络）直接放行
  if (!isPrivate || clientIp === '127.0.0.1') return next();

  const clientSubnet = ipToSubnet(clientIp);

  if (!sub.wifi_locked || !sub.wifi_subnet) {
    // 首次使用：自动绑定
    stmts.bindSubIp.run(clientSubnet, sub.id);
    sub.wifi_subnet = clientSubnet;
    sub.wifi_locked = 1;
    console.log(`[subscription] 自动绑定 WiFi 子网：${clientSubnet} → 订阅 ${sub.id.slice(0, 8)}`);
    return next();
  }

  if (clientSubnet !== sub.wifi_subnet) {
    return res.status(403).json({
      error:   'IP_BINDING_MISMATCH',
      message: `此订阅已绑定到 ${sub.wifi_subnet}.x 网络，当前请求来自 ${clientIp}，无法跨厂区使用`,
    });
  }

  next();
}

module.exports = { requireActiveSubscription, enforceIpBinding };
