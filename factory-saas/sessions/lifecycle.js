'use strict';
const config = require('../config');
const { getSession, getSessions, setSession, markDirty } = require('./store');
const { serializeSession } = require('./serialize');
const { broadcastToSub } = require('../broadcast/ws');

const alertedSet = new Set();

function tick() {
  const now = Date.now();
  // Import here to avoid circular deps at module load time
  const { stmts } = require('../db');
  // iterate all subscription sessions
  const { db } = require('../db');
  const subs = db.prepare('SELECT DISTINCT subscription_id FROM visitor_sessions').all();

  subs.forEach(({ subscription_id: subId }) => {
    const sessions = getSessions(subId);
    for (const [id, session] of sessions) {
      const age = now - new Date(session.createdAt).getTime();

      // waiting 超时
      if (session.status === 'waiting' && age > config.timing.waitingExpireMs) {
        const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        session.status = 'error';
        session.logs.push(`[${ts}] ⏱️ 等待配对超时（${Math.round(config.timing.waitingExpireMs / 60000)} 分钟），自动过期`);
        markDirty();
        broadcastToSub(subId, { event: 'sessionUpdate', session: serializeSession(session) });
      }

      // pairing 超时
      if (session.status === 'pairing' && age > config.timing.pairingExpireMs) {
        const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        session.pairedNotConnectedReason = 'pairing_timeout';
        session.status = 'paired_not_connected';
        session.logs.push(`[${ts}] ⏱️ 配对流程超时，请重试连接`);
        markDirty();
        broadcastToSub(subId, { event: 'sessionUpdate', session: serializeSession(session) });
      }

      // restricted 超时告警
      if (session.status === 'restricted' && session.restrictedAt && !alertedSet.has(id)) {
        const restrictedAge = now - new Date(session.restrictedAt).getTime();
        if (restrictedAge > config.timing.restrictedAlertMs) {
          alertedSet.add(id);
          const hours = Math.round(restrictedAge / 3600000);
          broadcastToSub(subId, {
            event: 'sessionOverdue',
            sessionId: id,
            visitorName: session.visitorName,
            area: session.area,
            hours,
          });
        }
      }

      // exited 过期清理
      if (session.status === 'exited' && session.exitedAt) {
        const exitedAge = now - new Date(session.exitedAt).getTime();
        if (exitedAge > config.timing.sessionExitedCleanMs) {
          sessions.delete(id);
          require('./store').deleteSession(id);
          alertedSet.delete(id);
        }
      }
    }
  });

  // 清理数据库中过期已退出会话
  const cutoff = now - config.timing.sessionExitedCleanMs;
  db.prepare(`DELETE FROM visitor_sessions WHERE updated_at < ? AND json_extract(data, '$.status') = 'exited'`).run(cutoff);
}

let _timer = null;
function start() {
  if (_timer) return;
  _timer = setInterval(tick, config.timing.lifecycleCheckMs);
}

module.exports = { start };
