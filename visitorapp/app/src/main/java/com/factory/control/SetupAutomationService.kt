@file:Suppress("DEPRECATION")
package com.factory.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.*
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast

/**
 * SetupAutomationService — 自动完成开发者选项及无线调试配置
 *
 * 重构说明（相对原版）：
 *
 *  R-1  引入 Stage2State data class，将 Stage 2 的 13 个散落布尔/计数字段收拢为一个对象；
 *       goToWirelessDebugging() 重置时只需 s2 = Stage2State()，不再逐字段清零，
 *       未来新增字段在 data class 中声明默认值即可，不会遗漏。
 *
 *  R-2  handleOpenWirelessDebugStage() 从 230+ 行 13 分支拆分为 1 个 ~40 行分发器
 *       + 8 个职责单一的私有辅助函数：
 *         handleWirelessPageReached()       — 已到达无线调试页
 *         handleOnDevOptionsPage()          — 在开发者选项页
 *         handleWirelessEntryFound()        — wireNode 在搜索结果中出现
 *         handleAboutPhoneNavigation()      — 从「关于手机」页导航离开
 *         handleSettingsOrUnknownPage()     — 设置页 / 未知页综合处理
 *         initiateWirelessSearch()          — 发起「无线」搜索
 *         initiateDeveloperSearch()         — 发起「开发」搜索
 *         clickDevOptionsEntry()            — 点击「开发者选项」入口
 *
 *  R-3  isEnabled() 优先以 isChecked 为准，仅在 isChecked=false 时才降级到
 *       contentDescription 字符串匹配，并为每条命中路径记录日志，
 *       避免不同 ROM / 系统语言下静默误判导致开关被反向点击。
 *
 *  R-4  waitForPairingDialog 上限从 25 次（最长 20 s）缩短至 10 次（最长 8 s），
 *       每轮轮询同步向 UI 上报"正在等待配对弹窗… (N/10)"进度。
 *
 *  R-5  scrollDown() 优先对可滚动容器发 ACTION_SCROLL_FORWARD（精确、无副作用）；
 *       仅在找不到可滚动节点时降级为手势滚动；手势在宽高比 < 1.2（折叠屏展开态 / 平板）
 *       时使用更保守的滑动范围（0.62→0.38），避免在宽屏上滑过头。
 *
 *  R-6  startRecoverPairingFlow() 入口处调用 reset()，确保 totalWirelessRetryCount
 *       在每次新流程开始时归零，防止多次调用后提前触发 "多次尝试均无法进入无线调试" 失败。
 */
class SetupAutomationService : AccessibilityService() {

    // ── R-1: Stage 2 状态对象 ──────────────────────────────────────
    /**
     * 收拢 Stage 2 所有中间状态。
     * goToWirelessDebugging() 重置时执行 s2 = Stage2State() 即可完整清零，
     * 新增字段只需在此处声明默认值，不会遗漏。
     */
    private data class Stage2State(
        var triedSearchWireless: Boolean = false,
        var triedSearchDeveloper: Boolean = false,
        var triedClickSearchButtonForWireless: Boolean = false,
        var triedClickSearchButtonForDev: Boolean = false,
        var wirelessSearchInFlight: Boolean = false,
        var wirelessSearchResultRetries: Int = 0,
        var devNodeTotalClickAttempts: Int = 0,
        var settingsPageClickRetries: Int = 0,
        var waitForSearchBoxRetries: Int = 0,
        var searchButtonClickRetryCount: Int = 0,
        var aboutPhoneToMainCount: Int = 0,
        var justDidBackFromAboutPhone: Boolean = false,
        var titleLogged: Boolean = false,
        var devOptionsEntered: Boolean = false,
        var devOptionsScrollCount: Int = 0,
        /**
         * 从设置搜索等入口点击「无线调试」后，部分 ROM（如带「设置建议」）会打开开发者选项列表，
         * 而非无线调试详情页；且顶部标题可能短暂变成「内存」等子节名称，导致 isOnDeveloperOptionsPage=false，
         * 进而误清空 devOptionsScrollCount 并走 settings_or_unknown 死循环。
         * 置 true 后：在未到无线详情页且仍在系统设置内时，一律按「在开发者列表中滚动并点击无线调试」处理。
         */
        var scrollWirelessAfterSearchClick: Boolean = false
    )

    companion object {
        var instance: SetupAutomationService? = null
        const val BROADCAST_STEP   = "com.factory.control.AUTO_STEP"
        const val BROADCAST_DONE   = "com.factory.control.SETUP_COMPLETE"
        const val BROADCAST_FAILED = "com.factory.control.SETUP_FAILED"
        private const val TAG        = "A11y"
        private const val TRACE      = "A11yTrace"
        private const val QUICK_PATH_TAG = "A11yQuickPath"

        fun isAutomationInProgress(): Boolean =
            instance?.let { it.stage != Stage.IDLE && it.stage != Stage.DONE } ?: false
    }

    private enum class Stage {
        IDLE,
        CLICKING_BUILD_NUMBER,
        OPENING_WIRELESS_DEBUG,
        ENABLING_SWITCH,
        OPENING_QR_PAIRING,
        /** 离厂成功后可选：关闭开发者选项总开关 */
        DISABLING_DEV_OPTIONS,
        DONE
    }

    // ── 跨 Stage 计数器 / 标志 ────────────────────────────────────
    private var stage            = Stage.IDLE
    private var clickCount       = 0
    private var scrollCount      = 0
    private var retryCount       = 0
    private var pairingWaitCount = 0
    /** 跨 goToWirelessDebugging() 调用累计，reset() 时归零 */
    private var totalWirelessRetryCount = 0
    /** 分支 4：两种搜索都试过仍卡住时，重启 S2 的次数（不受 goToWirelessDebugging 内 retryCount=0 影响） */
    private var s2BothSearchesRestartAttempts = 0
    /** 分支 6：兜底重进 S2 的次数 */
    private var s2CatchAllRestartAttempts = 0
    private var isPendingRetry   = false
    private var offSettingsRetryCount = 0
    private var qrEntryClickRetryCount = 0
    private var dialogConfirmClickRetryCount = 0
    private var flowStartElapsedMs: Long = 0
    private var forceRestartWirelessDebug = false
    private var restartPhase = 0
    private var restartToggleAttempts = 0
    private var sawPinVerificationDuringS1 = false
    private var didPostPinTopUpClicks = false

    /** 离厂后关闭开发者选项流程（独立计时，不走 fail()/总超时弹窗） */
    private var disableDevFlowStartMs = 0L
    private var disableDevRetryCount = 0

    /** R-1: Stage 2 状态，替代原先 13 个散落字段 */
    private var s2 = Stage2State()

    private val handler = Handler(Looper.getMainLooper())
    private val totalFlowTimeoutMs = 3 * 60 * 1000L
    private val disableDevMaxMs = 120_000L

    // ─── 生命周期 ────────────────────────────────────────────────

