/**
 * adb.js — ADB 管理模块
 *
 * ── 管控分两档，用开关控制 ──────────────────────────────────
 *
 * 档位 A：相机/录屏 APP（SUSPEND_PKGS）
 *   开关：ENABLE_SUSPEND_CAMERA
 *   true  → pm suspend + am force-stop（图标变灰，完全不可用）
 *   false → pm disable-user（兜底，效果更强但恢复风险更高）
 *
 * 档位 B：全量封锁所有用户 APP 的相机/录屏权限
 *   策略：appops deny（不撤销权限本身，恢复时无差别 allow）
 *   排除：com.factory.control（自身，扫码离厂需要相机）
 *   保留：系统 APP 不受影响（只操作 pm list packages -3 的第三方包）
 *
 * 截屏：优先尝试 dpm set-screen-capture-disabled（支持 DPM 的环境），
 *   失败则回退到 settings put policy_disable_screen_capture。
 */
'use strict';

const { exec, spawn } = require('child_process');

// ── 特性开关 ──────────────────────────────────────────────────

const ENABLE_SUSPEND_CAMERA = false;

// 本 APP 自身包名，封锁时排除，避免扫码离厂失效
const SELF_PKG = 'com.factory.control';

// ── 包名配置 / 全局常量（与 backend/factory_control.sh 保持一致） ─────────────

const SUSPEND_PKGS = [
  'com.android.camera2',
  'com.android.camera',
  'com.sec.android.app.camera',     // Samsung
  'com.huawei.camera',               // Huawei
  'com.miui.camera',                 // Xiaomi MIUI
  'com.miui.cameraserver',
  'com.oppo.camera',                 // OPPO
  'com.vivo.camera',                 // vivo
  'com.oneplus.camera',              // OnePlus
  'com.asus.camera',                 // ASUS
  'com.motorola.camera2',            // Motorola
  'com.hihonor.camera',              // 荣耀 Honor
  'com.hihonor.screenrecorder',
  'com.hihonor.HnMultiScreenShot',   // 荣耀多屏截图/截屏
  'com.hihonor.smartshot',           // 荣耀智能截屏（下拉栏截屏入口）
  'com.hihonor.screenshot',          // 荣耀部分机型截屏独立包
  'com.huawei.screenshot',           // 华为截屏
  'com.huawei.hicapture',            // 华为智慧识屏/截屏
  'com.hihonor.phone.recorder',
  'com.hihonor.soundrecorder',
  'com.android.screenrecord',
  'com.miui.screenrecorder',
  'com.sec.android.screenrecorder',
  'com.huawei.capture.recorder',
  'com.coloros.screenrecorder',      // OPPO ColorOS
  'com.vivo.screenshot',
];

/**
 * 强制额外管控的一组 App（与 factory_control.sh 中 FORCE_CAMERA_PKGS 保持一致）：
 * - 不依赖 dumpsys 是否显示 CAMERA granted=true
 * - 无论当前授权状态如何，都会在 apply 阶段额外执行一次撤销逻辑
 */
const FORCE_CAMERA_PKGS = [
  'com.tencent.mm',             // 微信
  'com.ss.android.ugc.aweme',   // 抖音
  'com.xunmeng.pinduoduo',      // 拼多多
  'com.xingin.xhs',             // 小红书
  'com.digitalgd.dgyss',        // 粤省事
  // 如需扩展更多强制管控 App，请在此追加包名，例如：
  // 'com.eg.android.AlipayGphone',   // 支付宝
  // 'com.taobao.taobao',             // 淘宝
];

// 设备端状态目录（与 factory_control.sh 相同）
const SAVE_DIR = '/data/local/tmp/factory_ctrl';

// 控制中心中需要移除的截屏/录屏相关 Tile 关键词
const TILE_REMOVE_KEYWORDS =
  'screenshot|screenrecord|recorder|screencap|capture';

// 撤销摄像头权限时跳过的包前缀（系统核心组件，与 factory_control.sh 一致）
const CAMERA_EXEMPT_PREFIXES = [
  'com.android.systemui',
  'com.android.phone',
  'com.android.contacts',
  'com.android.providers',
  'com.google.android.gms',
  'com.google.android.gsf',
  'android',
  SELF_PKG,
];

// ── ADB 基础工具 ──────────────────────────────────────────────

// dumpsys 输出很大，默认 exec maxBuffer（~1MB）容易溢出
const ADB_MAX_BUFFER = 20 * 1024 * 1024; // 20MB

