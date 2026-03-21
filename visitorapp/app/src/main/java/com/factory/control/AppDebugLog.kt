package com.factory.control

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 应用内调试日志缓冲区。
 * 仅保留最近 N 条，供 App 内一键导出，不依赖 adb logcat。
 */
object AppDebugLog {
    private const val MAX_LINES = 4000
    private val lines = ArrayDeque<String>(MAX_LINES)
    private val tsFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.getDefault())

    @Synchronized
    fun d(tag: String, msg: String) = append("D", tag, msg)

    @Synchronized
    fun i(tag: String, msg: String) = append("I", tag, msg)

    @Synchronized
    fun w(tag: String, msg: String) = append("W", tag, msg)

    @Synchronized
    fun e(tag: String, msg: String) = append("E", tag, msg)

    @Synchronized
    fun dumpText(): String {
        val sb = StringBuilder()
        for (line in lines) sb.append(line).append('\n')
        return sb.toString()
    }

    @Synchronized
    private fun append(level: String, tag: String, msg: String) {
        val line = "${tsFormat.format(Date())} $level/$tag: $msg"
        if (lines.size >= MAX_LINES) lines.removeFirst()
        lines.addLast(line)
    }
}

