'use strict';
const os = require('os');

function getServerIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function getClientIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '').split(',')[0].trim();
  return raw.replace(/^::ffff:/i, '');
}

function ipToSubnet(ip, prefixLen = 24) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return parts.slice(0, 3).join('.');   // /24 — 取前三段
}

function isSameSubnet(ipA, ipB) {
  return ipToSubnet(ipA) === ipToSubnet(ipB);
}

function isValidIPv4(ip) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

module.exports = { getServerIP, getClientIp, ipToSubnet, isSameSubnet, isValidIPv4 };
