'use strict';

const {
  getSubscriptionLifecycleState,
  canIssueQr,
  canViewHistory,
  canSubmitPayment,
  canRequestNetworkRebind,
} = require('../db');

function assertCase(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`[FAIL] ${name}: expected=${expected}, actual=${actual}`);
  }
  console.log(`[PASS] ${name}: ${actual}`);
}

function makeSub(partial) {
  const now = Date.now();
  return {
    id: partial.id || 'test-sub',
    status: partial.status || 'trial',
    trial_ends_at: partial.trial_ends_at ?? (now + 86400000),
    paid_ends_at: partial.paid_ends_at ?? null,
    grace_ends_at: partial.grace_ends_at ?? null,
    ...partial,
  };
}

function run() {
  const now = Date.now();
  const graceOn = { enableGracePeriod: true, graceDays: 3, allowIssueInGrace: false };
  const graceIssueOn = { enableGracePeriod: true, graceDays: 3, allowIssueInGrace: true };
  const graceOff = { enableGracePeriod: false, graceDays: 3, allowIssueInGrace: false };

  // trial within window
  const trialLive = makeSub({ status: 'trial', trial_ends_at: now + 3600000 });
  assertCase('trial.lifecycle', getSubscriptionLifecycleState(trialLive, now, graceOff), 'trial');
  assertCase('trial.canIssue', canIssueQr(trialLive, graceOff), true);
  assertCase('trial.canPay', canSubmitPayment(trialLive), true);
  assertCase('trial.canRebind', canRequestNetworkRebind(trialLive), true);
  assertCase('trial.canHistory', canViewHistory(trialLive), true);

  // trial expired
  const trialExpired = makeSub({ status: 'trial', trial_ends_at: now - 1000 });
  assertCase('trialExpired.lifecycle', getSubscriptionLifecycleState(trialExpired, now, graceOff), 'expired');
  assertCase('trialExpired.canIssue', canIssueQr(trialExpired, graceOff), false);

  // active within paid window
  const activeLive = makeSub({ status: 'active', paid_ends_at: now + 86400000 });
  assertCase('active.lifecycle', getSubscriptionLifecycleState(activeLive, now, graceOn), 'active');
  assertCase('active.canIssue', canIssueQr(activeLive, graceOn), true);

  // active after paid window, grace off => expired
  const activeExpiredNoGrace = makeSub({ status: 'active', paid_ends_at: now - 1000 });
  assertCase('activeExpiredNoGrace.lifecycle', getSubscriptionLifecycleState(activeExpiredNoGrace, now, graceOff), 'expired');

  // active after paid window, grace on => grace
  const activeInGrace = makeSub({
    status: 'active',
    paid_ends_at: now - 3600000,
    grace_ends_at: now + 86400000,
  });
  assertCase('activeInGrace.lifecycle', getSubscriptionLifecycleState(activeInGrace, now, graceOn), 'grace');
  assertCase('activeInGrace.canIssue.default', canIssueQr(activeInGrace, graceOn), false);
  assertCase('activeInGrace.canIssue.enabled', canIssueQr(activeInGrace, graceIssueOn), true);

  // suspended
  const suspended = makeSub({ status: 'suspended', paid_ends_at: now + 86400000 });
  assertCase('suspended.lifecycle', getSubscriptionLifecycleState(suspended, now, graceOn), 'suspended');
  assertCase('suspended.canIssue', canIssueQr(suspended, graceIssueOn), false);
  assertCase('suspended.canPay', canSubmitPayment(suspended), false);
  assertCase('suspended.canRebind', canRequestNetworkRebind(suspended), false);
  assertCase('suspended.canHistory', canViewHistory(suspended), true);

  // cancelled
  const cancelled = makeSub({ status: 'cancelled', paid_ends_at: now + 86400000 });
  assertCase('cancelled.lifecycle', getSubscriptionLifecycleState(cancelled, now, graceOn), 'cancelled');
  assertCase('cancelled.canIssue', canIssueQr(cancelled, graceIssueOn), false);
  assertCase('cancelled.canPay', canSubmitPayment(cancelled), false);
  assertCase('cancelled.canRebind', canRequestNetworkRebind(cancelled), false);
  assertCase('cancelled.canHistory', canViewHistory(cancelled), true);

  console.log('\n[state-machine] all checks passed');
}

try {
  run();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
