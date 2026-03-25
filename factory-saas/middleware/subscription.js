'use strict';
/**
 * middleware/subscription.js — 订阅验证 + 厂区网络匹配
 */

const { stmts, canIssueQr, refreshSubStatus } = require('../db');
const { v4: uuidv4 } = require('uuid');
const { getClientIp, ipToSubnet, isValidIPv4 } = require('../utils/network');

function isPrivateIPv4(ip) {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
}

function cleanStr(v, max = 120) {
  return String(v || '').trim().slice(0, max);
}

function normalizeMac(v) {
  const s = cleanStr(v, 32).replace(/-/g, ':').toLowerCase();
  if (!s) return '';
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s)) return '';
  return s;
}

function extractRuntimeFingerprint(req) {
  const clientIp = getClientIp(req);
  const fromBody = req.body && typeof req.body === 'object' ? req.body.networkFingerprint : null;
  const fromQuery = req.query && typeof req.query === 'object' ? req.query : {};
  const source = cleanStr(
    (fromBody && fromBody.source)
      || req.get('x-network-source')
      || fromQuery.networkSource
      || 'request',
    40
  ) || 'request';

  const ssid = cleanStr(
    (fromBody && fromBody.ssid)
      || req.get('x-network-ssid')
      || fromQuery.networkSsid,
    80
  );
  const bssid = normalizeMac(
    (fromBody && fromBody.bssid)
      || req.get('x-network-bssid')
      || fromQuery.networkBssid
  );
  const gatewayIp = cleanStr(
    (fromBody && fromBody.gatewayIp)
      || req.get('x-network-gateway-ip')
      || fromQuery.networkGatewayIp,
    64
  );
  const gatewayMac = normalizeMac(
    (fromBody && fromBody.gatewayMac)
      || req.get('x-network-gateway-mac')
      || fromQuery.networkGatewayMac
  );
  const lanSubnet = cleanStr(
    (fromBody && (fromBody.lanSubnet || fromBody.subnet))
      || req.get('x-network-subnet')
      || fromQuery.networkSubnet
      || ipToSubnet(clientIp)
      || '',
    64
  );
  const confidenceRaw = Number(
    (fromBody && fromBody.confidence)
      || req.get('x-network-confidence')
      || fromQuery.networkConfidence
      || 0
  );
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
    : 0;

  return {
    clientIp,
    lanSubnet,
    ssid,
    bssid,
    gatewayIp,
    gatewayMac,
    confidence,
    source,
  };
}

function computeBindingMatch(binding, runtimeFp) {
  let score = 0;
  let hardMatched = false;

  if (binding.bssid && runtimeFp.bssid && binding.bssid.toLowerCase() === runtimeFp.bssid.toLowerCase()) {
    score += 80;
    hardMatched = true;
  }
  if (binding.gateway_mac && runtimeFp.gatewayMac && binding.gateway_mac.toLowerCase() === runtimeFp.gatewayMac.toLowerCase()) {
    score += 70;
    hardMatched = true;
  }
  if (binding.lan_subnet && runtimeFp.lanSubnet && binding.lan_subnet === runtimeFp.lanSubnet) {
    score += 40;
  }
  if (binding.ssid && runtimeFp.ssid && binding.ssid === runtimeFp.ssid) {
    score += 15;
  }

  const matched = hardMatched || score >= 40;
  return { matched, score };
}

function loadSiteSubscription(req, res) {
  const siteId = req.params.siteId || req.query.siteId || req.body?.siteId;
  if (!siteId) {
    res.status(400).json({ error: 'MISSING_SITE_ID' });
    return null;
  }

  const sub = stmts.getSubBySiteId.get(siteId);
  if (!sub) {
    res.status(404).json({ error: 'SUBSCRIPTION_NOT_FOUND' });
    return null;
  }
  if (sub.user_id !== req.user.id && !req.user.is_super_admin) {
    res.status(403).json({ error: 'FORBIDDEN' });
    return null;
  }
  refreshSubStatus(sub);

  req.subscription = sub;
  req.siteId = sub.site_id || null;
  return sub;
}

/**
 * 仅校验 site 访问权限，不限制业务能力（用于历史查看等读操作）
 */
function requireSiteAccess(req, res, next) {
  const sub = loadSiteSubscription(req, res);
  if (!sub) return;
  next();
}

/**
 * 校验当前是否允许发码（试用/有效订阅，grace 根据配置）
 */
