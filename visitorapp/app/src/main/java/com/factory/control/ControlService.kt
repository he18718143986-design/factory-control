package com.factory.control

import android.app.*
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import okhttp3.*
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * ControlService — 前台保活服务
 *
 * 修复：
 *  - [BUG-5] notifyExit() 增加重试与兜底解除，不再完全依赖 WebSocket
 *  - [BUG-6] adbReceiver 改为 RECEIVER_NOT_EXPORTED，防止外部 App 伪造广播
 *  - [FIX-7] Android 14+ startForeground 需指定 foregroundServiceType，否则闪退
 *  - [FIX-8] 修复 mainHandler 初始化时 mainLooper 为空导致的 NPE
 */
class ControlService : Service() {

    inner class LocalBinder : Binder() { val service get() = this@ControlService }
    private val binder = LocalBinder()
    override fun onBind(intent: Intent): IBinder = binder

    var onStatusChanged: ((status: String, message: String) -> Unit)? = null
    var currentStatus: String = "idle"
        private set

    private val client = OkHttpClient()
    private var webSocket: WebSocket? = null
    @Volatile
    private var wsConnected = false
    @Volatile
    private var activeSessionId: String? = null
    @Volatile
    private var connectGeneration: Long = 0L
    private var reconnectTask: Runnable? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    /** 管控中时周期性重设截屏禁用，应对部分 ROM 在 App 退到后台后不再强制该策略 */
    private val screenCaptureReapplyIntervalMs = 20_000L
    private var screenCaptureReapplyRunnable: Runnable? = null

    /** 是否已连接 WebSocket，用于 MainActivity 避免 onResume 时重复重连导致双连接 */
    fun isConnected(): Boolean = wsConnected

