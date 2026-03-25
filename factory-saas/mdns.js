/**
 * mdns.js — mDNS 服务模块
 *
 * 职责一：广播 _factory-control._tcp
 *   让 APP 启动后能自动发现服务器的 IP 和端口。
 *
 * 职责二：监听 _adb-tls-pairing._tcp（方向已修正）
 *
 *   之前的错误做法：
 *      服务器广播 _adb-tls-pairing._tcp，等待手机来连接。
 *      手机连上后期望 SPAKE2 握手，但 Node.js 无法处理该协议，永远转圈。
 *
 *   正确做法（符合 AOSP 协议）：
 *      1. 服务器生成随机 serviceName + password，渲染成二维码展示给访客
 *         二维码格式：WIFI:T:ADB;S:<serviceName>;P:<password>;;
 *      2. 访客用手机「无线调试 → 使用二维码配对」扫码
 *      3. 手机解析二维码，在本机启动配对服务，并通过 mDNS 广播：
 *         _adb-tls-pairing._tcp  name=<serviceName>  port=<随机端口>
 *      4. 本模块持续监听局域网内的 _adb-tls-pairing._tcp 广播
 *      5. 发现 serviceName 匹配时，通知 server.js 执行：
 *         adb pair <手机IP>:<手机端口> <password>
 *      6. 本机 ADB Server 接管，完成 SPAKE2 + TLS 握手
 *
 *   关键点：SPAKE2 握手始终由本机 adb start-server 完成，
 *           Node.js 只负责"发现触发"，不参与加密协议本身。
 *
 * 参考：
 *   AOSP packages/modules/adb/daemon/mdns.cpp
 *   github.com/Swind/adb-wifi-py
 */

'use strict';

const { Bonjour } = require('bonjour-service');
const crypto      = require('crypto');

const bonjour = new Bonjour();

// ── 职责一：广播服务器 ────────────────────────────────────────

/**
 * 广播工厂控制服务器，让 APP 能自动发现服务器 IP/端口
 * @param {number} httpPort
 */
function advertiseControlServer(httpPort) {
  bonjour.publish({
    name:     'FactoryControlServer',
    type:     'factory-control',
    protocol: 'tcp',
    port:     httpPort,
    txt:      { httpPort: String(httpPort) },
  });
  console.log('[mDNS] 广播 _factory-control._tcp  端口=' + httpPort);
}

// ── 职责二：生成配对凭证 + 监听手机广播 ──────────────────────

/**
 * 为一个会话生成随机配对凭证。
 * 调用方负责把 qrContent 渲染成二维码展示给访客。
 *
 * @returns {{ serviceName: string, password: string, qrContent: string }}
 */
function generatePairingCredentials() {
  const serviceName = 'studio-' + crypto.randomBytes(6).toString('hex');
  const password    = crypto.randomInt(100000, 1000000).toString();
  const qrContent   = 'WIFI:T:ADB;S:' + serviceName + ';P:' + password + ';;';
  return { serviceName, password, qrContent };
}

// ── 监听器 ────────────────────────────────────────────────────

/**
 * 活跃的配对等待表
 * key:   serviceName（二维码中的 S= 字段）
 * value: { password, callback, timer }
 * @type {Map<string, { password: string, callback: Function, timer: any }>}
 */
const pendingPairings = new Map();

/**
 * 活跃的“等待设备上线”表（用于 _adb-tls-connect._tcp）
 * key:   guid（如 adb-AHXVCP4316200159-qQFy1D）
 * value: { callback, timer }
 * @type {Map<string, { callback: Function, timer: any }>}
 */
const pendingConnects = new Map();

/** 全局 mDNS 浏览器，服务启动时创建一次 */
let pairingBrowser  = null;
let connectBrowser  = null;

/**
 * 启动对 _adb-tls-pairing._tcp 和 _adb-tls-connect._tcp 的持续监听。
 * 服务启动时调用一次即可，之后自动处理所有配对 / 连接事件。
 */
function startPairingListener() {
  if (!pairingBrowser) {
    pairingBrowser = bonjour.find({ type: 'adb-tls-pairing' }, function(service) {
      onPairingServiceFound(service);
    });
    console.log('[mDNS] 开始监听 _adb-tls-pairing._tcp（等待手机扫码广播）');
  }

  if (!connectBrowser) {
    // 监听 TLS 连接服务，用于在配对成功后自动发现正确的 connect 端口
    connectBrowser = bonjour.find({ type: 'adb-tls-connect' }, function(service) {
      onConnectServiceFound(service);
    });
    console.log('[mDNS] 开始监听 _adb-tls-connect._tcp（等待设备上线）');
  }
}

/**
 * 手机扫描二维码后在局域网广播 _adb-tls-pairing._tcp，此函数处理该事件
 * @param {object} service  bonjour service 对象
 */
