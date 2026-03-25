'use strict';

const config = require('../config');

class CookieClient {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeSetCookie(headers) {
    const raw = headers.get('set-cookie');
    if (!raw) return;
    const chunks = raw.split(/,(?=\s*[^;,]+=)/g);
    for (const chunk of chunks) {
      const first = chunk.split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const k = first.slice(0, eq).trim();
      const v = first.slice(eq + 1).trim();
      this.cookies.set(k, v);
    }
  }

  csrf() {
    return decodeURIComponent(this.cookies.get('csrf_token') || '');
  }

  async req(path, { method = 'GET', body, json = true, withCsrf = false } = {}) {
    const headers = {};
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (withCsrf) headers['X-CSRF-Token'] = this.csrf();
    if (body != null) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    this.storeSetCookie(res.headers);
    const payload = json ? await res.json().catch(() => null) : await res.text();
    return { status: res.status, body: payload };
  }
}

function assertPass(name, ok, detail) {
  if (!ok) {
    throw new Error(`[FAIL] ${name}: ${detail}`);
  }
  console.log(`[PASS] ${name}: ${detail}`);
}

async function run() {
  const base = `http://127.0.0.1:${config.port}`;
  const admin = new CookieClient(base);
  const user = new CookieClient(base);
  const now = Date.now();
  const email = `p12006_${now}@example.com`;
  const password = 'P12006pass!234';

  await user.req('/register', { json: false });
  const reg = await user.req('/api/auth/register', {
    method: 'POST',
    withCsrf: true,
    body: { email, password, name: 'P1-2-006 Test', areaName: 'P1-2-006 Site' },
  });
  assertPass('register', reg.status === 200 && reg.body?.success === true, `status=${reg.status}`);

  const sitesResp = await user.req('/api/sites');
  const firstSite = Array.isArray(sitesResp.body) ? sitesResp.body[0] : null;
  const siteId = firstSite?.id;
  const subId = firstSite?.subscription?.id;
  assertPass('site-created', !!siteId && !!subId, `siteId=${siteId}, subId=${subId}`);

  await admin.req('/login', { json: false });
  const login = await admin.req('/api/auth/login', {
    method: 'POST',
    withCsrf: true,
    body: { email: config.superAdmin.email, password: config.superAdmin.password },
  });
  assertPass('admin-login', login.status === 200 && login.body?.success === true, `status=${login.status}`);

  const suspend = await admin.req(`/api/admin/subscriptions/${subId}/suspend`, {
    method: 'POST',
    withCsrf: true,
  });
  assertPass('suspend', suspend.status === 200 && suspend.body?.status === 'suspended', `status=${suspend.status}`);

  const issueDenied = await user.req(`/api/checkin-qr?siteId=${encodeURIComponent(siteId)}`);
  assertPass(
    'issue-denied-after-suspend',
    issueDenied.status === 402 && issueDenied.body?.error === 'SUBSCRIPTION_NOT_ELIGIBLE_FOR_ISSUE',
    `status=${issueDenied.status}, error=${issueDenied.body?.error}`
  );

  const resume = await admin.req(`/api/admin/subscriptions/${subId}/resume`, {
    method: 'POST',
    withCsrf: true,
  });
  assertPass(
    'resume',
    resume.status === 200 && ['trial', 'active', 'grace', 'expired'].includes(resume.body?.status),
    `status=${resume.status}, to=${resume.body?.status}`
  );

  const resumedStatus = resume.body?.status;
  const issueAfterResume = await user.req(`/api/checkin-qr?siteId=${encodeURIComponent(siteId)}`);
  if (resumedStatus === 'expired') {
    assertPass(
      'issue-after-resume-expired',
      issueAfterResume.status === 402,
      `status=${issueAfterResume.status}`
    );
  } else {
    assertPass(
      'issue-after-resume-non-expired',
      issueAfterResume.status === 200,
      `status=${issueAfterResume.status}`
    );
  }

  const suspendedLogs = await admin.req('/api/admin/audit-logs?action=SUBSCRIPTION_SUSPENDED&limit=20');
  const resumedLogs = await admin.req('/api/admin/audit-logs?action=SUBSCRIPTION_RESUMED&limit=20');
  const hasSuspendLog = Array.isArray(suspendedLogs.body?.items)
    && suspendedLogs.body.items.some(i => i.target_id === subId);
  const hasResumeLog = Array.isArray(resumedLogs.body?.items)
    && resumedLogs.body.items.some(i => i.target_id === subId);

  assertPass('audit-suspended', hasSuspendLog, `items=${suspendedLogs.body?.items?.length || 0}`);
  assertPass('audit-resumed', hasResumeLog, `items=${resumedLogs.body?.items?.length || 0}`);

  console.log('\n[p1-2-006] manual gate checks passed');
  console.log(JSON.stringify({
    siteId,
    subId,
    resumedStatus,
    suspendStatus: suspend.body?.status,
  }));
}

run().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