function requireSiteIssueEligible(req, res, next) {
  const sub = loadSiteSubscription(req, res);
  if (!sub) return;

  if (!canIssueQr(sub)) {
    return res.status(402).json({
      error: 'SUBSCRIPTION_NOT_ELIGIBLE_FOR_ISSUE',
      status: sub.status,
      message: '当前订阅状态不允许生成新二维码，请续费或联系管理员',
    });
  }
  next();
}

/**
 * 核心网络匹配逻辑：site_id 下命中 active 网络绑定才允许
 * 兼容逻辑：若站点尚无绑定则自动写入当前 subnet；若 legacy wifi_subnet 存在则复用
 */
function checkNetworkBindingForSubscription(sub, req) {
  const runtimeFp = extractRuntimeFingerprint(req);
  const clientIp = runtimeFp.clientIp;

  if (clientIp === '127.0.0.1' || clientIp === '::1') return { ok: true };
  if (!isValidIPv4(clientIp)) return { ok: true };
  if (!isPrivateIPv4(clientIp)) return { ok: true };

  const clientSubnet = runtimeFp.lanSubnet || ipToSubnet(clientIp);
  if (!clientSubnet) return { ok: false, code: 'INVALID_CLIENT_NETWORK', status: 400 };
  runtimeFp.lanSubnet = clientSubnet;
  const now = Date.now();

  // 新链路：site_network_bindings
  if (sub.site_id) {
    const activeBindings = stmts.listActiveSiteBindings.all(sub.site_id);
    if (activeBindings.length === 0) {
      stmts.insertSiteBinding.run(
        uuidv4(),
        sub.site_id,
        clientSubnet,
        clientIp,
        runtimeFp.ssid,
        runtimeFp.bssid,
        runtimeFp.gatewayIp,
        runtimeFp.gatewayMac,
        runtimeFp.confidence || 60,
        runtimeFp.source || 'auto_bind',
        now,
        now,
        now,
        now
      );
      // 为了兼容旧接口，仍同步 legacy 字段
      stmts.bindSubIp.run(clientSubnet, sub.id);
      sub.wifi_subnet = clientSubnet;
      sub.wifi_locked = 1;
      return { ok: true };
    }

    let best = null;
    for (const binding of activeBindings) {
      const m = computeBindingMatch(binding, runtimeFp);
      if (!m.matched) continue;
      if (!best || m.score > best.score) {
        best = { binding, score: m.score };
      }
    }
    if (best) {
      stmts.touchSiteBindingSeenAt.run(now, now, best.binding.id);
      return { ok: true };
    }

    // 兜底兼容：仅按 subnet 命中（用于尚未上报 bssid/gateway 的浏览器场景）
    const bySubnet = stmts.getSiteBindingBySubnet.get(sub.site_id, clientSubnet);
    if (bySubnet) {
      stmts.touchSiteBindingSeenAt.run(now, now, bySubnet.id);
      return { ok: true };
    }

    return {
      ok: false,
      status: 403,
      code: 'NETWORK_NOT_ALLOWED',
      message: `当前网络(${clientIp})未命中厂区允许网络`,
    };
  }

  // 兜底：旧链路
  if (!sub.wifi_locked || !sub.wifi_subnet) {
    stmts.bindSubIp.run(clientSubnet, sub.id);
    sub.wifi_subnet = clientSubnet;
    sub.wifi_locked = 1;
    return { ok: true };
  }
  if (clientSubnet === sub.wifi_subnet) return { ok: true };

  return {
    ok: false,
    status: 403,
    code: 'IP_BINDING_MISMATCH',
    message: `此订阅已绑定到 ${sub.wifi_subnet}.x 网络，当前请求来自 ${clientIp}`,
  };
}

function enforceNetworkBinding(req, res, next) {
  const sub = req.subscription;
  if (!sub) return res.status(500).json({ error: 'SUBSCRIPTION_NOT_RESOLVED' });

  const result = checkNetworkBindingForSubscription(sub, req);
  if (!result.ok) {
    return res.status(result.status || 403).json({
      error: result.code || 'NETWORK_NOT_ALLOWED',
      message: result.message || '当前网络不允许该操作',
    });
  }

  next();
}

// 兼容旧命名
const enforceIpBinding = enforceNetworkBinding;
const requireActiveSubscription = requireSiteIssueEligible;

module.exports = {
  requireSiteAccess,
  requireSiteIssueEligible,
  requireActiveSubscription,
  enforceNetworkBinding,
  enforceIpBinding,
  checkNetworkBindingForSubscription,
};