    override fun onServiceConnected() {
        instance = this
        Log.d(TAG, "Service connected")
        AppDebugLog.i(TAG, "Service connected")
    }
    override fun onInterrupt() {}
    override fun onDestroy() {
        instance = null
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /**
     * 由后端/ADB 成功信号触发的兜底停止。
     *
     * 场景：用户已扫码配对成功，但无障碍在某些 ROM 上未能识别到 S4 的
     * “配对弹窗”，导致仍在轮询；此时由 ControlService 直接终止自动化。
     */
    fun stopAutomation(reason: String = "后端已确认配对成功，停止自动化") {
        val curStage = stage
        if (curStage == Stage.IDLE || curStage == Stage.DONE) return
        if (curStage == Stage.DISABLING_DEV_OPTIONS) {
            handler.removeCallbacksAndMessages(null)
            isPendingRetry = false
            reset()
            stage = Stage.DONE
            return
        }

        val doneStep = when (curStage) {
            Stage.CLICKING_BUILD_NUMBER  -> 1
            Stage.OPENING_WIRELESS_DEBUG -> 2
            Stage.ENABLING_SWITCH        -> 3
            Stage.OPENING_QR_PAIRING     -> 4
            else -> 0
        }

        Log.d(TAG, "stopAutomation curStage=$curStage doneStep=$doneStep reason=$reason")

        // 先清理所有延迟回调/轮询，再标记为 DONE。
        reset()
        stage = Stage.DONE
        report(step = doneStep, state = "DONE", msg = reason)
        sendBroadcast(Intent(BROADCAST_DONE))
    }

    // ─── 外部入口 ─────────────────────────────────────────────────

    fun startDevModeAutomation() {
        abortDisablingDevOptionsIfRunning()
        if (stage != Stage.IDLE && stage != Stage.DONE) return
        reset()
        markFlowStart()
        if (isDeveloperOptionsEnabled()) {
            Log.d(TAG, "startDevMode: developer options already enabled, skip Stage 1")
            report(step = 1, state = "DONE", msg = "开发者模式已开启，跳过激活步骤")
            goToWirelessDebugging()
            return
        }
        stage = Stage.CLICKING_BUILD_NUMBER
        report(step = 1, state = "IN_PROGRESS", msg = "正在打开「关于手机」…")
        handler.postDelayed({
            startActivity(
                Intent(Settings.ACTION_DEVICE_INFO_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }, 100)
    }

    fun startQrPairingIfWirelessDebugEnabled(): Boolean {
        abortDisablingDevOptionsIfRunning()
        if (stage != Stage.IDLE && stage != Stage.DONE) return false
        val enabled = isWirelessDebuggingEnabled()
        Log.d(QUICK_PATH_TAG, "quick_path_check enabled=$enabled stage=$stage")
        if (!enabled) return false
        reset()
        markFlowStart()
        Log.d(QUICK_PATH_TAG, "quick_path_start skip_stage1=true")
        report(step = 1, state = "DONE", msg = "无线调试已开启，正在打开配对页…")
        goToWirelessDebugging()
        return true
    }

    /**
     * R-6: 入口处调用 reset()，防止 totalWirelessRetryCount 跨流程累积
     * 导致多次调用后提前触发 fail。
     */
    fun startRecoverPairingFlow(): Boolean {
        abortDisablingDevOptionsIfRunning()
        if (stage != Stage.IDLE && stage != Stage.DONE) return false
        reset()   // ← 原版遗漏此调用，R-6 补充
        markFlowStart()
        forceRestartWirelessDebug = true
        restartPhase = 0
        restartToggleAttempts = 0
        report(step = 3, state = "IN_PROGRESS", msg = "正在重置无线调试…")
        goToWirelessDebugging()
        return true
    }

    /**
     * 离厂成功后调用：尝试进入开发者选项并关闭总开关。
     * 失败/超时不发 [BROADCAST_FAILED]，仅 Toast，不影响离厂主流程。
     */
    fun startDisableDeveloperOptionsAfterExit() {
        if (stage != Stage.IDLE && stage != Stage.DONE) return
        if (!isDeveloperOptionsEnabled()) {
            Log.d(TAG, "disableDevAfterExit: development_settings_enabled already off")
            return
        }
        reset()
        disableDevFlowStartMs = SystemClock.elapsedRealtime()
        disableDevRetryCount = 0
        scrollCount = 0
        stage = Stage.DISABLING_DEV_OPTIONS
        report(
            step = 5,
            state = "IN_PROGRESS",
            msg = "正在关闭开发者选项…"
        )
        AppDebugLog.i(TAG, "disableDevAfterExit start")
        handler.postDelayed({
            try {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e: Exception) {
                Log.w(TAG, "disableDevAfterExit intent failed: ${e.message}")
                Toast.makeText(
                    this,
                    "无法打开开发者选项，请在设置中手动关闭开发者模式。",
                    Toast.LENGTH_LONG
                ).show()
                stage = Stage.DONE
            }
        }, 400)
    }

    private fun abortDisablingDevOptionsIfRunning() {
        if (stage != Stage.DISABLING_DEV_OPTIONS) return
        Log.d(TAG, "abortDisablingDevOptionsIfRunning")
        isPendingRetry = false
        handler.removeCallbacksAndMessages(null)
        reset()
        stage = Stage.DONE
    }

    // ─── 事件入口 ────────────────────────────────────────────────

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return
        if (isPendingRetry) return
        when (stage) {
            Stage.CLICKING_BUILD_NUMBER  -> handleBuildNumberStage()
            Stage.OPENING_WIRELESS_DEBUG -> handleOpenWirelessDebugStage()
            Stage.ENABLING_SWITCH        -> handleEnableSwitchStage()
            Stage.OPENING_QR_PAIRING     -> handleQrPairingStage()
            Stage.DISABLING_DEV_OPTIONS  -> handleDisableDevOptionsStage()
            else -> {}
        }
    }

    // ─── Stage 1：连点版本号 7 次 ────────────────────────────────

    private fun handleBuildNumberStage() {
        if (stage != Stage.CLICKING_BUILD_NUMBER) return
        if (!ensureWithinTotalTimeout("S1")) return
        if (clickCount > 0) return
        if (isDeveloperOptionsEnabled()) {
            Log.d(TAG, "S1: developer options already enabled, skip to Stage 2")
            report(step = 1, state = "DONE", msg = "开发者模式已开启")
            goToWirelessDebugging()
            return
        }
        val root = rootInActiveWindow ?: run { Log.d(TAG, "S1: root null"); return }
        val title = getPageTitle(root)
        Log.d(TAG, "S1: title='$title' scrollCount=$scrollCount")

        if (!isSettingsApp(root)) {
            offSettingsRetryCount++
            Log.d(TRACE, "gate_s1_blocked retry=$offSettingsRetryCount pkg=${root.packageName}")
            if (offSettingsRetryCount % 3 == 1) {
                try {
                    startActivity(
                        Intent(Settings.ACTION_DEVICE_INFO_SETTINGS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "S1: reopen device info failed: ${e.message}")
                }
            }
            scheduleRetry(700) { handleBuildNumberStage() }
            root.recycle()
            return
        }
        offSettingsRetryCount = 0

        if (isOnMainSettingsPage(root, title)) {
            Log.d(TAG, "S1: detected main Settings page, looking for About Phone entry")
            val aboutNode = findAboutPhoneNode(root)
            if (aboutNode != null) {
                val clickTarget = findBestClickable(aboutNode) ?: aboutNode
                Log.d(TAG, "S1: clicking About Phone entry: ${aboutNode.text}")
                clickTarget.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                recycleDistinct(clickTarget, aboutNode)
                scheduleRetry(800) { handleBuildNumberStage() }
            } else if (scrollCount < 8) {
                scheduleScroll { handleBuildNumberStage() }
            } else {
                fail("在设置列表中找不到「关于手机」入口，请手动进入并重新触发")
            }
            root.recycle()
            return
        }

        val node = findBuildNumberNode(root)
        Log.d(TAG, "S1: node=${node?.text}  isClickable=${node?.isClickable}  class=${node?.className}")

        if (node == null) {
            if (scrollCount < 5) {
                scheduleScroll { handleBuildNumberStage() }
            } else {
                fail("找不到「版本号」，请确认处于关于手机页面")
            }
            root.recycle()
            return
        }

        val clickTarget = findBestClickable(node) ?: node
        clickBuildNumberOnce(labelNode = node, clickTarget = clickTarget)
        root.recycle()
    }

    private fun clickBuildNumberOnce(
        labelNode: AccessibilityNodeInfo,
        clickTarget: AccessibilityNodeInfo
    ) {
        if (clickCount >= 7) {
            report(step = 1, state = "IN_PROGRESS", msg = "等待开发者模式激活…")
            waitForDeveloperModeEnabled()
            return
        }
        clickTarget.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        clickCount++
        report(step = 1, state = "IN_PROGRESS", msg = "正在点击版本号 ($clickCount/7)")
        recycleDistinct(clickTarget, labelNode)
        scheduleRetry(250) { continueBuildNumberClickLoop() }
    }

    private fun continueBuildNumberClickLoop() {
        if (stage != Stage.CLICKING_BUILD_NUMBER) return
        if (!ensureWithinTotalTimeout("S1")) return
        if (clickCount >= 7) {
            report(step = 1, state = "IN_PROGRESS", msg = "等待开发者模式激活…")
            waitForDeveloperModeEnabled()
            return
        }
        val root = rootInActiveWindow ?: run {
                        clickCount = 0
                        isPendingRetry = true
                        handler.postDelayed({
                            isPendingRetry = false
                            handleBuildNumberStage()
                        }, 500)
            return
                    }
        try {
            dismissAnyDialog(root)
            val newNode = findBuildNumberNode(root)
                    if (newNode != null) {
                        val newTarget = findBestClickable(newNode) ?: newNode
                clickBuildNumberOnce(newNode, newTarget)
                    } else {
                Log.d(TAG, "S1: build number not found, re-entering stage")
                        clickCount = 0
                        isPendingRetry = true
                        handler.postDelayed({
                            isPendingRetry = false
                            handleBuildNumberStage()
                        }, 400)
                }
            } catch (_: Exception) {
                    clickCount = 0
                    scheduleRetry(400) { handleBuildNumberStage() }
        } finally {
            root.recycle()
        }
    }

    private fun waitForDeveloperModeEnabled(pollCount: Int = 0) {
        if (stage != Stage.CLICKING_BUILD_NUMBER) return
        if (!ensureWithinTotalTimeout("S1")) return
        val isEnabled = try {
            Settings.Global.getInt(contentResolver, "development_settings_enabled", 0) == 1
        } catch (_: Exception) { false }

        Log.d(TAG, "S1: waitForDevMode poll=$pollCount enabled=$isEnabled")
        AppDebugLog.d(TAG, "S1 wait poll=$pollCount enabled=$isEnabled pinSeen=$sawPinVerificationDuringS1 topUpDone=$didPostPinTopUpClicks")

        if (isEnabled) {
            report(step = 1, state = "DONE", msg = "开发者模式已激活")
            goToWirelessDebugging()
            return
        }
        val root = rootInActiveWindow
        if (root != null) {
            try {
                val title = getPageTitle(root)
                val onPin = isOnPinVerificationPage(root, title)

                // 轮询阶段页面守卫：与 handleBuildNumberStage 脱节时，访客离开「关于手机」会盲等；此处主动拉回
                if (!onPin) {
                    if (!isSettingsApp(root)) {
                        if (pollCount % 5 == 0) {
                            Log.w(TAG, "S1 poll: not in settings pkg=${root.packageName}, pull back to about phone")
                            AppDebugLog.w(TAG, "S1 poll pull_back pkg=${root.packageName} poll=$pollCount")
                            try {
                                startActivity(
                                    Intent(Settings.ACTION_DEVICE_INFO_SETTINGS)
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                )
                            } catch (e: Exception) {
                                Log.w(TAG, "S1 poll pull_back failed: ${e.message}")
                            }
                        }
                    } else if (!isOnAboutPhonePage(root, title) && pollCount > 0 && pollCount % 8 == 0) {
                        Log.w(TAG, "S1 poll: drifted from about phone title='$title', re-open device info")
                        AppDebugLog.w(TAG, "S1 poll re_nav_about title=$title poll=$pollCount")
                        try {
                            startActivity(
                                Intent(Settings.ACTION_DEVICE_INFO_SETTINGS)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        } catch (e: Exception) {
                            Log.w(TAG, "S1 poll re_nav failed: ${e.message}")
                        }
                    }
                }

                if (onPin) {
                    if (!sawPinVerificationDuringS1) {
                        AppDebugLog.i(TAG, "S1 detected PIN verification page, waiting user input")
                    }
                    sawPinVerificationDuringS1 = true
                    report(step = 1, state = "IN_PROGRESS", msg = "检测到 PIN 校验，请输入后稍候…")
                } else if (!didPostPinTopUpClicks && isLikelyOnBuildNumberPage(root, title) &&
                    (hasNeedOneMoreTapHint(root) || pollCount >= 6)) {
                    val topUpClicks = doPostPinTopUpBuildNumberClicks(root, maxClicks = 1)
                    if (topUpClicks > 0) {
                        didPostPinTopUpClicks = true
                        AppDebugLog.i(TAG, "S1 waiting-phase extra tap done clicks=$topUpClicks poll=$pollCount")
                        report(step = 1, state = "IN_PROGRESS", msg = "检测到仍需额外点击版本号，正在补点…")
                    }
                } else if (sawPinVerificationDuringS1 && !didPostPinTopUpClicks) {
                    val topUpClicks = doPostPinTopUpBuildNumberClicks(root, maxClicks = 2)
                    if (topUpClicks > 0) {
                        didPostPinTopUpClicks = true
                        AppDebugLog.i(TAG, "S1 post-PIN top-up clicks=$topUpClicks")
                        report(step = 1, state = "IN_PROGRESS", msg = "PIN 校验后补点版本号…")
                    }
                }
            } finally {
                root.recycle()
            }
        }
        /** 约 24s（80×300ms）；有拉回逻辑后不必盲等 30s+ */
        if (pollCount >= 80) {
            fail("等待开发者模式激活超时，请手动进入设置开启")
            return
        }
        isPendingRetry = true
        handler.postDelayed({
            isPendingRetry = false
            waitForDeveloperModeEnabled(pollCount + 1)
        }, 300)
    }

    @Suppress("DEPRECATION")
    private fun isOnPinVerificationPage(root: AccessibilityNodeInfo, title: String): Boolean {
        val titleHints = listOf("输入密码", "验证", "安全验证", "Verify", "Password", "PIN")
        if (titleHints.any { title.contains(it, ignoreCase = true) }) return true
        val textHints = listOf("输入 PIN", "输入密码", "确认密码", "请输入锁屏密码", "PIN", "Password")
        for (hint in textHints) {
            val nodes = root.findAccessibilityNodeInfosByText(hint)
            val found = nodes.isNotEmpty()
            nodes.forEach { it.recycle() }
            if (found) return true
        }
        return false
    }

    private fun doPostPinTopUpBuildNumberClicks(root: AccessibilityNodeInfo, maxClicks: Int): Int {
        val node = findBuildNumberNode(root) ?: return 0
        val clickTarget = findBestClickable(node) ?: node
        var clicks = 0
        repeat(maxClicks) {
            val ok = clickTarget.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            if (ok) clicks++
        }
        recycleDistinct(clickTarget, node)
        return clicks
    }

    private fun isLikelyOnBuildNumberPage(root: AccessibilityNodeInfo, title: String): Boolean {
        if (isOnAboutPhonePage(root, title)) return true
        val buildNode = findBuildNumberNode(root)
        val found = buildNode != null
        buildNode?.recycle()
        return found
    }

    @Suppress("DEPRECATION")
    private fun hasNeedOneMoreTapHint(root: AccessibilityNodeInfo): Boolean {
        val hints = listOf(
            "再点击一次版本号",
            "再点一次版本号",
            "再点击一次",
            "还需一步",
            "还差一步",
            "One step away",
            "one more step"
        )
        for (hint in hints) {
            val nodes = root.findAccessibilityNodeInfosByText(hint)
            val found = nodes.isNotEmpty()
            nodes.forEach { it.recycle() }
            if (found) return true
        }
        return false
    }

    // ─── Stage 2：跳转并滚动定位无线调试 ────────────────────────

    private fun goToWirelessDebugging() {
        stage = Stage.OPENING_WIRELESS_DEBUG
        markFlowStartIfNeeded()
        scrollCount = 0
        retryCount = 0
        offSettingsRetryCount = 0
        s2 = Stage2State()   // R-1: 一行替代原版 15+ 行逐字段清零
        if (totalWirelessRetryCount++ > 15) {
            fail("多次尝试均无法进入无线调试，请手动操作")
            return
        }
        report(step = 2, state = "IN_PROGRESS", msg = "正在进入无线调试…")
        isPendingRetry = true
        val intentOk = tryIntentDirectly()
        if (!intentOk) {
            try {
                startActivity(
                    Intent(Settings.ACTION_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e: Exception) {
                Log.w(TAG, "S2: startActivity(SETTINGS) failed: ${e.message}")
            }
        }
        handler.postDelayed({
            isPendingRetry = false
            handleOpenWirelessDebugStage()
        }, 800)
    }

    private fun tryIntentDirectly(): Boolean {
        val intents = listOf(
            Intent("com.android.settings.WIRELESS_DEBUGGING_SETTINGS"),
            Intent().setClassName(
                "com.android.settings",
                "com.android.settings.development.WirelessDebuggingActivity"
            )
        )
        for (intent in intents) {
            try {
                startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            } catch (_: Exception) {}
        }
        return false
    }

    // ── R-2: Stage 2 分发器（~40 行）────────────────────────────

    @Suppress("DEPRECATION")
    private fun handleOpenWirelessDebugStage() {
        if (stage != Stage.OPENING_WIRELESS_DEBUG) return
        if (!ensureWithinTotalTimeout("S2")) return
        val root = rootInActiveWindow ?: run {
            Log.d(TAG, "S2: root null, retry in 500ms")
            scheduleRetry(500) { handleOpenWirelessDebugStage() }
            return
        }
        try {
        val title = getPageTitle(root)
            val pkg = root.packageName?.toString() ?: ""
            val onSettings = isSettingsApp(root) || title.contains("设置") || title.contains("Settings")
            val onAbout = isOnAboutPhonePage(root, title)
            val onDevOpts = isOnDeveloperOptionsPage(root, title)
            val onWirelessDetail = isOnWirelessDebugDetailPage(root, title)
            val onDevOptsEffective = onDevOpts || (
                s2.scrollWirelessAfterSearchClick &&
                    isSettingsApp(root) &&
                    !onAbout &&
                    !onWirelessDetail
                )
            // 勿在「搜索点无线→列表页但标题非开发者选项」的过渡期清空滚动进度
            if (!onDevOpts && !s2.scrollWirelessAfterSearchClick) {
                s2.devOptionsEntered = false
                s2.devOptionsScrollCount = 0
            }
            if (!s2.titleLogged) {
                Log.d(TAG, "S2: title_once='$title' pkg=${root.packageName}")
                s2.titleLogged = true
            }
            Log.d(TAG, "S2: title='$title' scroll=$scrollCount retry=$retryCount")

            val wireNode = findWirelessDebugEntryNode(root)
            val devNode  = findDeveloperOptionsEntryNode(root)
            AppDebugLog.d(
                TAG,
                "S2 dispatch title='$title' pkg=$pkg onSettings=$onSettings onAbout=$onAbout " +
                    "onDevOpts=$onDevOpts onWirelessDetail=$onWirelessDetail " +
                    "wireNode=${wireNode != null} devNode=${devNode != null} " +
                    "searchInFlight=${s2.wirelessSearchInFlight} searchedWireless=${s2.triedSearchWireless}"
            )

            when {
                onWirelessDetail -> {
                    AppDebugLog.i(TAG, "S2 branch=on_wireless_detail")
                    wireNode?.recycle(); devNode?.recycle()
                    handleWirelessPageReached()
                }
                onDevOptsEffective -> {
                    AppDebugLog.i(
                        TAG,
                        "S2 branch=on_dev_options eff=$onDevOptsEffective " +
                            "(titleMatch=$onDevOpts scrollAfterSearch=${s2.scrollWirelessAfterSearchClick})"
                    )
                    devNode?.recycle()
                    handleOnDevOptionsPage(root, wireNode)
                }
                wireNode != null -> {
                    AppDebugLog.i(TAG, "S2 branch=wire_entry_found")
                    devNode?.recycle()
                    handleWirelessEntryFound(root, wireNode)
                }
                onAbout && !s2.justDidBackFromAboutPhone -> {
                    AppDebugLog.i(TAG, "S2 branch=about_phone_navigation")
                    wireNode?.recycle(); devNode?.recycle()
                    handleAboutPhoneNavigation()
                }
                else -> {
                    AppDebugLog.i(TAG, "S2 branch=settings_or_unknown")
                    // wireNode 为 null（已被上面 when 条件排除）
                    handleSettingsOrUnknownPage(root, title, devNode)
                }
            }
        } finally {
            root.recycle()
        }
    }

    /** R-2a: 已到达无线调试页，切换到 Stage 3 */
    private fun handleWirelessPageReached() {
        Log.d(TAG, "S2: reason=on_wireless_debug_page")
        AppDebugLog.i(TAG, "S2 reached wireless detail, switch to Stage3")
        s2.scrollWirelessAfterSearchClick = false
        s2.triedSearchWireless = true
        s2.wirelessSearchInFlight = false
        s2.wirelessSearchResultRetries = 0
                stage = Stage.ENABLING_SWITCH
        scrollCount = 0
        retryCount = 0
        s2BothSearchesRestartAttempts = 0
        s2CatchAllRestartAttempts = 0
                report(step = 2, state = "IN_PROGRESS", msg = "已进入无线调试页")
                handleEnableSwitchStage()
            }

    /** R-2b: 在开发者选项页，找 wireNode 或继续滚动 */
    private fun handleOnDevOptionsPage(root: AccessibilityNodeInfo, wireNode: AccessibilityNodeInfo?) {
        Log.d(TAG, "S2: reason=on_developer_options_page")
        s2BothSearchesRestartAttempts = 0
        s2CatchAllRestartAttempts = 0
        if (!s2.devOptionsEntered) {
            s2.devOptionsEntered = true
            s2.devOptionsScrollCount = 0
            AppDebugLog.i(TAG, "S2: enter dev options page, reset dedicated scroll counter")
        }
        s2.settingsPageClickRetries = 0
                if (wireNode != null) {
            s2.triedSearchWireless = true
            s2.wirelessSearchInFlight = false
            s2.wirelessSearchResultRetries = 0
            Log.d(TAG, "S2: 无线调试 found in dev list, clicking")
            if (!isSettingsApp(root)) {
                wireNode.recycle()
                scheduleRetry(500) { handleOpenWirelessDebugStage() }
                return
            }
            val clicked = clickIfVisibleOrRetry(
                "S2: wireless entry", "developer_options_list", wireNode
            ) {
                scheduleDevOptionsScroll { handleOpenWirelessDebugStage() }
            }
            if (clicked) scheduleRetry(600) { handleOpenWirelessDebugStage() }
        } else if (s2.devOptionsScrollCount < 22) {
            scheduleDevOptionsScroll { handleOpenWirelessDebugStage() }
                } else {
                    fail("在开发者选项列表中找不到无线调试入口")
                }
            }

    private fun scheduleDevOptionsScroll(retry: () -> Unit) {
        s2.devOptionsScrollCount++
        AppDebugLog.d(TAG, "S2: dev options dedicated scroll #${s2.devOptionsScrollCount}")
        isPendingRetry = true
        scrollDown()
        handler.postDelayed({
            isPendingRetry = false
            retry()
        }, 500)
    }

    /** R-2c: wireNode 在搜索结果或其他非开发者页中找到 */
    private fun handleWirelessEntryFound(root: AccessibilityNodeInfo, wireNode: AccessibilityNodeInfo) {
        Log.d(TAG, "S2: reason=wire_entry_found")
        s2BothSearchesRestartAttempts = 0
        s2CatchAllRestartAttempts = 0
        s2.triedSearchWireless = true
        s2.wirelessSearchInFlight = false
        s2.wirelessSearchResultRetries = 0
        if (!isSettingsApp(root)) {
            wireNode.recycle()
            scheduleRetry(500) { handleOpenWirelessDebugStage() }
            return
        }
        val clicked = clickIfVisibleOrRetry(
            "S2: wireless entry", "search_result_or_other", wireNode
        ) {
            scheduleRetry(600) { handleOpenWirelessDebugStage() }
        }
        if (clicked) {
            s2.scrollWirelessAfterSearchClick = true
            AppDebugLog.i(TAG, "S2: search_wire_click expect dev-options list scroll path")
            scheduleRetry(600) { handleOpenWirelessDebugStage() }
        }
    }

    /** R-2d: 从「关于手机」页导航回主设置 */
    private fun handleAboutPhoneNavigation() {
        s2CatchAllRestartAttempts = 0
        s2.aboutPhoneToMainCount++
        if (s2.aboutPhoneToMainCount <= 2) {
            Log.d(TAG, "S2: on About phone, launch main Settings (attempt ${s2.aboutPhoneToMainCount})")
                    report(step = 2, state = "IN_PROGRESS", msg = "正在打开设置首页…")
                    try {
                        startActivity(
                            Intent(Settings.ACTION_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        )
                    } catch (e: Exception) {
                        Log.w(TAG, "S2: ACTION_SETTINGS failed: ${e.message}")
                        performGlobalAction(GLOBAL_ACTION_BACK)
                    }
            scheduleRetry(800) { handleOpenWirelessDebugStage() }
                } else {
            Log.d(TAG, "S2: About phone → single Back, delay 1200ms")
                    report(step = 2, state = "IN_PROGRESS", msg = "正在返回上一页…")
                    performGlobalAction(GLOBAL_ACTION_BACK)
            s2.justDidBackFromAboutPhone = true
            scheduleRetry(1200) {
                s2.justDidBackFromAboutPhone = false
                handleOpenWirelessDebugStage()
            }
                }
            }

    /**
     * R-2e: 在设置 / 未知页面时的综合处理（wireNode == null）
     *
     * 优先级顺序（与原版逻辑一致，但拆成独立子函数调用更清晰）：
     *  1. 首次在设置主页 → 优先搜「无线」
     *  2. 无线搜索进行中，等待结果
     *  3. devNode 点击次数超限 → 强制搜索
     *  4. devNode 可点击且次数未超限 → 点击
     *  5. 在设置页但 devNode 未出现且搜索未尝试 → 搜索兜底
     *  6. 在设置页滚动查找
     *  7. 全局搜索兜底
     *  8. 非设置 App 未知页面 → 等待
     *  9. 重试 goToWirelessDebugging
     * 10. fail
     */
    private fun handleSettingsOrUnknownPage(
        root: AccessibilityNodeInfo,
        title: String,
        devNode: AccessibilityNodeInfo?
    ) {
        val onSettings = isSettingsApp(root) || title.contains("设置") || title.contains("Settings")
        val onDevOpts  = isOnDeveloperOptionsPage(root, title)
        val onWireless = isOnWirelessDebugPage(root, title)

        val stuckBothSearches = onSettings && !onDevOpts && !onWireless &&
            s2.triedSearchWireless && s2.triedSearchDeveloper
        if (!stuckBothSearches) s2BothSearchesRestartAttempts = 0

        when {
            // 1. 已在设置页，尚未尝试无线搜索：先搜「无线」
            onSettings && !onDevOpts && !onWireless &&
                !s2.triedSearchWireless && !s2.wirelessSearchInFlight -> {
                devNode?.recycle()
                s2CatchAllRestartAttempts = 0
                Log.d(TAG, "S2: reason=search_wireless_first")
                initiateWirelessSearch(root)
            }

            // 2. 无线搜索进行中，等待结果
            s2.wirelessSearchInFlight && !onWireless -> {
                devNode?.recycle()
                s2CatchAllRestartAttempts = 0
                s2.wirelessSearchResultRetries++
                if (s2.wirelessSearchResultRetries >= 3) {
                    Log.d(TAG, "S2: wireless search no result after retries, mark tried")
                    s2.triedSearchWireless = true
                    s2.wirelessSearchInFlight = false
                    s2.wirelessSearchResultRetries = 0
                    scheduleRetry(500) { handleOpenWirelessDebugStage() }
                } else {
                    scheduleRetry(600) { handleOpenWirelessDebugStage() }
                }
            }

            // 3. 在设置页，已尝试无线搜索且未命中无线调试：改搜「开发」
            onSettings && !onDevOpts && !onWireless &&
                s2.triedSearchWireless && !s2.triedSearchDeveloper -> {
                devNode?.recycle()
                s2CatchAllRestartAttempts = 0
                Log.d(TAG, "S2: reason=search_developer_after_wireless")
                initiateDeveloperSearch(root)
            }

            // 4. 在设置页，「无线」「开发」两种搜索都尝试过仍未到达目标页：少量重启 Stage2，然后失败
            onSettings && !onDevOpts && !onWireless &&
                s2.triedSearchWireless && s2.triedSearchDeveloper -> {
                devNode?.recycle()
                s2BothSearchesRestartAttempts++
                if (s2BothSearchesRestartAttempts <= 3) {
                    Log.d(TAG, "S2: searches tried, restart Stage2 attempt=$s2BothSearchesRestartAttempts")
                    scheduleRetry(600) { goToWirelessDebugging() }
                } else {
                    Log.w(TAG, "S2: fail after searches tried title='$title' pkg=${root.packageName}")
                    fail("多次尝试均无法进入无线调试，请手动操作")
                }
            }

            // 5. 非设置 App 未知页面，等待重新进入 Stage2
            !onSettings && !onDevOpts && !onWireless -> {
                devNode?.recycle()
                s2CatchAllRestartAttempts = 0
                Log.d(TAG, "S2: unrecognized page pkg=${root.packageName} title='$title'")
                scheduleRetry(500) { handleOpenWirelessDebugStage() }
            }

            // 6. 其他情况：重试完整 Stage2（计数独立于 goToWirelessDebugging 内的 retryCount）
            else -> {
                devNode?.recycle()
                s2CatchAllRestartAttempts++
                if (s2CatchAllRestartAttempts > 10) {
                    Log.w(TAG, "S2: catch-all restart limit title='$title' pkg=${root.packageName}")
                    fail("多次尝试均无法进入无线调试，请手动操作")
                } else {
                    Log.d(TAG, "S2: catch-all restart attempt=$s2CatchAllRestartAttempts")
                    scheduleRetry(600) { goToWirelessDebugging() }
                }
            }
        }
    }

    /** R-2f: 发起「无线」搜索 */
    private fun initiateWirelessSearch(root: AccessibilityNodeInfo) {
                        val searchBox = findSearchBox(root)
                        if (searchBox != null) {
            s2.waitForSearchBoxRetries = 0
            s2.wirelessSearchInFlight = true
            s2.wirelessSearchResultRetries = 0
            searchBox.recycle()
            report(step = 2, state = "IN_PROGRESS", msg = "正在设置中搜索「无线」…")
                            trySearchInSettings(root, "无线") { ok ->
                scheduleRetry(if (ok) 700 else 500) { handleOpenWirelessDebugStage() }
            }
        } else if (!s2.triedClickSearchButtonForWireless && tryClickSearchButtonToOpen(root)) {
            s2.triedClickSearchButtonForWireless = true
            s2.wirelessSearchInFlight = true
            s2.wirelessSearchResultRetries = 0
            scheduleRetry(700) { handleOpenWirelessDebugStage() }
        } else if (s2.waitForSearchBoxRetries < 2) {
            s2.waitForSearchBoxRetries++
            Log.d(TAG, "S2: search box not ready, wait retry #${s2.waitForSearchBoxRetries}")
            scheduleRetry(800) { handleOpenWirelessDebugStage() }
                        } else {
            s2.waitForSearchBoxRetries = 0
            s2.triedSearchWireless = true
            s2.wirelessSearchInFlight = false
                            scheduleRetry(500) { handleOpenWirelessDebugStage() }
                        }
                    }

    /** R-2g: 发起「开发」搜索 */
    private fun initiateDeveloperSearch(root: AccessibilityNodeInfo) {
                        val searchBox = findSearchBox(root)
                        if (searchBox != null) {
            s2.waitForSearchBoxRetries = 0
            s2.triedSearchDeveloper = true
            searchBox.recycle()
            report(step = 2, state = "IN_PROGRESS", msg = "正在设置中搜索「开发」…")
                            trySearchInSettings(root, "开发") { ok ->
                scheduleRetry(if (ok) 700 else 500) { handleOpenWirelessDebugStage() }
            }
        } else if (!s2.triedClickSearchButtonForDev && tryClickSearchButtonToOpen(root)) {
            s2.triedClickSearchButtonForDev = true
            scheduleRetry(700) { handleOpenWirelessDebugStage() }
        } else if (s2.waitForSearchBoxRetries < 2) {
            s2.waitForSearchBoxRetries++
            scheduleRetry(800) { handleOpenWirelessDebugStage() }
                        } else {
            Log.w(TAG, "S2: no search box (pkg=${root.packageName}), mark developer search tried")
            s2.waitForSearchBoxRetries = 0
            s2.triedSearchDeveloper = true
                            scheduleRetry(500) { handleOpenWirelessDebugStage() }
                        }
                    }

    /** R-2h: 点击「开发者选项」入口 */
    private fun clickDevOptionsEntry(root: AccessibilityNodeInfo, devNode: AccessibilityNodeInfo) {
        s2.aboutPhoneToMainCount = 0
        if (s2.settingsPageClickRetries >= 3) {
            Log.d(TAG, "S2: 点击开发者选项多次未跳转，改为滚动列表再试")
            s2.settingsPageClickRetries = 0
            devNode.recycle()
            report(step = 2, state = "IN_PROGRESS", msg = "正在列表中查找…")
            scheduleScroll { handleOpenWirelessDebugStage() }
            return
        }
        if (!isSettingsApp(root)) {
            devNode.recycle()
            Log.d(TAG, "S2: not in Settings app, wait 500ms")
            scheduleRetry(500) { handleOpenWirelessDebugStage() }
            return
        }
        s2.devNodeTotalClickAttempts++
        s2.settingsPageClickRetries++
        val clicked = clickIfVisibleOrRetry(
            "S2: developer options", "settings_main", devNode
        ) {
            scheduleScroll { handleOpenWirelessDebugStage() }
        }
        if (!clicked) return
        scheduleRetry(600) {
            val newRoot = rootInActiveWindow
            if (newRoot != null) {
                val newTitle = getPageTitle(newRoot)
                if (!isOnDeveloperOptionsPage(newRoot, newTitle)) {
                    Log.w(TAG, "S2: devNode click didn't enter dev opts (title='$newTitle'), force search")
                    s2.settingsPageClickRetries = 3
                }
                newRoot.recycle()
            }
            handleOpenWirelessDebugStage()
        }
    }

    // ─── Stage 3：开启无线调试开关 ──────────────────────────────

    private fun handleEnableSwitchStage() {
        if (stage != Stage.ENABLING_SWITCH) return
        if (!ensureWithinTotalTimeout("S3")) return
        val root = rootInActiveWindow ?: return
        try {
            val title = getPageTitle(root)
            if (!isOnWirelessDebugDetailPage(root, title)) {
                AppDebugLog.w(TAG, "S3 guard: not on wireless detail page (title='$title'), back to Stage2")
                stage = Stage.OPENING_WIRELESS_DEBUG
                scheduleRetry(500) { handleOpenWirelessDebugStage() }
                return
            }

            if (!isSettingsApp(root)) {
                offSettingsRetryCount++
                Log.d(TRACE, "gate_s3_blocked retry=$offSettingsRetryCount pkg=${root.packageName} title=$title")
                if (offSettingsRetryCount % 2 == 1) {
                    try {
                        startActivity(
                            Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                    } catch (e: Exception) {
                        Log.w(TAG, "S3: reopen development settings failed: ${e.message}")
                    }
                }
                scheduleRetry(800) { handleEnableSwitchStage() }
                return
            }
            offSettingsRetryCount = 0

        if (dismissAnyDialog(root)) {
                scheduleRetry(600) { handleEnableSwitchStage() }
                return
        }

        val switch = findWirelessDebugSwitch(root)
        Log.d(TAG, "S3: switch=${switch?.className} checked=${switch?.isChecked} scroll=$scrollCount")

        when {
            switch == null -> {
                if (scrollCount < 8) {
                    scheduleScroll { handleEnableSwitchStage() }
                } else {
                    fail("未找到无线调试开关，请手动开启")
                }
            }
                forceRestartWirelessDebug -> {
                    handleRestartWirelessDebug(switch)
            }
            isEnabled(switch) -> {
                Log.d(TAG, "S3: Switch is ALREADY ON")
                    switch.recycle()
                report(step = 3, state = "DONE", msg = "无线调试已开启")
                stage = Stage.OPENING_QR_PAIRING
                scrollCount = 0
                    qrEntryClickRetryCount = 0
                    dialogConfirmClickRetryCount = 0
                handleQrPairingStage()
            }
            else -> {
                    Log.d(TAG, "S3: Clicking switch to enable")
                val clickTarget = findBestClickable(switch) ?: switch
                clickTarget.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    recycleDistinct(clickTarget, switch)
                scheduleRetry(1000) { handleEnableSwitchStage() }
                }
            }
        } finally {
            root.recycle()
        }
    }

    /** S3 forceRestart 子流程（关→开→确认），从 handleEnableSwitchStage 提取 */
    private fun handleRestartWirelessDebug(switch: AccessibilityNodeInfo) {
        val enabled = isEnabled(switch)
        when (restartPhase) {
            0 -> {
                if (enabled) {
                    if (restartToggleAttempts++ > 3) {
                        switch.recycle(); fail("重置无线调试失败，请手动操作")
                    } else {
                        Log.d(TAG, "S3: restart step=OFF attempt=$restartToggleAttempts")
                        val ct = findBestClickable(switch) ?: switch
                        ct.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                        recycleDistinct(ct, switch)
                        restartPhase = 1
                        scheduleRetry(1000) { handleEnableSwitchStage() }
                    }
                } else {
                    switch.recycle()
                    restartPhase = 1
                    scheduleRetry(400) { handleEnableSwitchStage() }
                }
            }
            1 -> {
                if (!enabled) {
                    if (restartToggleAttempts++ > 6) {
                        switch.recycle(); fail("重置无线调试失败，请手动操作")
                    } else {
                        Log.d(TAG, "S3: restart step=ON attempt=$restartToggleAttempts")
                        val ct = findBestClickable(switch) ?: switch
                        ct.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                        recycleDistinct(ct, switch)
                        restartPhase = 2
                        scheduleRetry(1000) { handleEnableSwitchStage() }
                    }
                } else {
                    switch.recycle()
                    restartPhase = 0
                    scheduleRetry(400) { handleEnableSwitchStage() }
                }
            }
            else -> {
                if (enabled) {
                    Log.d(TAG, "S3: restart done, proceed to pairing")
                    forceRestartWirelessDebug = false
                    restartPhase = 0
                    restartToggleAttempts = 0
                    switch.recycle()
                    report(step = 3, state = "DONE", msg = "无线调试已开启")
                    stage = Stage.OPENING_QR_PAIRING
                    scrollCount = 0
                    qrEntryClickRetryCount = 0
                    dialogConfirmClickRetryCount = 0
                    handleQrPairingStage()
                } else {
                    switch.recycle()
                    restartPhase = 1
                    scheduleRetry(400) { handleEnableSwitchStage() }
                }
            }
        }
    }

    // ─── Stage 4：打开二维码配对弹窗 ────────────────────────────

    private fun handleQrPairingStage() {
        if (stage != Stage.OPENING_QR_PAIRING) return
        if (!ensureWithinTotalTimeout("S4")) return
        val root = rootInActiveWindow ?: return
        try {
        if (dismissAnyDialog(root)) {
                scheduleRetry(600) { handleQrPairingStage() }
                return
        }
        val qrEntry = findQrPairingEntry(root)
        if (qrEntry != null) {
            Log.d(TAG, "S4: QR pairing entry found, clicking")
                val clicked = clickIfVisibleOrRetry(
                    "S4: QR pairing entry", "qr_entry", qrEntry
                ) {
                    if (qrEntryClickRetryCount++ < 2) {
                        Log.d(TAG, "S4: QR entry not visible, retry #$qrEntryClickRetryCount")
                        scheduleScroll { handleQrPairingStage() }
                    } else {
                        fail("二维码入口不可见，请手动打开配对页")
                    }
                }
                if (clicked) {
                    qrEntryClickRetryCount = 0
            waitForPairingDialog()
                }
        } else if (scrollCount < 5) {
            scheduleScroll { handleQrPairingStage() }
        } else {
            fail("找不到「使用二维码配对」入口")
            }
        } finally {
            root.recycle()
        }
    }

    /**
     * R-4: 上限从 25 次（20 s）缩短至 10 次（8 s），每轮同步上报进度。
     */
    private fun waitForPairingDialog() {
        if (stage != Stage.OPENING_QR_PAIRING) return
        if (!ensureWithinTotalTimeout("S4")) return
        val root = rootInActiveWindow
        if (root != null) {
            try {
                if (isPairingDialogPresent(root)) {
            Log.d(TAG, "S4: QR Pairing dialog detected! ALL DONE.")
            markDoneAndClearQueue(step = 4, msg = "配置完成，请扫码")
            return
        }
            } finally {
                root.recycle()
            }
        }
        if (pairingWaitCount++ > 10) {   // R-4: 原为 25
            fail("等待配对弹窗超时，请确认是否已手动关闭或文案不匹配")
            return
        }
        // R-4: 实时进度反馈
        report(step = 4, state = "IN_PROGRESS", msg = "正在等待配对弹窗… ($pairingWaitCount/10)")
        Log.d(TAG, "S4: waiting for dialog... ($pairingWaitCount)")
        isPendingRetry = true
        handler.postDelayed({
            isPendingRetry = false
            waitForPairingDialog()
        }, 800)
    }

    // ─── 离厂后：关闭开发者选项总开关 ─────────────────────────────

    private fun handleDisableDevOptionsStage() {
        if (stage != Stage.DISABLING_DEV_OPTIONS) return
        val elapsed = SystemClock.elapsedRealtime() - disableDevFlowStartMs
        if (elapsed > disableDevMaxMs) {
            finishDisableDevOptionsManual()
            return
        }
        if (!isDeveloperOptionsEnabled()) {
            finishDisableDevOptionsSuccess()
            return
        }
        val root = rootInActiveWindow ?: run {
            scheduleRetry(500) { handleDisableDevOptionsStage() }
            return
        }
        try {
            val title = getPageTitle(root)
            if (dismissAnyDialog(root)) {
                scheduleRetry(600) { handleDisableDevOptionsStage() }
                return
            }
            if (!isSettingsApp(root)) {
                report(
                    step = 5,
                    state = "IN_PROGRESS",
                    msg = "请输入解锁密码或验证身份，完成后将自动继续关闭开发者选项…"
                )
                scheduleRetry(1500) { handleDisableDevOptionsStage() }
                return
            }
            if (isOnDeveloperOptionsPage(root, title)) {
                val sw = findDeveloperOptionsMasterSwitch(root)
                when {
                    sw == null -> {
                        if (scrollCount < 8) {
                            scheduleScroll { handleDisableDevOptionsStage() }
                        } else {
                            finishDisableDevOptionsManual()
                        }
                    }
                    !isEnabled(sw) -> {
                        sw.recycle()
                        if (!isDeveloperOptionsEnabled()) {
                            finishDisableDevOptionsSuccess()
                        } else {
                            scheduleRetry(800) { handleDisableDevOptionsStage() }
                        }
                    }
                    else -> {
                        val clickTarget = findBestClickable(sw) ?: sw
                        clickTarget.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                        recycleDistinct(clickTarget, sw)
                        report(step = 5, state = "IN_PROGRESS", msg = "正在关闭开发者选项总开关…")
                        scheduleRetry(1200) { handleDisableDevOptionsStage() }
                    }
                }
                return
            }
            val devEntry = findDeveloperOptionsEntryNode(root)
            if (devEntry != null && disableDevRetryCount < 14) {
                disableDevRetryCount++
                val clickTarget = findBestClickable(devEntry) ?: devEntry
                clickTarget.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                recycleDistinct(clickTarget, devEntry)
                report(step = 5, state = "IN_PROGRESS", msg = "正在打开开发者选项…")
                scheduleRetry(900) { handleDisableDevOptionsStage() }
                return
            }
            disableDevRetryCount++
            if (disableDevRetryCount > 18) {
                finishDisableDevOptionsManual()
            } else {
                if (disableDevRetryCount % 6 == 0) {
                    try {
                        startActivity(
                            Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                    } catch (e: Exception) {
                        Log.w(TAG, "disableDev: reopen dev settings failed: ${e.message}")
                    }
                }
                scheduleRetry(800) { handleDisableDevOptionsStage() }
            }
        } finally {
            root.recycle()
        }
    }

    private fun finishDisableDevOptionsSuccess() {
        if (stage != Stage.DISABLING_DEV_OPTIONS) return
        isPendingRetry = false
        handler.removeCallbacksAndMessages(null)
        stage = Stage.DONE
        report(step = 5, state = "DONE", msg = "开发者选项已关闭")
        Toast.makeText(this, "开发者模式已关闭", Toast.LENGTH_SHORT).show()
        AppDebugLog.i(TAG, "disableDevAfterExit success")
    }

    private fun finishDisableDevOptionsManual() {
        if (stage != Stage.DISABLING_DEV_OPTIONS) return
        isPendingRetry = false
        handler.removeCallbacksAndMessages(null)
        stage = Stage.DONE
        Toast.makeText(
            this,
            "请手动在设置中关闭「开发者选项」总开关。",
            Toast.LENGTH_LONG
        ).show()
        AppDebugLog.w(TAG, "disableDevAfterExit manual/timeout")
    }

    @Suppress("DEPRECATION")
    private fun findDeveloperOptionsMasterSwitch(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        // Stage 5 需要定位「开发者选项」总开关。
        // 不同 ROM 可能把文案包装成：使用“开发者选项”“使用 '开发者选项'”等，导致 findAccessibilityNodeInfosByText(label) 精确匹配失败。
        // 这里改为遍历无障碍树，基于 text/contentDescription 做包含匹配来消除这种差异。
        val keywords = listOf(
            "开发者选项",
            "开发人员选项",
            "Developer options",
            "Use developer options"
        )

        val candidateNodes = mutableListOf<AccessibilityNodeInfo>()
        val queue = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        queue.addLast(root to 0)
        val maxVisited = 1200
        var visited = 0

        while (queue.isNotEmpty() && visited < maxVisited) {
            val (node, depth) = queue.removeFirst()
            visited++
            if (depth > 8) {
                if (node !== root) node.recycle()
                continue
            }

            val className = node.className?.toString() ?: ""
            val isEditText = className.contains("EditText", ignoreCase = true)

            val text = node.text?.toString()
            val contentDesc = node.contentDescription?.toString()
            val matched = !isEditText && (
                (text != null && keywords.any { kw -> text.contains(kw, ignoreCase = true) }) ||
                    (contentDesc != null && keywords.any { kw -> contentDesc.contains(kw, ignoreCase = true) })
                )

            if (matched && node !== root) {
                // 暂不 recycle，后面定位开关后再统一释放
                candidateNodes.add(node)
            } else {
                if (node !== root) node.recycle()
            }

            if (depth < 8) {
                for (i in 0 until node.childCount) {
                    node.getChild(i)?.let { child ->
                        queue.addLast(child to (depth + 1))
                    }
                }
            }
        }

        var bestSw: AccessibilityNodeInfo? = null
        var bestTop = Int.MAX_VALUE

        for (labelNode in candidateNodes) {
            var foundSw: AccessibilityNodeInfo? = null
            try {
                var row: AccessibilityNodeInfo? = labelNode.parent
                repeat(8) {
                    val p = row ?: return@repeat
                    foundSw = findSwitchInSubtree(p)
                    if (foundSw != null) return@repeat
                    val next = p.parent
                    p.recycle()
                    row = next
                }
            } finally {
                // 释放 labelNode
                labelNode.recycle()
            }

            val sw = foundSw ?: continue
            val r = Rect()
            sw.getBoundsInScreen(r)
            if (r.top < bestTop) {
                bestSw?.recycle()
                bestSw = sw
                bestTop = r.top
            } else {
                sw.recycle()
            }
        }

        // 队列剩余节点（未访问）不会持有，因为我们在出队时会处理 recycle/入候选
        return bestSw
    }

    // ─── 页面识别工具 ─────────────────────────────────────────────

    @Suppress("DEPRECATION")
    private fun getPageTitle(root: AccessibilityNodeInfo): String {
        val titleIds = listOf(
            "android:id/title",
            "com.android.settings:id/title",
            "android:id/action_bar_title",
            "com.android.settings:id/action_bar_title"
        )
        for (id in titleIds) {
            val nodes = root.findAccessibilityNodeInfosByViewId(id)
            try {
                nodes.firstOrNull()?.text?.toString()?.let { return it }
            } finally {
                nodes.forEach { it.recycle() }
            }
        }
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            try {
                val rect = Rect()
                child.getBoundsInScreen(rect)
                if (child.className?.contains("TextView") == true && rect.top < 200) {
                    child.text?.toString()?.let { return it }
                }
            } finally {
                child.recycle()
            }
        }
        return ""
    }

    private fun isOnMainSettingsPage(root: AccessibilityNodeInfo, title: String): Boolean {
        if (title.contains("设置") || title.contains("Settings") || title.isEmpty()) {
            val node = findAboutPhoneNode(root)
            node?.recycle()
            return node != null
        }
        return false
    }

    private fun isWirelessDebuggingEnabled(): Boolean {
        return try {
            val adbWifi = Settings.Global.getInt(contentResolver, "adb_wifi_enabled", 0)
            if (adbWifi == 1) return true
            Settings.Global.getInt(contentResolver, "wireless_debugging_enabled", 0) == 1
        } catch (_: Exception) { false }
    }

    private fun isDeveloperOptionsEnabled(): Boolean {
        return try {
            Settings.Global.getInt(contentResolver, "development_settings_enabled", 0) == 1
        } catch (_: Exception) { false }
    }

    @Suppress("DEPRECATION")
    private fun isOnDeveloperOptionsPage(root: AccessibilityNodeInfo, title: String): Boolean {
        val titleKeywords = listOf(
            "开发者选项", "开发人员选项", "开发人员设置",
            "Developer options", "Development settings"
        )
        if (titleKeywords.any { title.contains(it) }) return true
        val usbNodes = root.findAccessibilityNodeInfosByText("USB 调试")
        val usbFound = usbNodes.isNotEmpty()
        usbNodes.forEach { it.recycle() }
        if (usbFound) return true
        val usbEngNodes = root.findAccessibilityNodeInfosByText("USB debugging")
        val usbEngFound = usbEngNodes.isNotEmpty()
        usbEngNodes.forEach { it.recycle() }
        return usbEngFound
    }

    @Suppress("DEPRECATION")
    private fun isOnWirelessDebugPage(root: AccessibilityNodeInfo, title: String): Boolean {
        val keywords = listOf("无线调试", "Wireless debugging", "WLAN 调试")
        if (keywords.any { title.contains(it) }) return true
        val pairingKeywords = listOf("配对码", "pairing code", "二维码", "QR code")
        for (kw in pairingKeywords) {
            val nodes = root.findAccessibilityNodeInfosByText(kw)
            val found = nodes.isNotEmpty()
            nodes.forEach { it.recycle() }
            if (found) return true
        }
        return false
    }

    /**
     * 比 isOnWirelessDebugPage 更严格：用于 Stage2→Stage3 过渡和 Stage3 页面守卫。
     * 避免在开发者列表页因标题/列表项命中“无线调试”而误入 Stage3。
     */
    @Suppress("DEPRECATION")
    private fun isOnWirelessDebugDetailPage(root: AccessibilityNodeInfo, title: String): Boolean {
        val titleHit = listOf("无线调试", "Wireless debugging", "WLAN 调试").any { title.contains(it) }
        val pairingKeywords = listOf("配对码", "pairing code", "二维码", "QR code")
        val pairingHit = pairingKeywords.any { kw ->
            val nodes = root.findAccessibilityNodeInfosByText(kw)
            val found = nodes.isNotEmpty()
            nodes.forEach { it.recycle() }
            found
        }
        val qrEntry = findQrPairingEntry(root)
        val hasQrEntry = qrEntry != null
        qrEntry?.recycle()
        val devEntry = findDeveloperOptionsEntryNode(root)
        val hasDevEntry = devEntry != null
        devEntry?.recycle()

        if (pairingHit || hasQrEntry) return true
        if (titleHit && !hasDevEntry && !isOnDeveloperOptionsPage(root, title)) return true
        return false
    }

    private fun isOnAboutPhonePage(root: AccessibilityNodeInfo, title: String): Boolean {
        if (title.contains("关于") || title.contains("About")) return true
        if (title.contains("手机") || title.contains("设备") || title.contains("Device") ||
            title.contains("本机") || title.contains("Info") || title.contains("信息")) {
            val node = findBuildNumberNode(root)
            node?.recycle()
            return node != null
        }
        return false
    }

    private fun isSettingsApp(root: AccessibilityNodeInfo): Boolean {
        val pkg = root.packageName?.toString() ?: return false
        return pkg.contains("settings", ignoreCase = true) ||
            pkg.contains("setting", ignoreCase = true) ||
            pkg.contains("com.huawei.android", ignoreCase = true) ||
            pkg.contains("com.hihonor", ignoreCase = true) ||
            pkg.contains("com.android.settings", ignoreCase = true) ||
            pkg.endsWith(".settings", ignoreCase = true)
    }

    // ─── 节点搜索工具 ─────────────────────────────────────────────

    private fun findAboutPhoneNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? =
        findNodeByTexts(root, listOf("关于手机", "关于设备", "About phone", "About device", "My device", "我的设备"))

    private fun findBuildNumberNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? =
        findNodeByTexts(root, listOf("版本号", "Build number", "版本信息"))

    private fun findDeveloperOptionsEntryNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        // Stage 2：需要点击「开发者选项入口」进入列表。
        // 不同 ROM 可能出现：开发者选项 / 开发人员选项 / 使用“开发者选项”等差异，
        // 因此改为遍历 + 包含匹配（text/contentDescription），避免精确匹配失败。
        val keywords = listOf(
            "开发者选项",
            "开发人员选项",
            "开发人员设置",
            "Developer options",
            "Development settings",
            "Use developer options",
            "使用开发者选项"
        )

        val queue = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        queue.addLast(root to 0)

        val candidates = mutableListOf<AccessibilityNodeInfo>()
        val maxVisited = 1500
        var visited = 0
        val maxDepth = 10

        while (queue.isNotEmpty() && visited < maxVisited) {
            val (node, depth) = queue.removeFirst()
            visited++
            if (depth > maxDepth) {
                if (node !== root) node.recycle()
                continue
            }

            val cn = node.className?.toString() ?: ""
            val isEditText = cn.contains("EditText", ignoreCase = true)
            val text = node.text?.toString()
            val desc = node.contentDescription?.toString()

            val matched = !isEditText && node !== root && (
                (text != null && keywords.any { kw -> text.contains(kw, ignoreCase = true) }) ||
                    (desc != null && keywords.any { kw -> desc.contains(kw, ignoreCase = true) })
                )

            if (matched) {
                candidates.add(node)
            } else {
                if (node !== root) node.recycle()
            }

            if (depth < maxDepth) {
                for (i in 0 until node.childCount) {
                    node.getChild(i)?.let { child ->
                        queue.addLast(child to (depth + 1))
                    }
                }
            }
        }

        if (candidates.isEmpty()) return null

        // 优先选择：可点击 + 更靠上的节点（bestTop 最小）
        var best: AccessibilityNodeInfo? = null
        var bestScore = Long.MAX_VALUE

        for (n in candidates) {
            val clickable = n.isClickable && n.isEnabled && n.isVisibleToUser
            val prio = if (clickable) 0L else 1L
            val r = Rect()
            n.getBoundsInScreen(r)
            val score = prio * 1_000_000L + r.top.toLong()

            if (score < bestScore) {
                best?.recycle()
                best = n
                bestScore = score
            } else {
                n.recycle()
            }
        }

        return best
    }

    private fun findQrPairingEntry(root: AccessibilityNodeInfo): AccessibilityNodeInfo? =
        findNodeByTexts(root, listOf("使用二维码配对", "Pair device with QR code", "二维码配对"))

    @Suppress("DEPRECATION")
    private fun findNodeByTexts(root: AccessibilityNodeInfo, labels: List<String>): AccessibilityNodeInfo? {
        for (label in labels) {
            val nodes = root.findAccessibilityNodeInfosByText(label)
            if (nodes.isNotEmpty()) {
                nodes.drop(1).forEach { it.recycle() }
                return nodes[0]
            }
            nodes.forEach { it.recycle() }
        }
        return null
    }

    @Suppress("DEPRECATION")
    private fun findWirelessDebugEntryNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val labels = listOf(
            "无线调试", "Wireless debugging", "WLAN 调试", "WLAN debugging",
            "Wi-Fi 调试", "WiFi 调试", "Wi\u2011Fi 调试",
            "无线调试 (Wi-Fi)", "Wireless debugging (Wi-Fi)",
            "Wi-Fi debugging", "WiFi debugging", "Wi\u2011Fi debugging",
            "ADB 无线调试", "无线调试（ADB）", "ADB over Wi-Fi", "ADB over WiFi",
            "无线 ADB 调试", "无线ADB调试", "无线调试（安全）", "无线调试（安全设置）",
            "Wireless ADB debugging", "ADB wireless debugging"
        )
        for (label in labels) {
            val nodes = root.findAccessibilityNodeInfosByText(label)
            for (n in nodes) {
                if (n.className?.toString()?.contains("EditText") == true) {
                    n.recycle(); continue
                }
                nodes.filter { it !== n }.forEach { it.recycle() }
                return n
            }
            nodes.forEach { it.recycle() }
        }
        findWirelessDebugBySplitLabel(root)?.let { return it }
        findWirelessDebugByLooseText(root)?.let { return it }
        return null
    }

    @Suppress("DEPRECATION")
    private fun findWirelessDebugBySplitLabel(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val wirelessParts = listOf("无线", "WLAN", "Wi-Fi", "WiFi")
        val debugParts = listOf("调试", "debug")
        for (wirePart in wirelessParts) {
            val nodes = root.findAccessibilityNodeInfosByText(wirePart)
            for (n in nodes) {
                if (n.className?.toString()?.contains("EditText") == true) {
                    n.recycle()
                    continue
                }
                val nodeText = (n.text?.toString() ?: "") + " " + (n.contentDescription?.toString() ?: "")
                val parent = n.parent
                val parentText = if (parent != null) {
                    (parent.text?.toString() ?: "") + " " + (parent.contentDescription?.toString() ?: "")
                } else ""
                val hasDebugInNodeOrParent = debugParts.any {
                    nodeText.contains(it, ignoreCase = true) || parentText.contains(it, ignoreCase = true)
                }
                val hasDebugInParentSubtree = parent?.let { hasDescendantText(it, debugParts) } ?: false
                if (hasDebugInNodeOrParent || hasDebugInParentSubtree) {
                    nodes.filter { it !== n }.forEach { it.recycle() }
                    parent?.recycle()
                    return n
                }
                parent?.recycle()
                n.recycle()
            }
            // 内层 for 已对每个 n recycle，勿再 forEach(nodes) 二次 recycle
        }
        return null
    }

    private fun findWirelessDebugByLooseText(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        for (i in 0 until root.childCount) root.getChild(i)?.let { queue.addLast(it) }
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            val cls = node.className?.toString() ?: ""
            if (!cls.contains("EditText")) {
                val t = ((node.text?.toString() ?: "") + " " + (node.contentDescription?.toString() ?: "")).trim()
                if (isWirelessDebugLooseText(t)) {
                    while (queue.isNotEmpty()) queue.removeFirst().recycle()
                    return node
                }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { queue.addLast(it) }
            node.recycle()
        }
        return null
    }

    private fun isWirelessDebugLooseText(text: String): Boolean {
        if (text.isBlank()) return false
        val wirelessTokens = listOf("无线", "wlan", "wi-fi", "wifi", "adb over wi")
        val debugTokens = listOf("调试", "debug")
        val t = text.lowercase()
        return wirelessTokens.any { t.contains(it) } && debugTokens.any { t.contains(it) }
    }

    private fun hasDescendantText(root: AccessibilityNodeInfo, tokens: List<String>): Boolean {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        for (i in 0 until root.childCount) root.getChild(i)?.let { queue.addLast(it) }
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            val t = ((node.text?.toString() ?: "") + " " + (node.contentDescription?.toString() ?: "")).lowercase()
            if (tokens.any { t.contains(it.lowercase()) }) {
                while (queue.isNotEmpty()) queue.removeFirst().recycle()
                node.recycle()
                return true
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { queue.addLast(it) }
            node.recycle()
        }
        return false
    }

    @Suppress("DEPRECATION")
    private fun findSearchBox(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val searchIds = listOf(
            "com.android.settings:id/search_action_bar",
            "com.android.settings:id/search_src_text",
            "android:id/search_src_text",
            "com.android.settings:id/search_box",
            "com.huawei.android.settings:id/search_src_text",
            "com.hihonor.android.settings:id/search_src_text"
        )
        for (id in searchIds) {
            val nodes = root.findAccessibilityNodeInfosByViewId(id)
            if (nodes.isNotEmpty()) {
                nodes.drop(1).forEach { it.recycle() }
                return nodes[0]
            }
            nodes.forEach { it.recycle() }
        }
        val searchHints = listOf("搜索", "Search", "搜索设置", "搜索设置项")
        for (hint in searchHints) {
            val nodes = root.findAccessibilityNodeInfosByText(hint)
            var target: AccessibilityNodeInfo? = null
            for (n in nodes) {
                if (n.className?.toString()?.contains("EditText") == true) {
                    target = n; break
                }
                var p: AccessibilityNodeInfo? = n.parent
                val tempParents = mutableListOf<AccessibilityNodeInfo>()
                for (depth in 0 until 3) {
                    val parent = p ?: break
                    tempParents += parent
                    if (parent.className?.toString()?.contains("EditText") == true) {
                        target = parent; break
                    }
                    p = parent.parent
                }
                if (target == null) tempParents.forEach { it.recycle() }
                else { tempParents.filter { it !== target }.forEach { it.recycle() }; break }
            }
            nodes.filter { it !== target }.forEach { it.recycle() }
            if (target != null) return target
        }
        return null
    }

    private fun tryClickSearchButtonToOpen(root: AccessibilityNodeInfo): Boolean {
        val hints = listOf("搜索", "Search", "搜索设置")
        for (hint in hints) {
            val byText = root.findAccessibilityNodeInfosByText(hint)
            var clicked = false
            var processedUntil = -1
            for (i in byText.indices) {
                val n = byText[i]
                var scheduledRetry = false
                val didClick = clickIfVisibleOrRetry(
                    label = "S2: search button",
                    reason = "tryClickSearchButtonToOpen",
                    node = n
                ) {
                    if (s2.searchButtonClickRetryCount++ < 2) {
                        Log.d(TAG, "S2: search button not visible, retry #${s2.searchButtonClickRetryCount}")
                        scheduledRetry = true
                        scheduleRetry(500) { handleOpenWirelessDebugStage() }
                    } else {
                        Log.w(TAG, "S2: search button still not visible, give up")
                        s2.searchButtonClickRetryCount = 0
                    }
                }
                if (didClick) s2.searchButtonClickRetryCount = 0
                if (didClick || scheduledRetry) {
                    clicked = true; processedUntil = i; break
                }
                processedUntil = i
            }
            for (i in (processedUntil + 1) until byText.size) byText[i].recycle()
            if (clicked) return true
        }
        return false
    }

    /**
     * 搜索流程：先 ACTION_CLICK 聚焦，等 400ms 后再 ACTION_SET_TEXT。
     */
    private fun trySearchInSettings(
        root: AccessibilityNodeInfo,
        query: String,
        onResult: (Boolean) -> Unit
    ) {
        val searchNode = findSearchBox(root) ?: run { onResult(false); return }
        val clicked = searchNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        Log.d(TAG, "S2: search box click(聚焦)=$clicked")
        searchNode.recycle()
        isPendingRetry = true
        handler.postDelayed({
            isPendingRetry = false
            val newRoot = rootInActiveWindow ?: run { onResult(false); return@postDelayed }
            val newSearchNode = findSearchBox(newRoot) ?: run {
                newRoot.recycle(); onResult(false); return@postDelayed
            }
            val bundle = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, query)
            }
            val ok = newSearchNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
            Log.d(TAG, "S2: search box setText($query)=$ok")
            newSearchNode.recycle()
            newRoot.recycle()
            onResult(ok)
        }, 400)
    }

    // ─── 开关识别 ─────────────────────────────────────────────────

    private fun findWirelessDebugSwitch(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val labelNode = findWirelessDebugEntryNode(root) ?: return null
        var current: AccessibilityNodeInfo? = labelNode
        val ownedParents = mutableListOf<AccessibilityNodeInfo>()
        for (i in 0 until 4) {
            val p = current?.parent ?: break
            ownedParents += p
            current = p
            val sw = findSwitchInSubtree(p)
            if (sw != null) {
                if (sw !== labelNode) labelNode.recycle()
                ownedParents.filter { it !== sw }.forEach { it.recycle() }
                return sw
        }
        }
        ownedParents.forEach { it.recycle() }
        return labelNode
    }

    private fun findSwitchInSubtree(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val cn = node.className?.toString() ?: ""
        if (cn.contains("Switch") || cn.contains("ToggleButton") || node.isCheckable) return node
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        for (i in 0 until node.childCount) node.getChild(i)?.let { stack.addLast(it) }
        while (stack.isNotEmpty()) {
            val current = stack.removeLast()
            val currentCn = current.className?.toString() ?: ""
            if (currentCn.contains("Switch") || currentCn.contains("ToggleButton") || current.isCheckable) {
                while (stack.isNotEmpty()) stack.removeLast().recycle()
                return current
            }
            for (i in 0 until current.childCount) current.getChild(i)?.let { stack.addLast(it) }
            current.recycle()
        }
        return null
    }

    /**
     * R-3: 优先以 isChecked 为准，降级到字符串匹配时记录命中规则。
     * 避免在不支持中文描述的 ROM 上，isChecked=false 但开关实际已开的情况静默误判。
     */
    private fun isEnabled(node: AccessibilityNodeInfo): Boolean {
        if (node.isChecked) {
            Log.d(TAG, "isEnabled: matched via isChecked=true")
            return true
        }
        // 仅在 isChecked=false 时才降级，并记录命中规则
        val desc = node.contentDescription?.toString() ?: ""
        if (desc.isNotEmpty()) {
            val d = desc.trim()
            val matched = desc.contains("已开启") || desc.contains("已启用") ||
                desc.contains(" ON") ||
                d.equals("on", ignoreCase = true) ||
                d.endsWith(" on", ignoreCase = true) ||
                desc.contains("Enabled") || desc.contains("enabled")
            if (matched) {
                Log.d(TAG, "isEnabled: matched via node contentDescription='$desc'")
                return true
            }
        }
        val parent = node.parent ?: run {
            Log.d(TAG, "isEnabled: no parent, returning false (isChecked=false desc='$desc')")
            return false
        }
        return try {
        val parentDesc = parent.contentDescription?.toString() ?: ""
            val matched = parentDesc.contains("已开启") || parentDesc.contains("已启用") ||
                parentDesc.contains(" ON") || parentDesc.contains("Enabled")
            if (matched) {
                Log.d(TAG, "isEnabled: matched via parent contentDescription='$parentDesc'")
            } else {
                Log.d(TAG, "isEnabled: all checks failed (isChecked=false desc='$desc' parentDesc='$parentDesc')")
            }
            matched
        } finally {
            parent.recycle()
        }
    }

    // ─── 弹窗处理 ─────────────────────────────────────────────────

    @Suppress("DEPRECATION")
    private fun dismissAnyDialog(root: AccessibilityNodeInfo): Boolean {
        if (!canAutoDismissDialogOnCurrentPage(root)) return false
        val labels = dialogConfirmLabelsForCurrentStage()
        for (label in labels) {
            val nodes = root.findAccessibilityNodeInfosByText(label)
            var clicked = false
            for (node in nodes) {
                if (!clicked && node.isEnabled && isInDialog(node)) {
                    var scheduledRetry = false
                    val didClick = clickIfVisibleOrRetry(
                        label = "Dialog confirm",
                        reason = "stage=$stage label=$label",
                        node = node
                    ) {
                        if (dialogConfirmClickRetryCount++ < 2) {
                            Log.d(TAG, "Dialog confirm not visible, retry #$dialogConfirmClickRetryCount")
                            scheduledRetry = true
                            retryCurrentStageAfterDialog(400)
                        } else {
                            fail("弹窗按钮不可见，请手动确认后重试")
                        }
                    }
                    if (didClick) dialogConfirmClickRetryCount = 0
                    if (didClick || scheduledRetry) clicked = true
                } else {
                node.recycle()
                }
            }
            if (clicked) return true
        }
        return false
    }

    private fun dialogConfirmLabelsForCurrentStage(): List<String> = when (stage) {
        Stage.CLICKING_BUILD_NUMBER -> listOf("确定", "OK")
        Stage.OPENING_WIRELESS_DEBUG,
        Stage.ENABLING_SWITCH -> listOf("允许", "Allow", "开启", "Enable", "确定")
        Stage.OPENING_QR_PAIRING -> listOf("允许", "Allow", "确定")
        else -> emptyList()
    }

    private fun canAutoDismissDialogOnCurrentPage(root: AccessibilityNodeInfo): Boolean {
        if (!isSettingsApp(root)) return false
        return stage in listOf(
            Stage.CLICKING_BUILD_NUMBER,
            Stage.OPENING_WIRELESS_DEBUG,
            Stage.ENABLING_SWITCH,
            Stage.OPENING_QR_PAIRING
        )
    }

    private fun isInDialog(node: AccessibilityNodeInfo): Boolean {
        val tempParents = mutableListOf<AccessibilityNodeInfo>()
        var current: AccessibilityNodeInfo? = node
        for (i in 0 until 5) {
            val temp = current ?: break
            val cn = temp.className?.toString() ?: ""
            if (cn == "android.app.AlertDialog" ||
                cn == "androidx.appcompat.app.AlertDialog" ||
                (cn.contains("AlertDialog") && !cn.contains("Preference"))) {
                tempParents.forEach { it.recycle() }
                return true
        }
            val parent = temp.parent ?: break
            tempParents += parent
            current = parent
        }
        tempParents.forEach { it.recycle() }
        return false
    }

    @Suppress("DEPRECATION")
    private fun isPairingDialogPresent(root: AccessibilityNodeInfo): Boolean {
        val keywords = listOf("扫描二维码", "Scan QR code", "配对设备", "Pair device")
        for (kw in keywords) {
            val nodes = root.findAccessibilityNodeInfosByText(kw)
            val found = nodes.isNotEmpty()
            nodes.forEach { it.recycle() }
            if (found) return true
        }
        return false
    }

    // ─── 点击工具 ─────────────────────────────────────────────────

    private fun findBestClickable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var current: AccessibilityNodeInfo? = node
        val owned = mutableListOf<AccessibilityNodeInfo>()
        for (i in 0 until 5) {
            val temp = current ?: break
            if (temp.isClickable && temp.isEnabled && temp.isVisibleToUser) {
                owned.filter { it !== temp }.forEach { it.recycle() }
                return temp
            }
            current = temp.parent
            if (temp !== node) owned += temp
        }
        owned.forEach { it.recycle() }
        return null
    }

    private fun clickIfVisibleOrRetry(
        label: String,
        reason: String,
        node: AccessibilityNodeInfo,
        onNotVisible: () -> Unit
    ): Boolean {
        val clickTarget = findBestClickable(node) ?: node
        if (!clickTarget.isVisibleToUser) {
            Log.d(TAG, "$label target not visible, skip click (reason=$reason)")
            recycleDistinct(clickTarget, node)
            onNotVisible()
            return false
        }
        val clicked = clickTarget.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        if (!clicked && !clickTarget.isClickable) tryClickParentOrSibling(clickTarget)
        recycleDistinct(clickTarget, node)
        return clicked
    }

    private fun tryClickParentOrSibling(node: AccessibilityNodeInfo) {
        var current: AccessibilityNodeInfo? = node
        val ownedParents = mutableListOf<AccessibilityNodeInfo>()
        for (i in 0 until 8) {
            val p = current?.parent ?: break
            current = p
            ownedParents += p
            if (p.isClickable && p.isEnabled) {
                p.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                Log.d(TAG, "clicked parent at depth $i")
                break
            }
        }
        ownedParents.forEach { it.recycle() }
    }

    private fun retryCurrentStageAfterDialog(delayMs: Long) {
        isPendingRetry = true
        handler.postDelayed({
            isPendingRetry = false
            when (stage) {
                Stage.CLICKING_BUILD_NUMBER -> handleBuildNumberStage()
                Stage.OPENING_WIRELESS_DEBUG -> handleOpenWirelessDebugStage()
                Stage.ENABLING_SWITCH -> handleEnableSwitchStage()
                Stage.OPENING_QR_PAIRING -> handleQrPairingStage()
                else -> {}
            }
        }, delayMs)
    }

    // ─── R-5: 滚动（优先 ACTION_SCROLL_FORWARD）──────────────────

    /**
     * R-5: 优先对可滚动容器发 ACTION_SCROLL_FORWARD（精确、无副作用）；
     * 仅在找不到可滚动节点时降级为手势；手势在宽高比 < 1.2 时用保守范围。
     */
    private fun scrollDown() {
        val root = rootInActiveWindow
        if (root != null) {
            try {
                val scrollable = findScrollableContainer(root)
                if (scrollable != null) {
                    val ok = scrollable.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                    scrollable.recycle()
                    if (ok) {
                        Log.d(TAG, "scrollDown: used ACTION_SCROLL_FORWARD")
                        return
                    }
                }
            } finally {
                root.recycle()
            }
        }
        // 降级：手势滚动
        val m = resources.displayMetrics
        val aspectRatio = m.heightPixels.toFloat() / m.widthPixels.toFloat()
        // 折叠屏展开态 / 平板（宽高比 < 1.2）使用保守范围避免过滑
        val (startFrac, endFrac) = if (aspectRatio < 1.2f) 0.62f to 0.38f else 0.72f to 0.28f
        Log.d(TAG, "scrollDown: gesture fallback aspectRatio=${"%.2f".format(aspectRatio)}")
        val path = Path().apply {
            moveTo(m.widthPixels / 2f, m.heightPixels * startFrac)
            lineTo(m.widthPixels / 2f, m.heightPixels * endFrac)
        }
        dispatchGesture(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, 400))
                .build(),
            null, null
        )
    }

    /** BFS 查找第一个可滚动容器节点 */
    private fun findScrollableContainer(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        for (i in 0 until root.childCount) root.getChild(i)?.let { queue.addLast(it) }
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.isScrollable) {
                while (queue.isNotEmpty()) queue.removeFirst().recycle()
                return node
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { queue.addLast(it) }
            node.recycle()
        }
        return null
    }

