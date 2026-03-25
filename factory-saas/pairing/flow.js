'use strict';
/**
 * pairing/flow.js — ADB 配对与设备连接业务逻辑
 */

const adbMgr = require('../adb');
const mdns   = require('../mdns');
const { getSession, setSession, markDirty } = require('../sessions/store');
const { serializeSession } = require('../sessions/serialize');
const { broadcast, broadcastToSub } = require('../broadcast/ws');
const config = require('../config');

function log(session, message, type = 'info') {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  session.logs.push(`[${ts}] ${message}`);
  if (session.logs.length > 200) session.logs = session.logs.slice(-200);
  markDirty();
  broadcast(session.id, { event: 'log', message, type });
  console.log(`[${session.id.slice(0, 8)}] ${message}`);
}

function setStatus(session, status, message) {
  session.status = status;
  markDirty();
  broadcast(session.id, { event: 'status', status, message });
}

function broadcastUpdate(session) {
  broadcastToSub(session.subscriptionId, { event: 'sessionUpdate', session: serializeSession(session) });
}

async function onDeviceConnected(sessionId, deviceId) {
  const session = getSession(sessionId);
  if (!session) return;
  if (!['waiting', 'pairing', 'paired_not_connected'].includes(session.status)) return;

  const prevStatus  = session.status;
  const isReconnect = session.pairedNotConnectedReason === 'device_disconnected';

  session.deviceId = deviceId;
  markDirty();
  log(session, '🔌 ADB 设备已就绪：' + deviceId);
  setStatus(session, 'pairing', isReconnect ? '⚙️ 断线重连成功，正在补发管控指令…' : '⚙️ ADB 已连接，正在下发管控指令…');

  const applyWarnings = [];
  const applyLogFn = (msg) => {
    log(session, msg);
    if (/DPM\/wm 截屏禁用不可用/.test(msg))  applyWarnings.push('截屏限制降级（settings 方式，部分 ROM 无效）');
    if (/无法设置 user-fixed/.test(msg))      applyWarnings.push('摄像头权限封锁降级（ROM 不支持 permission-flags）');
    if (/SystemUI 重启失败/.test(msg))        applyWarnings.push('控制中心截屏按钮需下拉一次后才消失');
  };

  try {
    await adbMgr.applyRestrictions(deviceId, applyLogFn);

    session.status       = 'restricted';
    session.restrictedAt = new Date();
    if (isReconnect) {
      session.pairedNotConnectedReason = '';
      log(session, '✅ 断线重连：管控已重新生效');
    }
    markDirty();
    setStatus(session, 'restricted', isReconnect ? '✅ 断线重连成功，管控已恢复！' : '✅ 管控已生效！');

    if (applyWarnings.length > 0) {
      const deduped = [...new Set(applyWarnings)];
      log(session, '⚠️ 管控降级提示：' + deduped.join('；'), 'error');
      broadcastToSub(session.subscriptionId, {
        event: 'restrictionDegraded',
        sessionId, visitorName: session.visitorName, area: session.area, warnings: deduped,
      });
    }

    log(session, '🔒 全部管控指令已下发');
    broadcastUpdate(session);
  } catch (err) {
    log(session, '❌ 管控指令失败：' + err.message, 'error');
    setStatus(session, 'error', '❌ 管控失败：' + err.message);
    broadcastUpdate(session);
  }
}

async function markPairedNotConnected(sessionId, reason) {
  const session = getSession(sessionId);
  if (!session || session.status === 'paired_not_connected') return;
  session.pairedNotConnectedReason = reason;
  markDirty();
  setStatus(session, 'paired_not_connected', '⚠️ 已配对但未连接，请重试连接');
  log(session, '⚠️ 已配对但未连接 (' + reason + ')', 'error');
  broadcastUpdate(session);
}

async function ensureConnectedOrMark(sessionId, deviceId, reason) {
  const resolved = await adbMgr.resolveDeviceSerial(deviceId);
  if (resolved) { await onDeviceConnected(sessionId, deviceId); return true; }
  await markPairedNotConnected(sessionId, reason);
  return false;
}

/**
 * 注册 mDNS 监听并处理完整配对流程（供 checkin 和 regenerate-pairing 复用）
 */
function registerPairingListener(sessionId, serviceName, password) {
  mdns.waitForPairing(serviceName, password, async (found) => {
    const session = getSession(sessionId);
    if (!session) return;

    if (!found) {
      log(session, '⏱️ 配对超时（10 分钟）', 'error');
      setStatus(session, 'error', '⏱️ 配对超时，请重新生成配对码');
      broadcastUpdate(session);
      return;
    }

    const { host, port } = found;
    log(session, `📡 手机广播 → ${host}:${port}，执行 adb pair…`);
    setStatus(session, 'pairing', '📡 已发现手机，正在建立 ADB 配对…');

    try {
      const pairResult = await adbMgr.pair(host, port, password);
      log(session, '🔑 ' + pairResult);
      const guidMatch = pairResult && pairResult.match(/guid=(adb-[^\]\s]+)/);
      const deviceId  = guidMatch ? guidMatch[1] : (host + ':5555');
      if (guidMatch) log(session, '🔌 设备 GUID：' + deviceId);

      if (guidMatch) {
        let resolved = null;
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setTimeout(r, 500));
          resolved = await adbMgr.resolveDeviceSerial(deviceId);
          if (resolved) break;
        }
        if (resolved) {
          log(session, '🔗 设备已就绪（配对后已在 adb 列表），直接下发管控');
          await onDeviceConnected(sessionId, deviceId);
        } else {
          mdns.waitForConnect(deviceId, async (conn) => {
            if (!conn) { await ensureConnectedOrMark(sessionId, deviceId, 'mdns_connect_missing'); return; }
            try {
              log(session, `🔗 设备上线 → adb connect ${conn.host}:${conn.port}`);
              await adbMgr.connect(conn.host, conn.port);
            } catch (e) {
              log(session, '⚠️ adb connect 失败：' + e.message, 'error');
              await ensureConnectedOrMark(sessionId, deviceId, 'adb_connect_failed');
              return;
            }
            await ensureConnectedOrMark(sessionId, deviceId, 'not_in_adb_devices');
          });
        }
      } else {
        await new Promise(r => setTimeout(r, 1200));
        await onDeviceConnected(sessionId, deviceId);
      }
    } catch (err) {
      const msg = err.message || '';
      log(session, '❌ ' + msg, 'error');
      const isExpired = msg.includes('protocol fault') || msg.includes("couldn't read status message");
      setStatus(session, 'error', isExpired ? '❌ 配对码过期，请重新生成' : '❌ 配对失败：' + msg);
      broadcastUpdate(session);
    }
  }, config.timing.pairingTimeoutMs);
}

module.exports = {
  log, setStatus, broadcastUpdate,
  onDeviceConnected, markPairedNotConnected, ensureConnectedOrMark, registerPairingListener,
};
