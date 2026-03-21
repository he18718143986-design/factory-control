# 厂区访客管控系统 — 全场景改进总结

> 基于访客生命周期 8 个阶段、107 个场景的穷举分析，本文档记录所有已实施和待实施的改进。

---

## 一、已通过代码实施的改进

### 1. 会话生命周期管理（P0）

**问题**：原系统无会话过期机制，`waiting` 状态会话永远留在列表中；访客不扫离厂码直接离开时手机永久冻结，门卫无感知。

**改进**：

| 规则 | 默认值 | 环境变量 |
|------|--------|----------|
| `waiting` 超时自动过期 | 30 分钟 | `SESSION_WAITING_EXPIRE_MS` |
| `restricted` 超时告警 | 12 小时 | `SESSION_RESTRICTED_ALERT_MS` |
| `error` 自动清理 | 24 小时 | `SESSION_ERROR_CLEANUP_MS` |
| `exited` 自动清理 | 7 天 | `SESSION_EXITED_CLEANUP_MS` |
| 检查间隔 | 60 秒 | `SESSION_LIFECYCLE_CHECK_MS` |

- `waiting` 超时 → 自动设为 `error`，广播 `sessionUpdate`
- `restricted` 超时 → 仅告警不自动解除（避免访客仍在厂区时误解除），管理后台弹 `sessionOverdue` 告警
- `error` / `exited` → 到期后从内存和数据库中清理

### 2. ADB 断连告警（P0）

**问题**：管控中访客断开 WiFi/无线调试时，门卫无感知。

**改进**：
- `adb.js` 新增 `setOnDeviceLost()` 回调
- `server.js` 关联 `restricted` 会话，广播 `deviceDisconnected` 事件
- `admin.html` 弹出红色告警卡片 + 蜂鸣声

### 3. 离厂前管控完整性验证（P0）

**问题**：离厂时无法检测管控是否被篡改。

**改进**：
- `adb.js` 新增 `verifyRestrictions()`，检查三项：相机冻结 / appops / 截屏策略
- `server.js` 在 `exit` 和 `force-exit` 接口调用，篡改时记录 `tamperDetected` + 广播 `tamperAlert`

### 4. ADB 版本检查（P1）

**问题**：ADB 版本 < 30 无法支持无线调试，但启动时不检查。

**改进**：启动时执行 `adb version`，版本低于 1.0.30 时输出警告。ADB 不可用时提示但不阻止启动。

### 5. 端口冲突处理（P1）

**问题**：端口被占用时 `server.listen()` 抛异常，错误信息不友好。

**改进**：监听 `server.on('error')` 事件，`EADDRINUSE` 时输出排查命令后优雅退出。

### 6. 频率限制（P1）

**问题**：`/api/checkin` 无频率限制，同网段可批量创建会话。

**改进**：
- 内存计数器 `rateLimitMap`（IP → count + resetAt）
- 每 IP 每分钟最多 10 次（`CHECKIN_RATE_LIMIT_MAX` 可配置）
- 超限返回 429
- 定期清理过期条目

### 7. 输入校验（P1）

**问题**：访客姓名/公司/区域无长度限制。

**改进**：
| 字段 | 最大长度 |
|------|----------|
| 姓名 | 50 字符 |
| 公司 | 100 字符 |
| 区域 | 50 字符 |

同时限制请求体大小为 100KB（`express.json({ limit: '100kb' })`）。

### 8. IP 变更检测 + 入场码自动刷新（P2）

**问题**：DHCP 重新分配 IP 后，入场码中的地址失效。

**改进**：每 30 秒检测服务器 IP，变化时自动重新生成入场二维码并输出日志。

### 9. Android 13+ 无障碍引导（P1）

**问题**：Android 13+ 侧载 APP 的无障碍服务被标记为"受限设置"，用户不知如何开启。

**改进**：
- 检测 API 33+，显示分步引导文案
- 新增"解除受限设置"按钮，跳转应用信息页
- Toast 提示操作路径

---

## 二、需要运维/部署层面解决的改进

### 10. APK 下载文件缺失（P0）

**问题**：`welcome-bridge.html` 中下载链接指向 `/factory-control.apk`，但 `public/` 目录中无此文件。

**解决**：将编译好的 APK 放入 `backend/public/factory-control.apk`，或修改下载链接指向实际托管地址。

### 11. HTTPS 加密（P2）

**问题**：全链路 HTTP 明文传输，admin token、会话数据、二维码均可被嗅探。

**解决**：
- 方案 A：在 Node.js 前加 nginx 反向代理 + Let's Encrypt 证书
- 方案 B：使用 `https` 模块 + 自签名证书（局域网场景可接受）

### 12. 固定 IP / 域名

**问题**：服务器使用 DHCP 动态 IP，重启后已打印的物理入场码失效。

**解决**：
- 配置服务器静态 IP（推荐）
- 或使用局域网 DNS 解析（如 `factory.local`）

### 13. Wi-Fi AP 隔离

**问题**：企业级 AP 的 client isolation 会阻断 mDNS 和 ADB 连接。

**解决**：确保管控服务器和访客手机处于同一 VLAN，AP 配置中关闭客户端隔离。

---

## 三、需要 APP 端改进的项（Kotlin）

### 14. 电池优化引导（P2）

**问题**：华为/小米等激进后台杀策略可能导致 `ControlService` 不重启。