    // ─── 调度工具 ─────────────────────────────────────────────────

    private fun scheduleScroll(retry: () -> Unit) {
        scrollCount++
        isPendingRetry = true
        scrollDown()
        handler.postDelayed({
            isPendingRetry = false
            retry()
        }, 500)
    }

    private fun scheduleRetry(delayMs: Long, retry: () -> Unit) {
        isPendingRetry = true
        handler.postDelayed({
            isPendingRetry = false
            retry()
        }, delayMs)
    }

    // ─── 广播 & 错误 ──────────────────────────────────────────────

    private fun report(step: Int, state: String, msg: String) {
        AppDebugLog.i(TAG, "step=$step state=$state stage=$stage msg=$msg")
        sendBroadcast(Intent(BROADCAST_STEP).apply {
            putExtra("step", step)
            putExtra("state", state)
            putExtra("msg", msg)
        })
    }

    private fun markDoneAndClearQueue(step: Int, msg: String) {
        stage = Stage.DONE
        isPendingRetry = false
        handler.removeCallbacksAndMessages(null)
        report(step = step, state = "DONE", msg = msg)
        sendBroadcast(Intent(BROADCAST_DONE))
    }

    private fun fail(reason: String) {
        Log.w(TAG, "FAIL: $reason")
        AppDebugLog.w(TAG, "fail stage=$stage reason=$reason")
        val failedStep = when (stage) {
            Stage.CLICKING_BUILD_NUMBER  -> 1
            Stage.OPENING_WIRELESS_DEBUG -> 2
            Stage.ENABLING_SWITCH        -> 3
            Stage.OPENING_QR_PAIRING     -> 4
            else -> 0
        }
        if (stage == Stage.OPENING_WIRELESS_DEBUG) {
            s2.scrollWirelessAfterSearchClick = false
        }
        stage = Stage.IDLE
        isPendingRetry = false
        handler.removeCallbacksAndMessages(null)
        report(step = failedStep, state = "FAILED", msg = reason)
        sendBroadcast(Intent(BROADCAST_FAILED).apply { putExtra("reason", reason) })
    }