    // [BUG-6 修复] 内部广播改为 NOT_EXPORTED，外部 App 无法伪造
    private val adbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != "com.factory.control.UPDATE_STATUS") return
            val status = intent.getStringExtra("status") ?: return
            val msg    = intent.getStringExtra("message") ?: ""
            dispatchStatus(status, msg)
        }
    }

    companion object {
        const val NOTIF_ID     = 1001
        const val CHANNEL_ID   = "factory_control"
        const val CHANNEL_NAME = "厂区管控"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        
        // [FIX-7] 针对 Android 14 (API 34) 的适配
        val notification = buildNotification("厂区管控运行中", "等待连接…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIF_ID, 
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIF_ID, notification)
        }

        val filter = IntentFilter("com.factory.control.UPDATE_STATUS")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(adbReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(adbReceiver, filter)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    // ─── WebSocket 连接 ─────────────────────────────────────────────

    fun connectToServer(baseUrl: String, sessionId: String) {
        val generation = synchronized(this) {
            connectGeneration += 1
            connectGeneration
        }
        activeSessionId = sessionId
        reconnectTask?.let { mainHandler.removeCallbacks(it) }
        reconnectTask = null

        val wsUrl = buildWsUrl(baseUrl, sessionId)
        AppDebugLog.i("ControlService", "connectToServer wsUrl=$wsUrl gen=$generation")
        val req = Request.Builder().url(wsUrl).build()
        webSocket?.cancel()
        wsConnected = false
        webSocket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!isCurrentConnection(generation, sessionId)) {
                    AppDebugLog.w("ControlService", "ignore stale onOpen gen=$generation session=$sessionId")
                    webSocket.close(1000, "stale session")
                    return
                }
                wsConnected = true
                AppDebugLog.i("ControlService", "websocket opened gen=$generation session=$sessionId")
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!isCurrentConnection(generation, sessionId)) return
                handleMessage(text)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!isCurrentConnection(generation, sessionId)) {
                    AppDebugLog.w("ControlService", "ignore stale onFailure gen=$generation session=$sessionId err=${t.message}")
                    return
                }
                wsConnected = false
                AppDebugLog.w("ControlService", "websocket failure=${t.message} gen=$generation session=$sessionId")
                val task = Runnable {
                    if (!isCurrentConnection(generation, sessionId)) {
                        AppDebugLog.w("ControlService", "drop stale reconnect gen=$generation session=$sessionId")
                        return@Runnable
                    }
                    connectToServer(baseUrl, sessionId)
                }
                reconnectTask = task
                mainHandler.postDelayed(task, 5000)
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (!isCurrentConnection(generation, sessionId)) return
                wsConnected = false
                AppDebugLog.i("ControlService", "websocket closing code=$code reason=$reason")
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!isCurrentConnection(generation, sessionId)) return
                wsConnected = false
                AppDebugLog.i("ControlService", "websocket closed code=$code reason=$reason")
            }
        })
    }

    private fun isCurrentConnection(generation: Long, sessionId: String): Boolean {
        return generation == connectGeneration && sessionId == activeSessionId
    }

    private fun buildWsUrl(baseUrl: String, sessionId: String): String {
        val base = if (baseUrl.endsWith("/")) baseUrl.dropLast(1) else baseUrl
        return "${base.replace("http", "ws")}/ws?sessionId=$sessionId"
    }

    private fun handleMessage(text: String) {
        try {
            val json    = JSONObject(text)
            val event   = json.optString("event")
            val status  = json.optString("status")
            val message = json.optString("message")
            AppDebugLog.d("ControlService", "ws event=$event status=$status message=$message")
            when {
                event == "init" -> {
                    val sessionStatus = json.optJSONObject("session")?.optString("status") ?: return
                    dispatchStatus(sessionStatus, "")
                }
                event == "status" -> dispatchStatus(status, message)
                // 后端 broadcastAll 会发 sessionUpdate，未在 session 房间时也能收到，避免管控已下发但 UI 不刷新
                event == "sessionUpdate" -> {
                    val sessionStatus = json.optJSONObject("session")?.optString("status") ?: return
                    // ADB 已连接（sessionStatus=paining）或管控已生效（restricted）后，
                    // 无障碍自动化可能仍卡在 S4 等待弹窗；以后端成功信号作为兜底停止自动化。
                    if (sessionStatus == "pairing" || sessionStatus == "restricted") {
                        mainHandler.post {
                            SetupAutomationService.instance?.stopAutomation(
                                "后端检测到 ${sessionStatus}，停止无线调试自动化"
                            )
                        }
                    }
                    if (sessionStatus == "restricted" || sessionStatus == "exited") {
                        dispatchStatus(sessionStatus, message)
                    }
                }
                event == "command" -> handleCommand(json)
            }
        } catch (_: Exception) {}
    }

    private fun handleCommand(json: JSONObject) {
        val command = json.optString("command")
        if (command != "recover_pairing") return
        mainHandler.post {
            val started = SetupAutomationService.instance?.startRecoverPairingFlow() == true
            if (started) {
                onStatusChanged?.invoke("pairing", "正在重置无线调试并重新配对…")
            }
        }
    }

    private fun dispatchStatus(status: String, message: String) {
        AppDebugLog.i("ControlService", "dispatchStatus status=$status message=$message from=$currentStatus")
        currentStatus = status
        mainHandler.post {
            val dpm   = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val admin = AdminReceiver.getComponentName(this)
            when (status) {
                "restricted" -> {
                    applySecureFlag()
                    if (dpm.isAdminActive(admin)) {
                        try { dpm.setScreenCaptureDisabled(admin, true) } catch (_: Exception) {}
                        startScreenCaptureReapply()
                    }
                    updateNotification("🔒 管控中", "拍照、录屏、截屏功能已限制")
                }
                "exited" -> {
                    stopScreenCaptureReapply()
                    removeSecureFlag()
                    if (dpm.isAdminActive(admin)) {
                        try { dpm.setScreenCaptureDisabled(admin, false) } catch (_: Exception) {}
                    }
                    updateNotification("✅ 管控已解除", "感谢配合")
                }
            }
            onStatusChanged?.invoke(status, message)
        }
    }

    private fun startScreenCaptureReapply() {
        stopScreenCaptureReapply()
        val runnable = object : Runnable {
            override fun run() {
                if (currentStatus != "restricted") return
                val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
                val admin = AdminReceiver.getComponentName(this@ControlService)
                if (dpm.isAdminActive(admin)) {
                    try { dpm.setScreenCaptureDisabled(admin, true) } catch (_: Exception) {}
                }
                mainHandler.postDelayed(this, screenCaptureReapplyIntervalMs)
            }
        }
        screenCaptureReapplyRunnable = runnable
        mainHandler.postDelayed(runnable, screenCaptureReapplyIntervalMs)
    }

    private fun stopScreenCaptureReapply() {
        screenCaptureReapplyRunnable?.let { mainHandler.removeCallbacks(it) }
        screenCaptureReapplyRunnable = null
    }

    // ─── FLAG_SECURE ────────────────────────────────────────────────

    private fun applySecureFlag() {
        try {
            App.currentActivity?.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } catch (_: Exception) {}
    }

    fun removeSecureFlag() {
        try {
            App.currentActivity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } catch (_: Exception) {}
    }

    // ─── 离厂：本地兜底 + 重试 ──────────────────────────────────────

    fun notifyExitWithFallback(baseUrl: String, sid: String, token: String) {
        attemptExit(baseUrl, sid, token, retryLeft = 3)
    }

    private fun attemptExit(baseUrl: String, sid: String, token: String, retryLeft: Int) {
        Thread {
            val success = try {
                val conn = URL("$baseUrl/api/sessions/$sid/exit")
                    .openConnection() as HttpURLConnection
                conn.requestMethod  = "POST"
                conn.doOutput       = true
                conn.connectTimeout = 8_000
                conn.readTimeout    = 8_000
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use {
                    OutputStreamWriter(it).apply {
                        write("""{"exitToken":"$token"}"""); flush()
                    }
                }
                val code = conn.responseCode
                code in 200..299
            } catch (_: Exception) { false }

            mainHandler.post {
                if (success) {
                    dispatchStatus("exited", "")
                } else if (retryLeft > 0) {
                    mainHandler.postDelayed({
                        attemptExit(baseUrl, sid, token, retryLeft - 1)
                    }, 3_000)
                } else {
                    dispatchStatus("exited", "网络异常，已本地解除管控")
                }
            }
        }.start()
    }

    // ─── 通知 ────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "厂区访客管控状态通知" }
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
    }

    private fun buildNotification(title: String, content: String): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(title: String, content: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIF_ID, buildNotification(title, content))
    }

    override fun onDestroy() {
        stopScreenCaptureReapply()
        try { unregisterReceiver(adbReceiver) } catch (_: Exception) {}
        reconnectTask?.let { mainHandler.removeCallbacks(it) }
        reconnectTask = null
        webSocket?.close(1000, "service destroyed")
        super.onDestroy()
    }
}