function onPairingServiceFound(service) {
  var name = service.name;
  console.log('[mDNS] 发现配对广播：' + name + '  ' + service.host + ':' + service.port);

  if (!pendingPairings.has(name)) {
    console.log('[mDNS] 未找到匹配会话，忽略');
    return;
  }

  var entry = pendingPairings.get(name);
  clearTimeout(entry.timer);
  pendingPairings.delete(name);

  // bonjour 有时返回 .local 主机名，优先从 addresses 取 IPv4；若无 IPv4，则保留 .local 交给系统解析
  var host = service.host;
  if (service.addresses && service.addresses.length) {
    var ipv4 = service.addresses.find(function(a) {
      return /^\d+\.\d+\.\d+\.\d+$/.test(a);
    });
    if (ipv4) host = ipv4;
  }

  console.log('[mDNS] 匹配成功 → adb pair ' + host + ':' + service.port);
  entry.callback({ host: host, port: service.port, password: entry.password });
}

/**
 * 处理 _adb-tls-connect._tcp：设备在无线调试真正“上线”时广播
 * 名称通常形如 adb-<serial>-<suffix>[.local]，我们仅关心前半段 GUID
 * @param {object} service
 */
function onConnectServiceFound(service) {
  var name = service.name; // 例如 adb-AHXVCP4316200159-qQFy1D._adb-tls-connect._tcp
  console.log('[mDNS] 发现设备上线广播：' + name + '  ' + service.host + ':' + service.port);

  if (pendingConnects.size === 0) return;

  // 去掉可能的 .local 后缀，仅保留 instance 名称部分
  var instance = name.replace(/\.local\.?$/, '');

  // guid 精确或前缀匹配（有的实现会在 GUID 后再拼一段后缀）
  var matchedGuid = null;
  pendingConnects.forEach(function(entry, guid) {
    if (instance === guid || instance.indexOf(guid + '.') === 0 || instance.indexOf(guid + '_') === 0) {
      matchedGuid = guid;
    }
  });
  if (!matchedGuid) {
    console.log('[mDNS] 未找到匹配的 GUID 监听，忽略');
    return;
  }

  var entry = pendingConnects.get(matchedGuid);
  clearTimeout(entry.timer);
  pendingConnects.delete(matchedGuid);

  // bonjour 有时返回 .local 主机名，优先从 addresses 取 IPv4；若无 IPv4，则保留 .local 交给系统解析
  var host = service.host;
  if (service.addresses && service.addresses.length) {
    var ipv4 = service.addresses.find(function(a) {
      return /^\d+\.\d+\.\d+\.\d+$/.test(a);
    });
    if (ipv4) host = ipv4;
  }

  console.log('[mDNS] 匹配成功 → adb connect ' + host + ':' + service.port + '（GUID=' + matchedGuid + '）');
  entry.callback({ host: host, port: service.port });
}

/**
 * 注册一个配对等待：当 serviceName 出现在 mDNS 广播中时触发 callback
 *
 * @param {string}   serviceName
 * @param {string}   password
 * @param {Function} callback     - ({ host, port, password }) => void，超时时传 null
 * @param {number}   [timeoutMs]  - 默认 5 分钟
 */
function waitForPairing(serviceName, password, callback, timeoutMs) {
  timeoutMs = timeoutMs || 5 * 60 * 1000;

  var timer = setTimeout(function() {
    if (pendingPairings.has(serviceName)) {
      pendingPairings.delete(serviceName);
      console.log('[mDNS] 配对等待超时：' + serviceName);
      callback(null);
    }
  }, timeoutMs);

  pendingPairings.set(serviceName, { password: password, callback: callback, timer: timer });
  console.log('[mDNS] 等待手机广播：' + serviceName);
}

/**
 * 注册一个“等待设备上线”：当对应 GUID 的 _adb-tls-connect._tcp 出现时触发 callback
 *
 * @param {string}   guid
 * @param {Function} callback     - ({ host, port }) => void，超时时传 null
 * @param {number}   [timeoutMs]  - 默认 10 秒
 */
function waitForConnect(guid, callback, timeoutMs) {
  timeoutMs = timeoutMs || 10 * 1000;

  var timer = setTimeout(function() {
    if (pendingConnects.has(guid)) {
      pendingConnects.delete(guid);
      console.log('[mDNS] 设备上线等待超时：' + guid);
      callback(null);
    }
  }, timeoutMs);

  pendingConnects.set(guid, { callback: callback, timer: timer });
  console.log('[mDNS] 等待设备上线（_adb-tls-connect）GUID=' + guid);
}

/**
 * 取消一个配对等待
 * @param {string} serviceName
 */
function cancelPairing(serviceName) {
  var entry = pendingPairings.get(serviceName);
  if (entry) {
    clearTimeout(entry.timer);
    pendingPairings.delete(serviceName);
    console.log('[mDNS] 已取消配对等待：' + serviceName);
  }
}

function shutdown() {
  bonjour.destroy();
}

module.exports = {
  advertiseControlServer,
  startPairingListener,
  generatePairingCredentials,
  waitForPairing,
   waitForConnect,
  cancelPairing,
  shutdown,
};
