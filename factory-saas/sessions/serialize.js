'use strict';

function serializeSession(s) {
  return {
    id:                       s.id,
    subscriptionId:           s.subscriptionId,
    visitorName:              s.visitorName,
    visitorCompany:           s.visitorCompany || '',
    area:                     s.area,
    wifiSsid:                 s.wifiSsid || '',
    status:                   s.status,
    deviceId:                 s.deviceId   || null,
    deviceIp:                 s.deviceIp   || null,
    createdAt:                s.createdAt,
    restrictedAt:             s.restrictedAt || null,
    exitedAt:                 s.exitedAt   || null,
    logs:                     s.logs       || [],
    entryQR:                  s.entryQR    || '',
    exitQR:                   s.exitQR     || '',
    selfCheckin:              !!s.selfCheckin,
    recoverPairingEnabled:    !!s.recoverPairingEnabled,
    recoverPairingEnabledUntil: s.recoverPairingEnabledUntil || null,
    pairedNotConnectedReason: s.pairedNotConnectedReason || '',
    tamperDetected:           !!s.tamperDetected,
    tamperDetails:            Array.isArray(s.tamperDetails) ? s.tamperDetails : [],
  };
}

function normalizeLoadedSession(raw) {
  if (!raw || !raw.id) return null;
  const s = { ...raw };
  if (s.createdAt)    s.createdAt    = new Date(s.createdAt);
  if (s.restrictedAt) s.restrictedAt = new Date(s.restrictedAt);
  if (s.exitedAt)     s.exitedAt     = new Date(s.exitedAt);
  if (!Array.isArray(s.logs)) s.logs = [];
  return s;
}

module.exports = { serializeSession, normalizeLoadedSession };