function adb(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ADB 超时: adb ' + args)),
      timeoutMs
    );
    exec('adb ' + args, { maxBuffer: ADB_MAX_BUFFER }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) reject(new Error((stderr && stderr.trim()) || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── 通用工具：系统组件豁免 / 设备端状态存取 ────────────────────────

function isExemptPkg(pkg) {
  if (!pkg) return false;
  return CAMERA_EXEMPT_PREFIXES.some(
    (prefix) => pkg === prefix || pkg.startsWith(prefix + '.')
  );
}

async function saveState(s, key, value) {
  try {
    await adb(
      `${s} shell "mkdir -p ${SAVE_DIR} && printf '%s' '${value.replace(
        /'/g,
        "'\"'\"'"
      )}' > ${SAVE_DIR}/${key}"`,
      15000
    );
  } catch {
    // 状态保存失败不应影响整体管控
  }
}

async function loadState(s, key) {
  try {
    const out = await adb(
      `${s} shell "cat ${SAVE_DIR}/${key} 2>/dev/null"`,
      8000
    );
    return out.replace(/[\r\n]/g, '');
  } catch {
    return '';
  }
}

async function inspectStateFiles(s, logFn) {
  try {
    const out = await adb(
      `${s} shell "ls -l ${SAVE_DIR} 2>/dev/null || echo __STATE_DIR_MISSING__"`,
      10000
    );
    if ((out || '').includes('__STATE_DIR_MISSING__')) {
      logFn(`  ⚠️ 状态目录不存在：${SAVE_DIR}`);
      return;
    }
    logFn(`  🔎 状态目录检查：${SAVE_DIR}`);
    const lines = (out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const l of lines) logFn(`    ${l}`);
  } catch (e) {
    logFn(`  ⚠️ 状态目录检查失败：${e.message}`);
  }
}

async function discoverScreenshotTiles(s) {
  try {
    const tiles = await adb(
      `${s} shell settings get secure sysui_qs_tiles`,
      10000
    );
    const v = (tiles || '').replace(/\r/g, '').trim();
    if (!v || v === 'null') return [];
    const re = new RegExp(TILE_REMOVE_KEYWORDS, 'i');
    return v
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => re.test(t));
  } catch {
    return [];
  }
}

function removeTileToken(tilesCsv, token) {
  const list = (tilesCsv || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t !== token);
  return Array.from(new Set(list)).join(',');
}

// ── 档位 A：相机/录屏冻结 ────────────────────────────────────

// [FIX-3] 收窄正则，去掉单独的 recorder/capture 避免误匹配录音机等无关应用
const CAMERA_RECORDER_KEYWORDS = /camera|screenrecord|screen[\._]recorder|screenshot|screen[\._]capture|screen[\._]shot|screencapture/i;

async function getDeviceCameraRecorderPackages(adbSerial) {
  const out = await adb(adbSerial + ' shell pm list packages', 15000);
  const packages = [];
  const re = /^package:(.+)$/;
  for (const line of (out || '').split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (m && CAMERA_RECORDER_KEYWORDS.test(m[1])) packages.push(m[1]);
  }
  return packages;
}

async function freezeCameraPkg(s, pkg, logFn) {
  if (ENABLE_SUSPEND_CAMERA) {
    await adb(`${s} shell pm suspend ${pkg}`);
    await adb(`${s} shell am force-stop ${pkg}`);
    logFn(`  ✓ [suspend] ${pkg}`);
  } else {
    await adb(`${s} shell pm disable-user --user 0 ${pkg}`);
    logFn(`  ✓ [disable] ${pkg}`);
  }
}

async function unfreezeCameraPkg(s, pkg) {
  if (ENABLE_SUSPEND_CAMERA) {
    await adb(`${s} shell pm unsuspend ${pkg}`);
  } else {
    await adb(`${s} shell pm enable --user 0 ${pkg}`);
  }
}

// ── 档位 B：全量封锁所有用户 APP 的相机权限 ──────────────────

/**
 * 查询设备上所有持有 CAMERA 权限（granted=true）的「用户 APP」：
 * - 优先通过 dumpsys package 全量解析（与 factory_control.sh 思路一致）
 * - 仅返回第三方包（pm list packages -3），并排除 SELF_PKG
 */
async function getUserAppsWithCamera(s) {
  // 先拿到第三方包列表，作为过滤条件
  const listOut = await adb(`${s} shell pm list packages -3`, 15000);
  const userPkgs = new Set(
    (listOut || '')
      .split(/\r?\n/)
      .map(l => l.trim().match(/^package:(.+)$/)?.[1])
      .filter(Boolean)
      .filter(pkg => pkg !== SELF_PKG && !isExemptPkg(pkg))
  );

  // 先在设备端 grep 预过滤，显著降低返回量，避免 maxBuffer 溢出
  // 输出仅保留 “Package [..]” 与 “android.permission.CAMERA...” 两类行
  const dump = await adb(
    `${s} shell "dumpsys package 2>/dev/null | grep -E '^  Package \\[|android\\.permission\\.CAMERA'"`,
    30000
  );
  const result = new Set();
  let currentPkg = null;
  for (const lineRaw of (dump || '').split(/\r?\n/)) {
    const line = lineRaw.trim();
    const m = line.match(/^Package \[([^\]]+)]/);
    if (m) {
      currentPkg = m[1];
      continue;
    }
    if (!currentPkg) continue;
    if (
      /android\.permission\.CAMERA/.test(line) &&
      /granted=true/.test(line) &&
      userPkgs.has(currentPkg)
    ) {
      result.add(currentPkg);
    }
  }
  return Array.from(result);
}

