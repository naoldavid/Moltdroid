package com.moltdroid

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * NativeModule: exposes OpenClaw service control to the React Native JS layer.
 *
 * JS usage:
 *   import { NativeModules } from 'react-native';
 *   const { OpenClawModule } = NativeModules;
 *   OpenClawModule.startService();
 *   OpenClawModule.stopService();
 *   OpenClawModule.isIgnoringBatteryOptimizations(callback);
 *   OpenClawModule.requestBatteryOptimizationWhitelist();
 */
class OpenClawModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "OpenClawModule"

    private val logReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val log = intent?.getStringExtra(OpenClawForegroundService.EXTRA_LOG) ?: return
            emitEvent("onLog", log)
        }
    }

    override fun initialize() {
        super.initialize()
        ContextCompat.registerReceiver(
            reactContext,
            logReceiver,
            IntentFilter(OpenClawForegroundService.BROADCAST_LOG),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    override fun invalidate() {
        super.invalidate()
        try { reactContext.unregisterReceiver(logReceiver) } catch (_: Exception) {}
    }

    // ── Service control ───────────────────────────────────────────────────────

    @ReactMethod
    fun startService() {
        val ctx = reactApplicationContext
        val intent = OpenClawForegroundService.startIntent(ctx)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent)
        } else {
            ctx.startService(intent)
        }
    }

    @ReactMethod
    fun stopService() {
        reactApplicationContext.startService(
            OpenClawForegroundService.stopIntent(reactApplicationContext)
        )
    }

    // ── File system ───────────────────────────────────────────────────────────

    /** Returns the app's private files directory so Node.js knows where to write. */
    @ReactMethod
    fun getFilesDir(promise: Promise) {
        val dir = reactApplicationContext.filesDir.absolutePath
        // Ensure skills/ subdirectory exists
        java.io.File("$dir/skills").mkdirs()
        java.io.File("$dir/data").mkdirs()
        promise.resolve(dir)
    }

    // ── Battery optimization ──────────────────────────────────────────────────

    @ReactMethod
    fun isIgnoringBatteryOptimizations(callback: Callback) {
        val pm = reactApplicationContext.getSystemService(PowerManager::class.java)
        val ignored = pm.isIgnoringBatteryOptimizations(reactApplicationContext.packageName)
        callback.invoke(ignored)
    }

    @ReactMethod
    fun requestBatteryOptimizationWhitelist() {
        val pm = reactApplicationContext.getSystemService(PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(reactApplicationContext.packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${reactApplicationContext.packageName}")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            reactApplicationContext.startActivity(intent)
        }
    }

    // ── Notifications ─────────────────────────────────────────────────────────

    @ReactMethod
    fun showNotification(title: String, body: String) {
        val nm = reactApplicationContext.getSystemService(NotificationManager::class.java)
        val channelId = "moltdroid_agent"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(channelId, "Agent", NotificationManager.IMPORTANCE_DEFAULT)
            nm.createNotificationChannel(ch)
        }
        val notif = NotificationCompat.Builder(reactApplicationContext, channelId)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .build()
        nm.notify(System.currentTimeMillis().toInt(), notif)
    }

    // ── Event emission to JS ──────────────────────────────────────────────────

    private fun emitEvent(eventName: String, data: String) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, data)
    }

    // Required for addListener/removeListeners event emitter pattern
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