**建议**：在首次设置时引导用户为 APP 设置"电池不受限"：
```kotlin
val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
intent.data = Uri.parse("package:$packageName")
startActivity(intent)
```

### 15. iOS 检测与引导（P2）

**问题**：iOS 访客无法使用本系统，但代码中无检测/引导。

**建议**：在 `welcome.html` 页面中增加 UA 检测：
```javascript
if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  // 显示提示：iOS 设备请联系门卫使用物理管控措施
}
```

### 16. 管控界面增强提示（P1）

**问题**：管控状态（RESTRICTED）界面缺少威慑性提示。

**建议**：在 `tvRestrictedMsg` 中增加：
```
⚠️ 管控期间请勿关闭本应用或 WiFi
如手机功能异常需到门卫处恢复
离场时请扫描离场码，系统将自动恢复所有手机功能
```

---

## 四、需要物理/流程层面解决的改进

### 17. 第二部手机管控（P1）

**问题**：系统只管控已配对手机，访客可能携带第二部手机。

**建议**：门口设置手机检测/登记流程，要求访客声明并登记所有随身电子设备。

### 18. 独立相机/录音笔（P2）

**问题**：软件无法管控非手机类拍摄设备。

**建议**：配合安检（金属探测器 + 目视检查），禁止携带独立相机/录音笔等设备入厂。

### 19. USB ADB 恢复风险（P2）

**问题**：技术型访客可通过 USB 连接笔记本电脑恢复被冻结的 APP。

**建议**：
- 禁止访客携带笔记本电脑进入管控区域
- 或在管控下发时同时执行 `settings put global adb_enabled 0` 关闭 USB 调试

### 20. 访客不扫码直接离开的应急方案

**问题**：访客手机相机被永久冻结，需要返回厂区处理。

**建议**：
- 会话超时告警（已实施，12 小时后告警门卫）
- 门卫下班前检查仍处于 `restricted` 状态的会话
- 提供远程恢复热线：访客拨打门卫电话 → 门卫在后台执行"强制离厂"→ 访客重新连接厂区 WiFi → ADB 重连后自动恢复
- 极端情况：指导访客通过设置恢复出厂设置

---

## 五、改进实施状态汇总

| # | 改进项 | 优先级 | 状态 | 实施方式 |
|---|--------|:---:|:---:|----------|
| 1 | 会话生命周期管理 | P0 | ✅ | server.js 代码 |
| 2 | ADB 断连告警 | P0 | ✅ | adb.js + server.js + admin.html |
| 3 | 离厂前完整性验证 | P0 | ✅ | adb.js + server.js + admin.html |
| 4 | ADB 版本检查 | P1 | ✅ | server.js 代码 |
| 5 | 端口冲突处理 | P1 | ✅ | server.js 代码 |
| 6 | 频率限制 | P1 | ✅ | server.js 代码 |
| 7 | 输入校验 | P1 | ✅ | server.js 代码 |
| 8 | IP 变更 + QR 刷新 | P2 | ✅ | server.js 代码 |
| 9 | Android 13+ 引导 | P1 | ✅ | MainActivity.kt + XML |
| 10 | APK 文件缺失 | P0 | 📋 | 需部署操作 |
| 11 | HTTPS 加密 | P2 | 📋 | 需部署 nginx/证书 |
| 12 | 固定 IP | P2 | 📋 | 需网络配置 |
| 13 | AP 隔离 | P2 | 📋 | 需网络配置 |
| 14 | 电池优化引导 | P2 | 📋 | 需 APP 端开发 |
| 15 | iOS 检测引导 | P2 | 📋 | 需前端开发 |
| 16 | 管控界面增强提示 | P1 | 📋 | 需 APP 端开发 |
| 17 | 第二部手机管控 | P1 | 📋 | 需物理流程 |
| 18 | 独立设备安检 | P2 | 📋 | 需物理流程 |
| 19 | USB ADB 关闭 | P2 | 📋 | 需 adb.js 开发 |
| 20 | 不扫码离开应急 | P1 | ⚠️ | 超时告警已实施，需配套流程 |

> ✅ = 已实施  ⚠️ = 部分实施  📋 = 待实施（含建议方案）

---

## 六、环境变量配置速查

```bash
# 会话生命周期
SESSION_WAITING_EXPIRE_MS=1800000      # waiting 过期（默认 30 分钟）
SESSION_RESTRICTED_ALERT_MS=43200000   # restricted 告警（默认 12 小时）
SESSION_ERROR_CLEANUP_MS=86400000      # error 清理（默认 24 小时）
SESSION_EXITED_CLEANUP_MS=604800000    # exited 清理（默认 7 天）
SESSION_LIFECYCLE_CHECK_MS=60000       # 检查间隔（默认 60 秒）

# 频率限制
CHECKIN_RATE_LIMIT_MAX=10              # 每 IP 每分钟最大请求数

# 管控恢复
ENABLE_RECOVER_PAIRING=true            # 开启自动恢复配对
RECOVER_PAIRING_AREAS=车间A,车间B      # 限定开启恢复配对的区域
RETRY_CONNECT_COOLDOWN_MS=8000         # 重试连接冷却时间

# 安全
ADMIN_TOKEN=your-secret-token          # 管理后台访问口令

# 服务
PORT=3000                              # 服务端口
```