/**
 * 查询单个包的 UID，用于 UID 级别 appops 管控（覆盖 system / shared UID 场景）。
 */
async function getAppUid(s, pkg) {
  try {
    const dump = await adb(
      `${s} shell dumpsys package '${pkg}' | grep 'userId=' | head -1`,
      8000
    );
    const m = dump.match(/userId=(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 封锁所有持有 CAMERA 权限的用户 APP（与 factory_control.sh 对齐的四层策略）：
 * - 层 1：pm revoke CAMERA
 * - 层 2：pm set-permission-flags user-fixed
 * - 层 3：appops set <pkg> CAMERA/PROJECT_MEDIA/TAKE_MEDIA_SCREENSHOTS deny
 * - 层 4：appops set --uid <uid> CAMERA deny（覆盖 system/shared UID）
 *
 * 目标集合 = dumpsys 发现的 CAMERA granted=true 的第三方 App
 *         ∪ FORCE_CAMERA_PKGS（强制列表，只要已安装，就必定管控）
 */
async function blockAllCameraAccess(s, logFn, preScannedTargets) {
  logFn('🔍 查询本机所有持有相机权限的应用…');

  let targets;
  if (preScannedTargets && preScannedTargets.length) {
    // 来自预扫描（与 factory_control.sh 的预扫描逻辑一致）
    targets = preScannedTargets.filter((pkg) => !isExemptPkg(pkg));
    logFn(`  预扫描得到 ${targets.length} 个需要管控的应用`);
  } else {
    try {
      const discovered = await getUserAppsWithCamera(s);
      const targetSet = new Set(discovered);

      // 强制列表：只要已安装且不是 SELF_PKG，就追加到目标集合
      for (const pkg of FORCE_CAMERA_PKGS) {
        if (!pkg || pkg === SELF_PKG) continue;
        try {
          const installed = await adb(
            `${s} shell pm list packages '${pkg}' 2>/dev/null | grep -q 'package:${pkg}$' && echo 1 || echo 0`,
            8000
          );
          if (installed.trim() === '1') targetSet.add(pkg);
        } catch {
          // 忽略检测失败，视为未安装
        }
      }

      targets = Array.from(targetSet);
      logFn(`  共检测到 ${targets.length} 个需要管控相机权限的应用`);
    } catch (e) {
      logFn('  ⚠️ 查询失败，跳过全量封锁：' + e.message);
      return;
    }
  }

  let blockedCount = 0;
  const blockedPkgs = [];
  for (const pkg of targets) {
    try {
      // 层 1：撤销运行时 CAMERA 权限
      await adb(`${s} shell pm revoke ${pkg} android.permission.CAMERA`);
      // 层 2：标记 user-fixed，防止用户在设置/弹窗中重新授权
      // 部分 ROM 不支持对 CAMERA 使用 permission-flags（会抛出 "specified flag ... is not one of [...]"），
      // 此时降级为仅 revoke + appops deny + force-stop，日志中会标出降级信息。
      try {
        await adb(
          `${s} shell pm set-permission-flags ${pkg} android.permission.CAMERA user-fixed`
        );
      } catch (e) {
        // 非致命：记录日志并继续后续 appops 封锁
        logFn(
          `  ⚠️ 无法设置 user-fixed（ROM 不支持 permission-flags）：${pkg} — ${e.message}`
        );
      }
      // 层 3：按包名 appops deny
      await adb(`${s} shell appops set ${pkg} CAMERA deny`);
      await adb(`${s} shell appops set ${pkg} PROJECT_MEDIA deny`);
      try {
        await adb(
          `${s} shell appops set ${pkg} TAKE_MEDIA_SCREENSHOTS deny`
        );
      } catch {}
      // 层 4：按 UID appops deny（覆盖 system/shared UID）
      const uid = await getAppUid(s, pkg);
      if (uid) {
        try {
          await adb(`${s} shell appops set --uid ${uid} CAMERA deny`);
        } catch {}
      }
      // 强制停止进程，使权限变更立即生效
      await adb(`${s} shell am force-stop ${pkg}`);
      logFn(`  ✓ 已封锁：${pkg}`);
      blockedCount++;
      blockedPkgs.push(pkg);
    } catch (e) {
      if (!isExpectedPkgError(e)) logFn(`  ⚠️ 封锁失败：${pkg} — ${e.message}`);
    }
  }
  logFn(`  📊 共封锁 ${blockedCount} 个应用`);
  return blockedPkgs;
}

/**
 * 恢复所有用户 APP 的相机权限。
 * - 先清除 user-fixed，再 pm grant，最后 appops allow（含 UID 级别）
 * - 目标集合 = 所有第三方包 ∪ FORCE_CAMERA_PKGS 中已安装的包
 * - pm grant 仅对在 Manifest 中声明了 CAMERA 的应用生效，其余静默忽略。
 */
async function restoreAllCameraAccess(s, logFn) {
  const revoked = await loadState(s, 'revoked_pkgs');
  logFn(`  🔎 revoked_pkgs 内容：${revoked || '（空）'}`);
  const targetPkgs = (revoked || '')
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);

  if (!targetPkgs.length) {
    await inspectStateFiles(s, logFn);
    logFn('  ⚠️ 未找到权限撤销记录，跳过恢复');
    return;
  }
  let restoreCount = 0;
  for (const pkg of targetPkgs) {
    try {
      // 尝试清除 user-fixed；部分 ROM 不支持 clear-permission-flags，这种情况视为降级而非致命错误。
      try {
        await adb(
          `${s} shell pm clear-permission-flags ${pkg} android.permission.CAMERA user-fixed`
        );
      } catch (e) {
        logFn(
          `  ⚠️ 无法清除 user-fixed（ROM 不支持 clear-permission-flags）：${pkg} — ${e.message}`
        );
      }
      // 无论是否成功清除 flag，都继续尝试 grant + appops allow，确保权限最大程度恢复。
      try {
        await adb(`${s} shell pm grant ${pkg} android.permission.CAMERA`);
      } catch {}
      await adb(`${s} shell appops set ${pkg} CAMERA allow`);
      await adb(`${s} shell appops set ${pkg} PROJECT_MEDIA allow`);
      try {
        await adb(
          `${s} shell appops set ${pkg} TAKE_MEDIA_SCREENSHOTS allow`
        );
      } catch {}
      const uid = await getAppUid(s, pkg);
      if (uid) {
        try {
          await adb(`${s} shell appops set --uid ${uid} CAMERA allow`);
        } catch {}
      }
      restoreCount++;
      logFn(`  ✓ 摄像头已恢复：${pkg}`);
    } catch (e) {
      logFn(`  ⚠️ 恢复失败：${pkg} — ${e.message}`);
    }
  }
  logFn(`  ✓ 共恢复 ${restoreCount} 个应用的相机权限`);
}

// ── 错误判断 ──────────────────────────────────────────────────

/**
 * [FIX-5] 判断是否为预期的「包不存在」错误，覆盖各 ROM/Android 版本的变体。
 * 这类错误属于正常情况（设备没装该包），不应记录为真实错误。
 */
function isExpectedPkgError(e) {
  if (!e || !e.message) return false;
  return (
    /Unknown package/i.test(e.message) ||
    /Package .* not installed/i.test(e.message) ||
    /Package .* is not installed/i.test(e.message) ||
    /Exception occurred while executing/i.test(e.message) ||
    /IllegalArgumentException.*Unknown package/i.test(e.message) ||
    /does not exist/i.test(e.message)
  );
}

// ── 设备序列解析 ──────────────────────────────────────────────

/**
 * [FIX-1] 精简后的设备序列解析：两步覆盖所有情况。
 */
async function resolveDeviceSerial(guid) {
  const out = await adb('devices');
  const ids = parseDevices(out);

  // 步骤 1：直接匹配（精确 / 带后缀 / 包含，一次覆盖）
  const match = ids.find(id => id.includes(guid));
  if (match) return match;

  // 步骤 2：从 adb-<serial>-<suffix> 中提取短序列号匹配
  const serial = guid.replace(/^adb-/, '').split('-')[0];
  if (serial) {
    const bySerial = ids.find(id =>
      id === serial ||
      id.startsWith(serial + '.') ||
      id.startsWith(serial + '_')
    );
    if (bySerial) return bySerial;
  }

  return null;
}

/**
 * [FIX-2] 公共函数：将 deviceId 解析为 adb -s 参数字符串。
 */
async function buildAdbSerial(deviceId, logFn) {
  if (!deviceId.startsWith('adb-')) return `-s ${deviceId}`;

  const resolved = await resolveDeviceSerial(deviceId);
  if (resolved) {
    if (resolved !== deviceId && logFn) logFn('🔌 使用设备序列：' + resolved);
    return `-s ${resolved}`;
  }

  if (logFn) logFn('⚠️ 未在 adb devices 中找到设备 ' + deviceId + '，仍尝试使用该 ID');
  return `-s ${deviceId}`;
}

// ── 对外接口 ──────────────────────────────────────────────────

/**
 * 下发所有管控指令
 * @param {string}   deviceId  GUID 或 "192.168.x.x:5555"
 * @param {function} logFn
 */
async function applyRestrictions(deviceId, logFn) {
  const s = await buildAdbSerial(deviceId, logFn);

  let firstError = null;

   // 预扫描：在任何 pm disable-user 之前抓取摄像头授权列表（与 factory_control.sh 一致）
  logFn('（预扫描：获取摄像头授权 App 列表，请稍候…）');
  let preScanCameraPkgs = [];
  try {
    const discovered = await getUserAppsWithCamera(s);
    // 预扫描阶段不引入 FORCE_CAMERA_PKGS，仅记录 dumpsys 真正 granted 的 App，
    // 强制列表在 blockAllCameraAccess 内部自动合并。
    preScanCameraPkgs = discovered.filter(
      (pkg) => pkg && !isExemptPkg(pkg)
    );
    if (preScanCameraPkgs.length) {
      logFn(
        '  预扫描发现 ' +
          preScanCameraPkgs.length +
          ' 个摄像头授权 App：' +
          preScanCameraPkgs.join('|')
      );
    } else {
      logFn('  预扫描未发现摄像头授权 App');
    }
  } catch (e) {
    logFn('  ⚠️ 预扫描摄像头授权 App 失败：' + e.message);
  }

  // 档位 A：冻结相机/录屏 APP（静态列表 + 动态扫描）
  logFn('📷 冻结相机/录屏应用…');
  let pkgsToFreeze = [...SUSPEND_PKGS];
  try {
    const devicePkgs = await getDeviceCameraRecorderPackages(s);
    if (devicePkgs.length) {
      pkgsToFreeze = [...new Set([...SUSPEND_PKGS, ...devicePkgs])];
      logFn('  📋 本机识别到 ' + devicePkgs.length + ' 个相机/录屏相关包，一并冻结');
    }
  } catch (_) {}

  // 记录原始状态快照，并仅对原本启用的包执行 disable-user（与 factory_control.sh 行为一致）
  const origStates = [];
  const disabledPkgs = [];
  for (const pkg of pkgsToFreeze) {
    try {
      const installed = await adb(
        `${s} shell "pm list packages '${pkg}' 2>/dev/null | grep -q 'package:${pkg}$' && echo 1 || echo 0"`,
        8000
      );
      if (installed.trim() !== '1') continue;

      const wasDisabled = await adb(
        `${s} shell "pm list packages -d '${pkg}' 2>/dev/null | grep -q 'package:${pkg}$' && echo 1 || echo 0"`,
        8000
      );
      const stateFlag = wasDisabled.trim() === '1' ? '1' : '0';
      origStates.push(`${pkg}:${stateFlag}`);

      if (stateFlag === '1') {
        logFn(`  ℹ️ [已禁用·跳过] ${pkg} (原始状态=禁用)`);
        continue;
      }

      await freezeCameraPkg(s, pkg, logFn);
      disabledPkgs.push(pkg);
    } catch (e) {
      if (!firstError && !isExpectedPkgError(e)) firstError = e;
    }
  }

  // 保存快照到设备端，供 removeRestrictions 精确还原
  if (origStates.length) {
    await saveState(s, 'pkg_orig_state', origStates.join('|'));
  }
  if (disabledPkgs.length) {
    await saveState(s, 'disabled_pkgs', disabledPkgs.join('|'));
  }

  // 保存原始截屏策略（与 factory_control.sh 对齐，remove 时精确还原）
  try {
    let origCapture = await adb(
      `${s} shell settings get global policy_disable_screen_capture`,
      8000
    );
    origCapture = (origCapture || '').replace(/\r/g, '').trim();
    if (!origCapture || origCapture === 'null') origCapture = '0';
    await saveState(s, 'orig_capture', origCapture);
    logFn(`🔎 原始 policy_disable_screen_capture = ${origCapture}`);
  } catch {}

  // 截屏策略：依次尝试 DPM → cmd device_policy → wm screen-capture → settings
  let screenCaptureDisabled = false;
  // 1) dpm（需设备管理员/Device Owner，多数非企业机不可用）
  try {
    await adb(`${s} shell dpm set-screen-capture-disabled --user current true`);
    screenCaptureDisabled = true;
    logFn('🖼️  DPM 截屏禁用已设置');
  } catch (e) {
    try {
      await adb(`${s} shell cmd device_policy set-screen-capture-disabled 0 true`);
      screenCaptureDisabled = true;
      logFn('🖼️  device_policy 截屏禁用已设置');
    } catch (e2) {
      // 2) wm screen-capture：第二参数 false = 禁止截屏（部分 AOSP/机型支持）
      try {
        await adb(`${s} shell wm screen-capture 0 false`);
        screenCaptureDisabled = true;
        logFn('🖼️  wm screen-capture 截屏禁用已设置');
      } catch (e3) {
        logFn('  ⚠️ DPM/wm 截屏禁用不可用，使用 settings 回退');
      }
    }
  }
  if (!screenCaptureDisabled) {
    try {
      await adb(`${s} shell settings put global policy_disable_screen_capture 1`);
      try { await adb(`${s} shell settings put secure policy_disable_screen_capture 1`); } catch (_) {}
      logFn('🖼️  系统截屏策略已设置（settings）');
      logFn('  ⚠️ 荣耀/华为等 ROM 可能不读取此配置，下拉控制中心截屏仍可能可用，属系统限制');
    } catch (e) {
      if (!firstError) firstError = e;
    }
  }

  // 档位 B：全量封锁所有用户 APP 的相机权限（使用预扫描结果，避免 pm disable 后 dumpsys 结构变化）
  const blockedPkgs = await blockAllCameraAccess(s, logFn, preScanCameraPkgs);
  if (blockedPkgs && blockedPkgs.length) {
    await saveState(s, 'revoked_pkgs', blockedPkgs.join('|'));
  }

  // 控制中心 Tile：备份原始值并移除截屏/录屏相关项（与 factory_control.sh 对齐）
  try {
    const origTilesRaw = await adb(`${s} shell settings get secure sysui_qs_tiles`, 10000);
    const origTiles = (origTilesRaw || '').replace(/\r/g, '').trim();
    if (origTiles && origTiles !== 'null') {
      await saveState(s, 'orig_tiles', origTiles);
      logFn('🔎 原始 tiles 已备份：' + origTiles);

      const tilesToRemove = await discoverScreenshotTiles(s);
      if (tilesToRemove.length) {
        let newTiles = origTiles;
        for (const t of tilesToRemove) {
          newTiles = removeTileToken(newTiles, t);
          logFn(`  ✓ [移除 Tile] ${t}`);
        }
        // 与 factory_control.sh 对齐：通过设备端文件中转，避免 custom(pkg/class) 中括号被 shell 解析
        await saveState(s, 'tiles_new', newTiles);
        await adb(
          `${s} shell "settings put secure sysui_qs_tiles \\"\\$(cat ${SAVE_DIR}/tiles_new)\\""`,
          10000
        );
        logFn('  ✓ 当前 tiles：' + newTiles);

        // 动态选择 SystemUI 包名并尝试重启
        try {
          const sysui = await adb(
            `${s} shell pm list packages | grep -i systemui | grep -v "overlay\\|navbar\\|gestural\\|threebutton\\|hide" | head -1 | sed 's/package://'`,
            10000
          );
          const sysuiPkg = (sysui || '').trim() || 'com.android.systemui';
          await adb(`${s} shell killall ${sysuiPkg}`, 8000);
          logFn(`  ✓ SystemUI (${sysuiPkg}) 已重启，控制中心立即生效`);
        } catch {
          logFn('  ⚠️ SystemUI 重启失败，下拉控制中心后生效');
        }
      } else {
        logFn('  ⚠️ 当前 tiles 中未发现截屏/录屏按钮，跳过');
      }
    } else {
      logFn('  ⚠️ 无法读取 sysui_qs_tiles，跳过');
    }
  } catch {
    logFn('  ⚠️ Tile 处理失败，跳过');
  }

  if (firstError) {
    logFn('⚠️ 部分命令未生效：' + firstError.message);
  }

  // 通知 APP 进入管控界面
  try {
    // 与 factory_control.sh 对齐的 UPDATE_STATUS 广播
    await adb(
      `${s} shell am broadcast -a com.factory.control.UPDATE_STATUS --es status restricted --include-stopped-packages`
    );
    // 兼容旧版 ACTION_RESTRICT
    try {
      await adb(
        `${s} shell am broadcast -a com.factory.control.ACTION_RESTRICT --include-stopped-packages`
      );
    } catch {}
    logFn('📲 管控广播已发送');
  } catch {}
}

/**
 * 解除所有管控
 * @param {string}   deviceId
 * @param {function} logFn
 */
async function removeRestrictions(deviceId, logFn) {
  const s = await buildAdbSerial(deviceId, logFn);

  // 解冻相机/录屏 APP（依据进厂时的原始状态快照，仅恢复原本启用的包）
  logFn('📷 恢复相机/录屏应用…');
  const origState = await loadState(s, 'pkg_orig_state');
  if (origState) {
    const entries = origState.split('|').filter(Boolean);
    for (const entry of entries) {
      const [pkg, flag] = entry.split(':');
      if (!pkg) continue;
      if (flag === '0') {
        try {
          await unfreezeCameraPkg(s, pkg);
          logFn(`  ✓ 已恢复：${pkg}`);
        } catch (e) {
          logFn(`  ⚠️ 恢复失败：${pkg} — ${e.message}`);
        }
      } else {
        logFn(`  ℹ️ [保持禁用] ${pkg}（进厂前已禁用，不恢复）`);
      }
    }
  } else {
    // 兼容无快照场景：退回到全量恢复
    let pkgsToUnfreeze = [...SUSPEND_PKGS];
    try {
      const devicePkgs = await getDeviceCameraRecorderPackages(s);
      if (devicePkgs.length) {
        pkgsToUnfreeze = [...new Set([...SUSPEND_PKGS, ...devicePkgs])];
      }
    } catch (_) {}

    for (const pkg of pkgsToUnfreeze) {
      try {
        await unfreezeCameraPkg(s, pkg);
        logFn(`  ✓ 已恢复：${pkg}`);
      } catch {}
    }
  }

  // 恢复截屏：与进厂顺序对应，逐项恢复（settings 按快照精确还原）
  try { await adb(`${s} shell dpm set-screen-capture-disabled --user current false`); } catch (_) {}
  try { await adb(`${s} shell cmd device_policy set-screen-capture-disabled 0 false`); } catch (_) {}
  try { await adb(`${s} shell wm screen-capture 0 true`); } catch (_) {}
  try {
    let origCapture = await loadState(s, 'orig_capture');
    origCapture = (origCapture || '').replace(/[^\d]/g, '') || '0';
    await adb(`${s} shell settings put global policy_disable_screen_capture ${origCapture}`);
    try {
      await adb(`${s} shell settings put secure policy_disable_screen_capture ${origCapture}`);
    } catch (_) {}
    logFn(`🖼️  截屏策略已恢复（policy_disable_screen_capture=${origCapture}）`);
  } catch (_) {}

  // 档位 B：恢复所有用户 APP 的相机权限
  logFn('🔓 恢复所有应用的相机/录屏权限…');
  await restoreAllCameraAccess(s, logFn);

  // 控制中心 Tile：按备份值精确还原（与 factory_control.sh 对齐）
  try {
    const origTiles = await loadState(s, 'orig_tiles');
    if (origTiles) {
      // 与 factory_control.sh 对齐：还原同样使用文件中转
      await saveState(s, 'tiles_restore', origTiles);
      await adb(
        `${s} shell "settings put secure sysui_qs_tiles \\"\\$(cat ${SAVE_DIR}/tiles_restore)\\""`,
        10000
      );
      logFn(`🧩 tiles 已精确还原：${origTiles}`);
    } else {
      logFn('⚠️ 未找到 tiles 备份，跳过还原');
    }
    try {
      await adb(`${s} shell killall com.android.systemui`, 8000);
    } catch {}
  } catch {
    logFn('⚠️ tiles 还原失败');
  }

  // 通知 APP 解除管控
  try {
    // 与 factory_control.sh 对齐的 UPDATE_STATUS 广播
    await adb(
      `${s} shell am broadcast -a com.factory.control.UPDATE_STATUS --es status exited --include-stopped-packages`
    );
    // 兼容旧版 ACTION_RELEASE
    try {
      await adb(
        `${s} shell am broadcast -a com.factory.control.ACTION_RELEASE --include-stopped-packages`
      );
    } catch {}
    logFn('📲 解除广播已发送');
  } catch {}

  // 关闭无线调试（与 factory_control.sh 一致，含降级方案）
  try {
    await adb(
      `${s} shell settings put global adb_wifi_enabled 0`,
      8000
    );
    logFn('📡 无线调试已关闭（ADB 连接可能会断开）');
  } catch (e) {
    try {
      // 方案 B：尝试关闭开发者模式开关
      await adb(`${s} shell settings put global development_settings_enabled 0`, 8000);
    } catch (_) {}
    try {
      // 方案 C：通过关闭 Wi-Fi 强制断开无线 ADB
      await adb(`${s} shell svc wifi disable`, 8000);
      logFn('📡 已通过关闭 WiFi 断开 ADB 连接（访客离开后可手动恢复 WiFi）');
    } catch (e2) {
      logFn(
        '⚠️ 无线调试关闭失败，请在开发者选项中手动关闭：' +
          (e2?.message || e.message)
      );
    }
  }

  // 清理设备端状态文件（与 factory_control.sh 对齐）
  try {
    await adb(`${s} shell rm -rf ${SAVE_DIR}`, 8000);
  } catch {}
}

// ── 设备连接管理 ──────────────────────────────────────────────

function parseDevices(output) {
  return output
    .split('\n')
    .slice(1)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('*') && l.includes('\t'))
    .filter(l => l.split('\t')[1]?.trim() === 'device')
    .map(l => l.split('\t')[0].trim());
}

let pollTimer = null;
let knownDevices = new Set();

function startPolling() {
  if (pollTimer) return;
  adb('devices')
    .then(out => {
      parseDevices(out).forEach(id => knownDevices.add(id));
      console.log('[ADB] 轮询启动，当前已知设备: ' + ([...knownDevices].join(', ') || '无'));
    })
    .catch(() => {});

  pollTimer = setInterval(async () => {
    try {
      const out     = await adb('devices');
      const current = new Set(parseDevices(out));
      for (const id of current) {
        if (!knownDevices.has(id)) {
          knownDevices.add(id);
          console.log('[ADB] 检测到新设备: ' + id);
        }
      }
      for (const id of knownDevices) {
        if (!current.has(id)) knownDevices.delete(id);
      }
    } catch {}
  }, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function pair(host, port, password) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('adb pair 超时')), 30000);
    const child = spawn('adb', ['pair', host + ':' + port], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output  = '';
    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', d => { output += d.toString(); });
    child.stdin.write(password + '\n', () => child.stdin.end());
    child.on('close', code => {
      clearTimeout(timer);
      const out = output.toLowerCase();
      if (out.includes('successfully paired') || out.includes('paired to')) {
        resolve(output.trim());
      } else if (code !== 0) {
        reject(new Error(output.trim() || 'exit code ' + code));
      } else {
        resolve(output.trim());
      }
    });
    child.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function connect(host, port = 5555) {
  return adb('connect ' + host + ':' + port, 15000);
}

/**
 * [FIX-4] 首次立即尝试，失败后再等待，去掉首次固定 2500ms 等待。
 */
function connectWithRetry(host, port = 5555, delayMs = 2500, maxAttempts = 4, retryIntervalMs = 2000) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    let lastErr;
    for (let i = 0; i < maxAttempts; i++) {
      if (i === 1) await sleep(delayMs);
      else if (i > 1) await sleep(retryIntervalMs);

      try {
        const out = await connect(host, port);
        if (out && (out.toLowerCase().includes('connected') || out.includes('already connected'))) {
          return out;
        }
        lastErr = new Error(out || 'connect 未返回成功');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  })();
}

async function disconnectDevice(deviceId) {
  try {
    await adb('disconnect ' + deviceId);
    knownDevices.delete(deviceId);
    console.log('[ADB] 已断开 ' + deviceId);
  } catch {}
}

// ── 导出 ──────────────────────────────────────────────────────

module.exports = {
  startPolling,
  stopPolling,
  pair,
  connect,
  connectWithRetry,
  resolveDeviceSerial,
  applyRestrictions,
  removeRestrictions,
  disconnectDevice,
};

/*
 * TODO：以下扩展项待在目标机型实测稳定后逐步启用
 *
 * 1. RECORD_AUDIO 管控（仅禁录音，不影响语音通话接听）
 *    进厂：appops set <pkg> RECORD_AUDIO deny
 *    离厂：appops set <pkg> RECORD_AUDIO allow
 *    风险：部分 ROM 上撤销后语音消息也会受影响，需实测
 *
 * 2. READ_MEDIA_IMAGES / READ_MEDIA_VIDEO（禁止转发本地照片/视频）
 *    进厂：appops set <pkg> READ_MEDIA_IMAGES deny
 *    离厂：appops set <pkg> READ_MEDIA_IMAGES allow
 *    风险：会影响从相册选图发送，需明确业务是否允许
 *
 * 3. ENABLE_SUSPEND_CAMERA 开关
 *    在目标机型上验证 pm unsuspend 恢复正常后，改为 true
 *    验证命令：adb shell pm suspend <pkg> && adb shell pm unsuspend <pkg>
 *             adb shell dumpsys package <pkg> | grep suspended
 */