# 厂区访客管控 SaaS v2.0

多租户订阅式访客管控系统，支持每个厂区独立订阅、WiFi IP 绑定防滥用。

---

## 可执行规范（后端按单开发）

- 规范文档：`docs/executable-spec.md`
- 工单清单：`docs/backend-work-items.md`
- 参数迁移：`docs/siteid-migration.md`（`subId` 下线，统一 `siteId`）
- 数据迁移：`docs/db-migrations.md`（显式 migration + 最小回滚指引）
- 上线门禁：`docs/p0-launch-gate-regression.md`（P0 回归清单 + 验收结果模板）
- P1 状态机门禁：`docs/p1-2-state-gate.md`（状态机自动校验 + 手工联调）
- P1 订单流门禁：`docs/p1-3-order-flow-gate.md`（订单支付链路 + 旧接口下线验收）
- P1 历史持久化门禁：`docs/p1-5-history-persistence-gate.md`（历史查询 + site 过滤 + 导出）
- 该文档定义了状态机表、接口校验矩阵、数据库字段建议与迁移顺序
- 订阅模型以 `site_id` 为核心，网络校验升级为多 `network_fingerprint` + 重绑定审批

---

## 快速启动

建议 Node 版本：`v20.x`（当前 `better-sqlite3@9.x` 在 Node 24 下容易出现原生模块不兼容）。

```bash
# 0. 切换 Node（推荐）
nvm use 20

# 1. 安装依赖
npm install

# 2. 复制配置文件
cp .env.example .env
# 编辑 .env，至少修改：JWT_SECRET、SUPER_ADMIN_PASSWORD、支付收款信息

# 3. 启动（开发）
npm run db:migrate
npm run dev

# 4. 启动（生产，使用 PM2）
npm install -g pm2
npm run db:migrate
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup
```

---

## 目录结构

```
factory-saas/
├── server.js              # HTTP + WebSocket 入口（~100行）
├── ecosystem.config.js    # PM2 配置
├── .env.example           # 环境变量说明
│
├── config/
│   └── index.js           # 集中配置（读取 .env）
│
├── db/
│   └── index.js           # SQLite Schema + Prepared Statements
│
├── middleware/
│   ├── auth.js            # JWT 认证
│   ├── subscription.js    # 订阅有效性 + WiFi IP 绑定验证
│   └── rateLimit.js       # 入场频率限制
│
├── routes/
│   ├── auth.js            # 登录 / 注册 / 退出
│   ├── user.js            # 用户订阅管理 + 支付申请
│   ├── admin.js           # 超管：用户/订阅/支付管理
│   ├── checkin.js         # 访客入场流程
│   └── device.js          # ADB 设备操作
│
├── sessions/
│   ├── store.js           # 内存 + SQLite 双层存储
│   ├── serialize.js       # 会话序列化
│   └── lifecycle.js       # 超时检查 / 自动清理
│
├── pairing/
│   └── flow.js            # ADB 配对全流程（可复用）
│
├── broadcast/
│   └── ws.js              # WebSocket 房间管理
│
├── utils/
│   └── network.js         # IP/网络工具函数
│
├── adb.js                 # ADB 设备管理（原始文件）
├── mdns.js                # mDNS 发现（原始文件）
│
├── public/
│   ├── login.html         # 登录页
│   ├── register.html      # 注册页（含试用说明）
│   ├── dashboard.html     # 用户控制台（订阅管理+续费）
│   ├── admin.html         # 超管后台（用户/支付/订阅）
│   ├── welcome.html       # 访客入场表单
│   └── welcome-bridge.html# 访客 APP 唤起页
│
├── data/                  # 数据库文件（自动创建）
│   └── factory.db
└── logs/                  # PM2 日志（自动创建）
```

---

## 订阅制机制

> 注：本节描述的是当前版本实现细节；目标改造规则请以 `docs/executable-spec.md` 为准。

### 价格
| 套餐 | 价格 | 适用场景 |
|------|------|----------|
| 7天试用 | 免费 | 新注册用户自动获得 |
| 月度订阅 | ¥99/月 | 灵活付费 |
| 年度订阅 | ¥999/年 | 省 ¥189 |

### WiFi IP 绑定（防滥用）
- 每个订阅绑定一个 WiFi 子网（如 `192.168.1.x`）
- **首次**有访客从该订阅扫码入场时自动绑定客户端 IP 的 `/24` 子网
- 绑定后，来自其他网段的请求会被拒绝（防止同一账户用在多个厂区）
- 解绑需要超管操作（`/api/admin/subscriptions/:id/unbind-ip`）

### 支付流程（人工收款）
1. 用户先创建订单（`pending_payment`），再提交转账流水进入 `paid_pending_review`
2. 超管在后台「待审核订单」确认或拒绝
3. 确认后订单变 `confirmed`，订阅续期（叠加续费：若当前有效期内续费，从原到期日顺延）
4. 拒绝后订单变 `rejected`，并记录原因与审计日志

---

## 环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `JWT_SECRET` | ✅ | JWT 签名密钥，生产环境必须修改 |
| `SUPER_ADMIN_EMAIL` | ✅ | 超管邮箱 |
| `SUPER_ADMIN_PASSWORD` | ✅ | 超管密码，首次启动创建 |
| `PORT` | | 监听端口，默认 3000 |
| `DB_PATH` | | 数据库路径，默认 `./data/factory.db` |
| `TRIAL_DAYS` | | 试用天数，默认 7 |
| `PRICE_MONTHLY_FEN` | | 月度价格（分），默认 9900 |
| `PRICE_YEARLY_FEN` | | 年度价格（分），默认 99900 |
| `PAYMENT_ALIPAY_ACCOUNT` | | 支付宝收款账号 |
| `PAYMENT_WECHAT_ID` | | 微信号 |
| `PAYMENT_BANK_*` | | 银行卡信息 |

---

## 生产部署检查清单

- [ ] `.env` 中 `JWT_SECRET` 已修改为随机长字符串
- [ ] `SUPER_ADMIN_PASSWORD` 已改为强密码
- [ ] 支付收款信息已填写
- [ ] `NODE_ENV=production` 已设置
- [ ] PM2 进程守护已配置（`pm2 startup`）
- [ ] 定期备份 `./data/factory.db`
- [ ] 防火墙仅开放必要端口（3000 或 Nginx 反代 80/443）
