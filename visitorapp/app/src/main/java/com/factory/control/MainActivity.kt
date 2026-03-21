package com.factory.control

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.*
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.IBinder
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import java.io.File
import java.io.OutputStreamWriter
import java.net.Inet4Address
import java.net.NetworkInterface
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * MainActivity — 单 Activity 状态机
 *
 * 修复：
 *  - [FIX-8] 修复 findViewById 返回 null 导致的闪退（补全所有视图引用检查）
 *  - [FIX-9] 增加 ContextCompat.registerReceiver 适配 Android 14 广播导出限制
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val REQ_DEVICE_ADMIN = 1001
        private const val TAG = "FactoryApp"
        // 调试开关：true 时强制走 Stage1→Stage2→Stage3 全流程，不走已开启快捷路径。
        private const val FORCE_FULL_AUTOMATION_FLOW_FOR_TEST = false
    }

    private var controlService: ControlService? = null
    private var serviceBound = false
    private var autoSetupDoneInCurrentWaiting = false
    /** 无障碍已开时：仅显示转圈+一句话，隐藏三步详情 */
    private var waitingUiSimpleMode = false

    private val serviceConn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            controlService = (binder as ControlService.LocalBinder).service
            serviceBound   = true
            controlService?.onStatusChanged = { status, msg ->
                runOnUiThread { onStatusChanged(status, msg) }
            }
            checkCurrentStatus()
            // Scheme 启动时服务可能尚未绑定，此处补连 WebSocket
            val sid = sessionId
            val url = serverUrl
            if (sid != null && url != null && currentState == AppState.WAITING && controlService?.isConnected() != true) {
                controlService?.connectToServer(url, sid)
            }
        }
        override fun onServiceDisconnected(name: ComponentName) { serviceBound = false }
    }

    private var serverUrl: String? = null
    private var sessionId: String? = null

    // View 引用
    private var layoutIdle:       View? = null
    private var layoutWaiting:    View? = null
    private var layoutRestricted: View? = null
    private var layoutExited:     View? = null

    private var tvIdleTitle:     TextView? = null
    private var tvIdleStatus:    TextView? = null
    private var tvWaitingTitle:  TextView? = null
    private var tvWaitingMsg:    TextView? = null
    private var tvRestrictedMsg: TextView? = null
    private var tvExitedMsg:     TextView? = null
    private var tvExitedIcon:    TextView? = null

    private var progressBar:     ProgressBar? = null
    private var progressBarExit: ProgressBar? = null

    private var btnScanEntry:        Button? = null
    private var btnScanExit:         Button? = null

    private var panelFirstTime:    LinearLayout? = null
    private var panelAutoSetup:    LinearLayout? = null
    private var panelManualSteps:  LinearLayout? = null
    private var tvShowManualSteps: TextView? = null
    private var btnGrantAccessibility: Button? = null
    private var btnFallbackManual:     Button? = null
    private var btnOpenWirelessDebug:  Button? = null
    private var btnRetryConnect:       Button? = null
    private var btnExportLogs:         Button? = null
    /** DEBUG：离场屏（EXITING/EXITED）上的导出，与入场等待页分离布局 */
    private var btnExportLogsExit:     Button? = null
    private var btnViewHelp:           Button? = null

    private var panelWorkingSimple:   LinearLayout? = null
    private var tvWaitingWorkingHint: TextView? = null
    private var panelFailureActions:  LinearLayout? = null

    private var progressStep1: ProgressBar? = null
    private var progressStep2: ProgressBar? = null
    private var progressStep3: ProgressBar? = null
    private var iconStep1: TextView? = null
    private var iconStep2: TextView? = null
    private var iconStep3: TextView? = null
    private var tvStep1Status: TextView? = null
    private var tvStep2Status: TextView? = null
    private var tvStep3Status: TextView? = null

    private val barcodeLauncher = registerForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@registerForActivityResult
        try {
            // 先尝试按“离场码”解析（JSON）
            val json = JSONObject(contents)
            if (json.optString("type") == "exit") {
                handleExitQR(contents)
            } else {
                handleEntryQR(contents)
            }
        } catch (_: Exception) {
            // 非 JSON，当作 URL 型入场码处理
            handleEntryQR(contents)
        }
    }

    private val backPressedCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {}
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        onBackPressedDispatcher.addCallback(this, backPressedCallback)
        bindViews()
        bindWaitingViews()
        showState(AppState.IDLE)

        Intent(this, ControlService::class.java).also {
            ContextCompat.startForegroundService(this, it)
            bindService(it, serviceConn, Context.BIND_AUTO_CREATE)
        }

        handleSchemeIntent(intent)

        if (serverUrl == null) discoverServer()

        val filter = IntentFilter().apply {
            addAction(SetupAutomationService.BROADCAST_STEP)
            addAction(SetupAutomationService.BROADCAST_DONE)
            addAction(SetupAutomationService.BROADCAST_FAILED)
        }
        
        // [FIX-9] 使用 ContextCompat 注册广播，统一处理 Android 14 导出标志
        ContextCompat.registerReceiver(
            this, setupReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleSchemeIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        checkCurrentStatus()
        // 若在等待态且已有会话但未连接，才重连（避免每次切回 APP 都重连导致双连接/UI 闪烁）
        if (currentState == AppState.WAITING && !sessionId.isNullOrBlank() && !serverUrl.isNullOrBlank() && controlService?.isConnected() != true) {
            controlService?.connectToServer(serverUrl!!, sessionId!!)
        }
        // 仅当自动化未在进行中时才进入等待态并重置步骤，避免从设置返回时清空进行中进度
        if (currentState == AppState.WAITING &&
            isAccessibilityServiceEnabled() &&
            !SetupAutomationService.isAutomationInProgress() &&
            !autoSetupDoneInCurrentWaiting) {
            enterWaitingState()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        try { unregisterReceiver(setupReceiver) } catch (_: Exception) {}
        stopDiscovery()
        if (serviceBound) unbindService(serviceConn)
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_DEVICE_ADMIN) {
            if (resultCode == Activity.RESULT_OK) {
                Toast.makeText(this, "截屏限制权限已激活", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "未授权截屏限制（管控功能部分受限）", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun handleSchemeIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "factorycontrol" || uri.host != "checkin") return

        val sid    = uri.getQueryParameter("sessionId")
        val server = uri.getQueryParameter("server")

        if (sid.isNullOrEmpty() || server.isNullOrEmpty()) return

        serverUrl = server
        sessionId = sid

        tvIdleTitle?.text = "正在为您办理入场"
        tvIdleStatus?.text = "保持本页打开即可"
        showState(AppState.DISCOVERING)

        val deviceIp = getLocalIp()
        if (deviceIp == null) {
            tvIdleTitle?.text = "请稍候"
            tvIdleStatus?.text = "请连接厂区 Wi‑Fi 后重试"
            showState(AppState.IDLE)
            return
        }

        Thread {
            try {
                val conn = (java.net.URL("$server/api/sessions/$sid/device")
                    .openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput      = true
                    connectTimeout = 8_000
                    readTimeout    = 8_000
                    setRequestProperty("Content-Type", "application/json")
                    outputStream.use {
                        java.io.OutputStreamWriter(it).apply {
                            write("""{"deviceIp":"$deviceIp"}"""); flush()
                        }
                    }
                }
                conn.responseCode
                runOnUiThread { controlService?.connectToServer(server, sid) }
                runOnUiThread { showState(AppState.WAITING) }
            } catch (e: Exception) {
                runOnUiThread {
                    tvIdleTitle?.text = "请稍候"
                    tvIdleStatus?.text = "暂时无法完成，请稍后重试或联系门卫"
                    showState(AppState.IDLE)
                }
            }
        }.start()
    }

    enum class AppState { IDLE, DISCOVERING, WAITING, RESTRICTED, EXITING, EXITED }
    private var currentState = AppState.IDLE

    private fun showState(state: AppState) {
        val prevState = currentState
        currentState = state
        layoutIdle?.visibility       = if (state == AppState.IDLE || state == AppState.DISCOVERING) View.VISIBLE else View.GONE
        layoutWaiting?.visibility    = if (state == AppState.WAITING)     View.VISIBLE else View.GONE
        layoutRestricted?.visibility = if (state == AppState.RESTRICTED)  View.VISIBLE else View.GONE
        layoutExited?.visibility     = if (state == AppState.EXITING || state == AppState.EXITED) View.VISIBLE else View.GONE
        progressBar?.visibility       = if (state == AppState.DISCOVERING) View.VISIBLE else View.GONE
        progressBarExit?.visibility   = if (state == AppState.EXITING)     View.VISIBLE else View.GONE
        tvExitedIcon?.visibility      = if (state == AppState.EXITED)      View.VISIBLE else View.GONE
        backPressedCallback.isEnabled = (state == AppState.RESTRICTED || state == AppState.EXITING)

        if (state != AppState.WAITING) {
            autoSetupDoneInCurrentWaiting = false
        }
        if (state == AppState.WAITING && prevState != AppState.WAITING) {
            autoSetupDoneInCurrentWaiting = false
            enterWaitingState()
        }

        if (state == AppState.RESTRICTED) {
            applyImmersiveMode(true)
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            applyImmersiveMode(false)
            if (state == AppState.IDLE || state == AppState.DISCOVERING) {
                window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
    }

    private fun checkCurrentStatus() {
        val status = controlService?.currentStatus ?: return
        if (status == "restricted" && currentState != AppState.RESTRICTED) {
            onStatusChanged("restricted", "")
        } else if (status == "exited" && (currentState == AppState.RESTRICTED || currentState == AppState.EXITING)) {
            onStatusChanged("exited", "")
        }
    }

    private fun onStatusChanged(status: String, message: String) {
        AppDebugLog.i("MainActivity", "onStatusChanged status=$status current=$currentState msg=$message")
        if (!shouldApplyIncomingStatus(status)) {
            Log.d(TAG, "Ignore stale status='$status' when currentState=$currentState")
            AppDebugLog.w("MainActivity", "ignore stale status=$status current=$currentState")
            return
        }
        when (status) {
            "pairing"    -> {
                showState(AppState.WAITING)
                if (waitingUiSimpleMode) {
                    tvWaitingWorkingHint?.text = "正在完成入场设置，请稍候"
                }
            }
            "restricted" -> {
                tvRestrictedMsg?.text = "离场时请扫描离场码"
                showState(AppState.RESTRICTED)
            }
            "paired_not_connected" -> {
                showState(AppState.WAITING)
                waitingUiSimpleMode = false
                panelWorkingSimple?.visibility = View.GONE
                tvWaitingTitle?.visibility = View.VISIBLE
                tvWaitingMsg?.visibility = View.VISIBLE
                tvWaitingTitle?.text = "请稍候"
                tvWaitingMsg?.text = "连接未就绪，请重试或查看说明"
                panelFailureActions?.visibility = View.VISIBLE
                btnViewHelp?.text = "查看说明"
                btnViewHelp?.visibility = View.VISIBLE
                btnRetryConnect?.visibility = View.VISIBLE
                btnFallbackManual?.visibility = View.VISIBLE
                btnFallbackManual?.text = "打开系统设置"
            }
            "exiting" -> { tvExitedMsg?.text = "正在办理离场…"; showState(AppState.EXITING) }
            "exited"  -> {
                tvExitedMsg?.text = "离场已办理，感谢配合"
                showState(AppState.EXITED)
                if (isAccessibilityServiceEnabled()) {
                    SetupAutomationService.instance?.startDisableDeveloperOptionsAfterExit()
                }
                // DEBUG 延长停留，便于导出含「离厂关开发者选项」的无障碍日志
                val exitHoldMs = if (BuildConfig.DEBUG) 15_000L else 3_000L
                layoutExited?.postDelayed({ resetToIdle() }, exitHoldMs)
            }
            "error" -> {
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                if (currentState == AppState.DISCOVERING || currentState == AppState.WAITING) {
                    tvIdleTitle?.text = "请稍候"
                    tvIdleStatus?.text = "暂时无法完成，请稍后重试"
                    showState(AppState.IDLE)
                }
            }
        }
    }

    /**
     * 只允许状态机“前进”，忽略乱序/重复的回退状态，避免 UI 在 WAITING/RESTRICTED/EXITING 之间抖动。
     */
    private fun shouldApplyIncomingStatus(status: String): Boolean {
        return when (currentState) {
            AppState.IDLE, AppState.DISCOVERING -> {
                status == "pairing" || status == "paired_not_connected" || status == "restricted" || status == "error"
            }
            AppState.WAITING -> {
                status == "pairing" || status == "paired_not_connected" || status == "restricted" || status == "error"
            }
            AppState.RESTRICTED -> {
                status == "restricted" || status == "exiting" || status == "exited"
            }
            AppState.EXITING -> {
                status == "exiting" || status == "exited"
            }
            AppState.EXITED -> {
                status == "exited"
            }
        }
    }

    private fun enterWaitingState() {
        if (isAccessibilityServiceEnabled()) {
            showAutoSetupPanel()
            val service = SetupAutomationService.instance
            if (service != null) {
                val started = if (FORCE_FULL_AUTOMATION_FLOW_FOR_TEST) {
                    false
                } else {
                    service.startQrPairingIfWirelessDebugEnabled()
                }
                if (started) {
                    tvWaitingWorkingHint?.text = "正在完成入场设置，请稍候"
                } else {
                    service.startDevModeAutomation()
                }
            } else {
                layoutWaiting?.postDelayed({
                    val started = if (FORCE_FULL_AUTOMATION_FLOW_FOR_TEST) {
                        false
                    } else {
                        SetupAutomationService.instance?.startQrPairingIfWirelessDebugEnabled() == true
                    }
                    if (started) {
                        tvWaitingWorkingHint?.text = "正在完成入场设置，请稍候"
                    } else {
                        SetupAutomationService.instance?.startDevModeAutomation()
                    }
                }, 500)
            }
        } else {
            showFirstTimePanel()
        }
    }

    private fun showFirstTimePanel() {
        waitingUiSimpleMode = false
        if (!AdminReceiver.isActive(this)) {
            AdminReceiver.requestActivation(this, REQ_DEVICE_ADMIN)
        }
        tvWaitingTitle?.visibility = View.VISIBLE
        tvWaitingMsg?.visibility = View.VISIBLE
        tvWaitingTitle?.text = "需要完成一次系统授权"
        tvWaitingMsg?.text = "按系统提示操作即可，仅用于本次入场"
        panelFirstTime?.visibility = View.VISIBLE
        panelWorkingSimple?.visibility = View.GONE
        panelFailureActions?.visibility = View.GONE
        panelManualSteps?.visibility = View.GONE
        tvShowManualSteps?.text = "查看说明 ▾"
        btnRetryConnect?.visibility = View.GONE
        btnFallbackManual?.visibility = View.GONE
        btnViewHelp?.visibility = View.GONE
    }

    private fun showAutoSetupPanel() {
        waitingUiSimpleMode = true
        panelFirstTime?.visibility = View.GONE
        panelManualSteps?.visibility = View.GONE
        panelFailureActions?.visibility = View.GONE
        btnRetryConnect?.visibility = View.GONE
        btnFallbackManual?.visibility = View.GONE
        btnViewHelp?.visibility = View.GONE
        tvWaitingTitle?.visibility = View.GONE
        tvWaitingMsg?.visibility = View.GONE
        panelWorkingSimple?.visibility = View.VISIBLE
        tvWaitingWorkingHint?.text = "正在完成入场设置，请稍候"
        setStepState(1, StepState.WAITING)
        setStepState(2, StepState.WAITING)
        setStepState(3, StepState.WAITING)
    }

    enum class StepState { WAITING, IN_PROGRESS, DONE, FAILED }

    /**
     * 自动化进度更新：步骤卡仅用图标表达状态（○/转圈/✓），
     * 主提示统一在 tvWaitingMsg 展示，减少访客认知负担。
     */
    private fun onAutoStepUpdate(step: Int, state: StepState, msg: String? = null) {
        setStepState(step, state)
        if (waitingUiSimpleMode) {
            when {
                step == 2 && state == StepState.DONE -> {
                    setStepState(3, StepState.IN_PROGRESS)
                    tvWaitingWorkingHint?.text = "请按门卫提示完成最后一步"
                }
                step == 3 && state == StepState.DONE || step == 4 && state == StepState.DONE ->
                    tvWaitingWorkingHint?.text = "请按门卫提示完成最后一步"
                state == StepState.FAILED -> applyWaitingFailureUi(msg)
            }
            return
        }
        if (!msg.isNullOrBlank()) tvWaitingMsg?.text = msg
        when {
            step == 1 && state == StepState.DONE -> {
                setStepState(2, StepState.IN_PROGRESS)
                tvWaitingMsg?.text = "请稍候…"
            }
            step == 2 && state == StepState.DONE -> {
                tvWaitingMsg?.text = "请按门卫提示完成最后一步"
                setStepState(3, StepState.IN_PROGRESS)
            }
            state == StepState.FAILED -> applyWaitingFailureUi(msg)
        }
    }

    private fun applyWaitingFailureUi(detail: String?) {
        waitingUiSimpleMode = false
        panelWorkingSimple?.visibility = View.GONE
        tvWaitingTitle?.visibility = View.VISIBLE
        tvWaitingMsg?.visibility = View.VISIBLE
        tvWaitingTitle?.text = "无法自动完成"
        tvWaitingMsg?.text = "可查看说明或打开系统设置"
        panelFailureActions?.visibility = View.VISIBLE
        btnViewHelp?.text = "查看说明"
        btnViewHelp?.visibility = View.VISIBLE
        btnFallbackManual?.visibility = View.VISIBLE
        btnFallbackManual?.text = "打开系统设置"
        if (!detail.isNullOrBlank()) {
            AppDebugLog.w("MainActivity", "waiting failure detail: $detail")
        }
    }

    /** 步骤卡仅用图标表达状态（○ / 转圈 / ✓ / ✗），状态文字已隐藏，减轻访客阅读负担。step=4 复用第 3 步 UI。 */
    private fun setStepState(step: Int, state: StepState) {
        val (pb, icon, _) = when (step) {
            1 -> Triple(progressStep1, iconStep1, tvStep1Status)
            2 -> Triple(progressStep2, iconStep2, tvStep2Status)
            3, 4 -> Triple(progressStep3, iconStep3, tvStep3Status)
            else -> return
        }
        when (state) {
            StepState.WAITING -> {
                pb?.visibility = View.GONE; icon?.visibility = View.VISIBLE
                icon?.text = "○"; icon?.setTextColor(getColor(R.color.step_inactive))
            }
            StepState.IN_PROGRESS -> {
                pb?.visibility = View.VISIBLE; icon?.visibility = View.GONE
            }
            StepState.DONE -> {
                pb?.visibility = View.GONE; icon?.visibility = View.VISIBLE
                icon?.text = "✓"; icon?.setTextColor(getColor(R.color.accent_green))
            }
            StepState.FAILED -> {
                pb?.visibility = View.GONE; icon?.visibility = View.VISIBLE
                icon?.text = "✗"; icon?.setTextColor(getColor(R.color.accent_red))
            }
        }
    }

    private val setupReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                SetupAutomationService.BROADCAST_STEP -> {
                    val step     = intent.getIntExtra("step", 0)
                    val stateStr = intent.getStringExtra("state") ?: "WAITING"
                    val state    = try {
                        StepState.valueOf(stateStr)
                    } catch (_: Exception) { StepState.WAITING }
                    onAutoStepUpdate(step, state, intent.getStringExtra("msg"))
                }
                SetupAutomationService.BROADCAST_DONE ->
                    run {
                        autoSetupDoneInCurrentWaiting = true
                        if (waitingUiSimpleMode) {
                            tvWaitingWorkingHint?.text = "请按门卫提示完成最后一步"
                        }
                        onAutoStepUpdate(3, StepState.DONE, null)
                    }
                SetupAutomationService.BROADCAST_FAILED -> {
                    autoSetupDoneInCurrentWaiting = true
                    val reason = intent.getStringExtra("reason") ?: ""
                    if (reason.contains("自动化总超时")) {
                        showTimeoutGuidance(reason)
                    } else {
                        applyWaitingFailureUi(reason)
                        if (reason.isNotBlank()) {
                            Toast.makeText(this@MainActivity, reason, Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
        }
    }

    private fun showTimeoutGuidance(reason: String) {
        waitingUiSimpleMode = false
        panelWorkingSimple?.visibility = View.GONE
        tvWaitingTitle?.visibility = View.VISIBLE
        tvWaitingMsg?.visibility = View.VISIBLE
        tvWaitingTitle?.text = "无法自动完成"
        tvWaitingMsg?.text = "可查看说明分步操作"
        panelFailureActions?.visibility = View.VISIBLE
        btnViewHelp?.visibility = View.VISIBLE
        btnFallbackManual?.visibility = View.VISIBLE
        btnFallbackManual?.text = "打开系统设置"
        btnRetryConnect?.visibility = View.GONE
        panelManualSteps?.visibility = View.VISIBLE
        tvShowManualSteps?.text = "收起 ▴"
        Toast.makeText(this@MainActivity, reason, Toast.LENGTH_LONG).show()
    }

    private fun startExitScan() {
        barcodeLauncher.launch(ScanOptions().apply {
            setPrompt("请扫描离厂码")
            setBeepEnabled(true)
        })
    }

    private fun startEntryScan() {
        barcodeLauncher.launch(ScanOptions().apply {
            setPrompt("请扫描自助入场码")
            setBeepEnabled(true)
        })
    }

    private fun handleExitQR(content: String) {
        try {
            val json  = JSONObject(content)
            if (json.getString("type") != "exit") return
            val sid   = json.getString("sessionId")
            val token = json.getString("exitToken")
            val url   = json.getString("serverUrl")

            tvExitedMsg?.text = "正在办理离场…"
            showState(AppState.EXITING)

            controlService?.notifyExitWithFallback(url, sid, token)
                ?: run { onStatusChanged("exited", "") }
        } catch (_: Exception) {
            Toast.makeText(this, "二维码无效，请重新扫描", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * 处理入场二维码：
     *  - 期望形态：形如 http://<ip>:<port>/api/checkin-start?area=...
     *  - 兼容旧版：/welcome?area=... 或直接 http://<ip>:<port>/welcome
     * 逻辑：
     *  1. 解析出 serverUrl（scheme+host+port）和 area
     *  2. 在 APP 内弹出极简表单收集「姓名」「公司」（可留空）
     *  3. 携带 name / company / area 调用 POST /api/checkin
     *  4. 成功后：保存 sessionId/serverUrl，连接 WebSocket，进入 WAITING
     */
    private fun handleEntryQR(content: String) {
        val uri = try {
            android.net.Uri.parse(content)
        } catch (e: Exception) {
            Toast.makeText(this, "二维码无效，请联系门卫", Toast.LENGTH_SHORT).show()
            return
        }
        val scheme = uri.scheme ?: ""
        val host   = uri.host ?: ""
        if (scheme !in listOf("http", "https") || host.isBlank()) {
            Toast.makeText(this, "二维码内容不支持，请联系门卫", Toast.LENGTH_SHORT).show()
            return
        }

        val port   = if (uri.port > 0) uri.port else 80
        val base   = "$scheme://$host" + if (port != 80 && port != 443) ":$port" else ""
        val area   = uri.getQueryParameter("area") ?: ""

        val server = base
        serverUrl  = server

        // 扫码后先在 APP 内收集姓名 + 公司，再发起 /api/checkin
        showEntryInfoDialog(server, area)
    }

    private fun showEntryInfoDialog(server: String, area: String) {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 32, 48, 8)
        }
        val etName = EditText(this).apply {
            hint = "姓名（可选）"
        }
        val etCompany = EditText(this).apply {
            hint = "公司（可选）"
        }
        container.addView(etName)
        container.addView(etCompany)

        AlertDialog.Builder(this)
            .setTitle("访客信息")
            .setView(container)
            .setNegativeButton("跳过") { dialog, _ ->
                dialog.dismiss()
                startCheckinWithInfo(server, area, "", "")
            }
            .setPositiveButton("开始入场") { dialog, _ ->
                val name = etName.text?.toString()?.trim().orEmpty()
                val company = etCompany.text?.toString()?.trim().orEmpty()
                dialog.dismiss()
                startCheckinWithInfo(server, area, name, company)
            }
            .setCancelable(true)
            .show()
    }

    private fun startCheckinWithInfo(server: String, area: String, name: String, company: String) {
        tvIdleTitle?.text = "正在为您办理入场"
        tvIdleStatus?.text = "保持本页打开即可"
        showState(AppState.DISCOVERING)

        Thread {
            try {
                val url = "$server/api/checkin"
                val conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod  = "POST"
                    doOutput       = true
                    connectTimeout = 8_000
                    readTimeout    = 8_000
                    setRequestProperty("Content-Type", "application/json")
                }

                val body = JSONObject().apply {
                    if (area.isNotBlank()) put("area", area)
                    if (name.isNotBlank()) put("name", name)
                    if (company.isNotBlank()) put("company", company)
                }

                conn.outputStream.use { os ->
                    java.io.OutputStreamWriter(os).use { it.write(body.toString()) }
                }
                val code = conn.responseCode
                if (code !in 200..299) {
                    throw IllegalStateException("服务器返回错误：$code")
                }
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(text)
                val sid  = json.optString("sessionId")
                if (sid.isNullOrBlank()) {
                    throw IllegalStateException("缺少会话信息")
                }

                sessionId = sid
                runOnUiThread {
                    controlService?.connectToServer(server, sid)
                    showState(AppState.WAITING)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    tvIdleTitle?.text = "请稍候"
                    tvIdleStatus?.text = "暂时无法完成，请稍后重试或联系门卫"
                    showState(AppState.IDLE)
                    Toast.makeText(this, "入场失败：${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private var nsdManager: NsdManager? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    private fun discoverServer() {
        if (discoveryListener != null) return
        tvIdleTitle?.text = "请稍候"
        tvIdleStatus?.text = "保持本页打开即可"
        showState(AppState.DISCOVERING)
        nsdManager = getSystemService(NSD_SERVICE) as NsdManager
        discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) { discoveryListener = null }
            override fun onStartDiscoveryFailed(type: String, code: Int) {
                discoveryListener = null
                runOnUiThread {
                    tvIdleTitle?.text = "请稍候"
                    tvIdleStatus?.text = "暂时无法连接，请稍后重试"
                    showState(AppState.IDLE)
                }
            }
            override fun onStopDiscoveryFailed(type: String, code: Int) { discoveryListener = null }
            override fun onServiceFound(service: NsdServiceInfo) {
                if (service.serviceName == "FactoryControlServer") {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        nsdManager?.registerServiceInfoCallback(
                            service, Executors.newSingleThreadExecutor(),
                            createServiceInfoCallback()
                        )
                    } else {
                        @Suppress("DEPRECATION")
                        nsdManager?.resolveService(service, resolveListener)
                    }
                }
            }
            override fun onServiceLost(service: NsdServiceInfo) {}
        }
        nsdManager?.discoverServices(
            "_factory-control._tcp", NsdManager.PROTOCOL_DNS_SD, discoveryListener
        )
    }

    @Suppress("DEPRECATION")
    private val resolveListener = object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, code: Int) {
            runOnUiThread {
                tvIdleTitle?.text = "请稍候"
                tvIdleStatus?.text = "暂时无法连接，请稍后重试"
                showState(AppState.IDLE)
            }
        }
        override fun onServiceResolved(info: NsdServiceInfo) {
            val port = info.attributes["httpPort"]?.let { String(it).toIntOrNull() } ?: info.port
            val url  = "http://${info.host?.hostAddress}:$port"
            runOnUiThread { onServerFound(url) }
        }
    }

    private fun createServiceInfoCallback(): NsdManager.ServiceInfoCallback {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            object : NsdManager.ServiceInfoCallback {
                override fun onServiceUpdated(info: NsdServiceInfo) {
                    val port = info.attributes["httpPort"]?.let { String(it).toIntOrNull() } ?: info.port
                    val host = info.hostAddresses.firstOrNull()?.hostAddress
                    runOnUiThread { onServerFound("http://$host:$port") }
                    nsdManager?.unregisterServiceInfoCallback(this)
                }
                override fun onServiceInfoCallbackRegistrationFailed(code: Int) {}
                override fun onServiceLost() {}
                override fun onServiceInfoCallbackUnregistered() {}
            }
        } else throw UnsupportedOperationException()
    }

    private fun onServerFound(url: String) {
        serverUrl = url
        stopDiscovery()
        tvIdleTitle?.text = "请稍候"
        tvIdleStatus?.text = "请扫描门卫处展板上的码完成登记"
        showState(AppState.IDLE)
    }

    private fun stopDiscovery() {
        discoveryListener?.let {
            try { nsdManager?.stopServiceDiscovery(it) } catch (_: Exception) {}
        }
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val am = getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val enabled = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_GENERIC)
        if (enabled.any { it.resolveInfo.serviceInfo.packageName == packageName }) return true
        return Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
            ?.contains(packageName) == true
    }

    private fun getLocalIp(): String? {
        try {
            var fallback: String? = null
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (!intf.isUp || intf.isLoopback) continue
                val addrs = intf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr.isLoopbackAddress || addr !is Inet4Address) continue
                    if (intf.name.startsWith("wlan") || intf.name.startsWith("eth")) return addr.hostAddress
                    if (fallback == null) fallback = addr.hostAddress
                }
            }
            return fallback
        } catch (_: Exception) {}
        return null
    }

    private fun openWirelessDebugging() {
        try {
            startActivity(Intent("com.android.settings.APPLICATION_DEVELOPMENT_SETTINGS"))
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))
        }
    }

    private fun retryAdbConnect() {
        val sid = sessionId
        val url = serverUrl
        if (sid.isNullOrBlank() || url.isNullOrBlank()) {
            Toast.makeText(this, "缺少会话信息，无法重试连接", Toast.LENGTH_LONG).show()
            return
        }
        Thread {
            try {
                val conn = (java.net.URL("$url/api/sessions/$sid/retry-connect")
                    .openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput      = true
                    connectTimeout = 8_000
                    readTimeout    = 8_000
                }
                conn.outputStream.use { os ->
                    java.io.OutputStreamWriter(os).use { it.write("""{"source":"app"}""") }
                }
                conn.responseCode
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "重试连接失败：${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private fun exportDebugLogs() {
        val ts = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
        val fileName = "factory_control_debug_$ts.txt"
        val header = buildString {
            appendLine("Factory Control Debug Log")
            appendLine("time=${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())}")
            appendLine("state=$currentState")
            appendLine("sessionId=${sessionId ?: ""}")
            appendLine("serverUrl=${serverUrl ?: ""}")
            appendLine("sdk=${Build.VERSION.SDK_INT}")
            appendLine()
            appendLine("==== AppDebugLog ====")
        }
        val content = header + AppDebugLog.dumpText()

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("无法创建下载文件")
                contentResolver.openOutputStream(uri)?.use { os ->
                    OutputStreamWriter(os).use { it.write(content) }
                } ?: throw IllegalStateException("无法写入下载文件")
                Toast.makeText(this, "日志已导出到下载目录：$fileName", Toast.LENGTH_LONG).show()
            } else {
                val dir = getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS) ?: filesDir
                val file = File(dir, fileName)
                file.writeText(content)
                Toast.makeText(this, "日志已导出：${file.absolutePath}", Toast.LENGTH_LONG).show()
            }
        } catch (e: Exception) {
            Toast.makeText(this, "导出日志失败：${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun resetToIdle() {
        serverUrl = null; sessionId = null
        controlService?.removeSecureFlag()
        showState(AppState.IDLE)
        discoverServer()
    }

    private fun applyImmersiveMode(enable: Boolean) {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        if (enable) {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            WindowCompat.setDecorFitsSystemWindows(window, true)
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && currentState == AppState.RESTRICTED) applyImmersiveMode(true)
    }

    private fun bindViews() {
        layoutIdle       = findViewById(R.id.layoutIdle)
        layoutWaiting    = findViewById(R.id.layoutWaiting)
        layoutRestricted = findViewById(R.id.layoutRestricted)
        layoutExited     = findViewById(R.id.layoutExited)
        tvIdleTitle      = findViewById(R.id.tvIdleTitle)
        tvIdleStatus     = findViewById(R.id.tvIdleStatus)
        tvRestrictedMsg  = findViewById(R.id.tvRestrictedMsg)
        tvExitedMsg      = findViewById(R.id.tvExitedMsg)
        tvExitedIcon     = findViewById(R.id.tvExitedIcon)
        progressBar      = findViewById(R.id.progressBar)
        progressBarExit  = findViewById(R.id.progressBarExit)
        btnScanEntry     = findViewById(R.id.btnScanEntry)
        btnScanExit      = findViewById(R.id.btnScanExit)
        btnScanEntry?.setOnClickListener { startEntryScan() }
        btnScanExit?.setOnClickListener { startExitScan() }
    }

    private fun bindWaitingViews() {
        tvWaitingTitle       = findViewById(R.id.tvWaitingTitle)
        tvWaitingMsg         = findViewById(R.id.tvWaitingMsg)
        panelFirstTime       = findViewById(R.id.panelFirstTime)
        panelAutoSetup       = findViewById(R.id.panelAutoSetup)
        panelManualSteps     = findViewById(R.id.panelManualSteps)
        tvShowManualSteps    = findViewById(R.id.tvShowManualSteps)
        btnGrantAccessibility = findViewById(R.id.btnGrantAccessibility)
        btnFallbackManual    = findViewById(R.id.btnFallbackManual)
        btnOpenWirelessDebug = findViewById(R.id.btnOpenWirelessDebug)
        btnRetryConnect      = findViewById(R.id.btnRetryConnect)
        btnExportLogs        = findViewById(R.id.btnExportLogs)
        btnExportLogsExit    = findViewById(R.id.btnExportLogsExit)
        btnViewHelp          = findViewById(R.id.btnViewHelp)
        panelWorkingSimple   = findViewById(R.id.panelWorkingSimple)
        tvWaitingWorkingHint = findViewById(R.id.tvWaitingWorkingHint)
        panelFailureActions  = findViewById(R.id.panelFailureActions)
        progressStep1 = findViewById(R.id.progressStep1)
        progressStep2 = findViewById(R.id.progressStep2)
        progressStep3 = findViewById(R.id.progressStep3)
        iconStep1     = findViewById(R.id.iconStep1)
        iconStep2     = findViewById(R.id.iconStep2)
        iconStep3     = findViewById(R.id.iconStep3)
        tvStep1Status = findViewById(R.id.tvStep1Status)
        tvStep2Status = findViewById(R.id.tvStep2Status)
        tvStep3Status = findViewById(R.id.tvStep3Status)

        btnGrantAccessibility?.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        btnOpenWirelessDebug?.setOnClickListener { openWirelessDebugging() }
        btnFallbackManual?.setOnClickListener { openWirelessDebugging() }
        btnRetryConnect?.setOnClickListener { retryAdbConnect() }
        btnExportLogs?.setOnClickListener { exportDebugLogs() }
        btnExportLogsExit?.setOnClickListener { exportDebugLogs() }
        btnViewHelp?.setOnClickListener {
            val visible = panelManualSteps?.visibility == View.VISIBLE
            panelManualSteps?.visibility = if (visible) View.GONE else View.VISIBLE
            btnViewHelp?.text = if (visible) "查看说明" else "收起说明"
        }
        tvShowManualSteps?.setOnClickListener {
            val visible = panelManualSteps?.visibility == View.VISIBLE
            panelManualSteps?.visibility = if (visible) View.GONE else View.VISIBLE
            tvShowManualSteps?.text = if (visible) "查看说明 ▾" else "收起 ▴"
        }
        val debugExport = if (BuildConfig.DEBUG) View.VISIBLE else View.GONE
        btnExportLogs?.visibility = debugExport
        btnExportLogsExit?.visibility = debugExport
    }
}
