package com.factory.control

import android.app.Activity
import android.app.Application
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import java.lang.ref.WeakReference

// ─── App.kt ──────────────────────────────────────────────────

/**
 * Application 类
 * 跟踪当前活跃 Activity，供 ControlService 设置 FLAG_SECURE
 */
class App : Application() {
    companion object {
        private var currentActivityRef: WeakReference<Activity>? = null
        var currentActivity: Activity?
            get() = currentActivityRef?.get()
            set(value) { currentActivityRef = if (value != null) WeakReference(value) else null }
    }

    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityResumed(a: Activity)  { currentActivity = a }
            override fun onActivityCreated(a: Activity, b: Bundle?) { currentActivity = a }
            override fun onActivityStarted(a: Activity)  { currentActivity = a }
            override fun onActivityPaused(a: Activity)   {}
            override fun onActivityStopped(a: Activity)  {}
            override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
            override fun onActivityDestroyed(a: Activity) {
                if (currentActivity == a) currentActivity = null
            }
        })
    }
}

// ─── AdminReceiver.kt ─────────────────────────────────────────

/**
 * Device Admin Receiver
 *
 * 职责：响应 Device Admin 生命周期事件（激活 / 停用）。
 * setScreenCaptureDisabled 调用已迁移至 ControlService.dispatchStatus()，
 * 在收到 WebSocket 状态变更时直接执行，不再依赖广播路由。
 *
 * [FIX-4] 删除 onReceive 中处理 UPDATE_STATUS 的死代码：
 *   Manifest 的 AdminReceiver 只注册了 DEVICE_ADMIN_ENABLED action，
 *   UPDATE_STATUS 广播永远不会路由到此接收器，applyAdminRestrictions /
 *   removeAdminRestrictions 从未被调用，属于误导性死代码。
 */
class AdminReceiver : DeviceAdminReceiver() {

    companion object {
        fun getComponentName(ctx: Context) = ComponentName(ctx, AdminReceiver::class.java)

        fun isActive(ctx: Context): Boolean {
            val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            return dpm.isAdminActive(getComponentName(ctx))
        }

        fun requestActivation(activity: Activity, requestCode: Int) {
            val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, getComponentName(activity))
                putExtra(
                    DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                    "厂区管控需要此权限来限制截屏功能，离厂后将自动解除。"
                )
            }
            activity.startActivityForResult(intent, requestCode)
        }
    }

    override fun onEnabled(context: Context, intent: Intent) {
        Toast.makeText(context, "设备管理员权限已激活", Toast.LENGTH_SHORT).show()
    }

    override fun onDisableRequested(context: Context, intent: Intent): CharSequence =
        "⚠️ 当前处于厂区管控状态，禁止停用设备管理员权限！"

    override fun onDisabled(context: Context, intent: Intent) {
        Toast.makeText(context, "设备管理员权限已移除", Toast.LENGTH_LONG).show()
    }
}

// ─── BootReceiver.kt ─────────────────────────────────────────

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            context.startForegroundService(Intent(context, ControlService::class.java))
        }
    }
}