    /**
     * R-1: s2 = Stage2State() 替代原版 15+ 行逐字段清零，不会遗漏新增字段。
     */
    private fun reset() {
        clickCount = 0
        scrollCount = 0
        retryCount = 0
        pairingWaitCount = 0
        isPendingRetry = false
        offSettingsRetryCount = 0
        qrEntryClickRetryCount = 0
        dialogConfirmClickRetryCount = 0
        flowStartElapsedMs = 0
        forceRestartWirelessDebug = false
        restartPhase = 0
        restartToggleAttempts = 0
        sawPinVerificationDuringS1 = false
        didPostPinTopUpClicks = false
        totalWirelessRetryCount = 0
        s2BothSearchesRestartAttempts = 0
        s2CatchAllRestartAttempts = 0
        s2 = Stage2State()   // R-1
        handler.removeCallbacksAndMessages(null)
    }

    private fun markFlowStart() {
        flowStartElapsedMs = SystemClock.elapsedRealtime()
    }

    private fun markFlowStartIfNeeded() {
        if (flowStartElapsedMs == 0L) flowStartElapsedMs = SystemClock.elapsedRealtime()
    }

    private fun ensureWithinTotalTimeout(stageTag: String): Boolean {
        if (flowStartElapsedMs == 0L) return true
        val elapsed = SystemClock.elapsedRealtime() - flowStartElapsedMs
        if (elapsed <= totalFlowTimeoutMs) return true
        Log.w(TAG, "flow timeout stage=$stageTag elapsedMs=$elapsed limitMs=$totalFlowTimeoutMs")
        fail("自动化总超时（${totalFlowTimeoutMs / 1000}s），请手动完成")
        return false
    }

    private fun recycleDistinct(vararg nodes: AccessibilityNodeInfo?) {
        val seen = HashSet<Int>()
        var recycledCount = 0
        for (node in nodes) {
            if (node == null) continue
            val id = System.identityHashCode(node)
            if (seen.add(id)) {
                node.recycle()
                recycledCount++
            }
        }
        if (recycledCount > 0) Log.d(TRACE, "recycle_nodes stage=$stage count=$recycledCount")
    }
}