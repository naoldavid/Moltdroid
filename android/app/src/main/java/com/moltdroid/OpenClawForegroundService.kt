package com.moltdroid

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

class OpenClawForegroundService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START

        return when (action) {
            ACTION_START -> {
                startForeground(NOTIFICATION_ID, buildNotification())
                // Node.js runtime is started from the JS layer via nodejs-mobile-react-native.
                // The Service's job is to hold the persistent notification and wake lock
                // so the process stays alive when the app is in the background.
                Log.i(TAG, "OpenClaw service started")
                START_STICKY
            }
            ACTION_STOP -> {
                Log.i(TAG, "OpenClaw service stopping")
                stopSelf()
                START_NOT_STICKY
            }
            else -> START_STICKY
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        releaseWakeLock()
        // Node.js runtime stops when the process dies — no explicit stop needed
        Log.i(TAG, "OpenClaw service destroyed")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Notification ─────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "OpenClaw Gateway",
                NotificationManager.IMPORTANCE_LOW // silent, no sound
            ).apply {
                description = "Keeps the OpenClaw Gateway running in the background"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val openAppIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, OpenClawForegroundService::class.java).apply {
                action = ACTION_STOP
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("OpenClaw running 🦞")
            .setContentText("Gateway active on 127.0.0.1:18789")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)             // cannot be swiped away
            .setContentIntent(openAppIntent)
            .addAction(android.R.drawable.ic_delete, "Stop", stopIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    // ── WakeLock ─────────────────────────────────────────────────────────────

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "MoltDroid:OpenClawWakeLock"
        ).also { it.acquire() }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
    }

    companion object {
        private const val TAG = "OpenClawService"
        const val CHANNEL_ID = "openclaw_channel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.moltdroid.START_OPENCLAW"
        const val ACTION_STOP  = "com.moltdroid.STOP_OPENCLAW"
        const val BROADCAST_LOG = "com.moltdroid.LOG"
        const val EXTRA_LOG = "log"

        fun startIntent(context: Context): Intent =
            Intent(context, OpenClawForegroundService::class.java).apply {
                action = ACTION_START
            }

        fun stopIntent(context: Context): Intent =
            Intent(context, OpenClawForegroundService::class.java).apply {
                action = ACTION_STOP
            }
    }
}
