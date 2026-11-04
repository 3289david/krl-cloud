package kr.krl.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/** 포그라운드 서비스: 앱을 닫아도 호스팅을 계속한다. 페어링도 이 서비스 안에서 진행된다(대시보드로 이동해도 끊기지 않도록). */
class AgentService : Service() {
    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Agent.init(this)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel("agent", "KRL 호스팅", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = Notification.Builder(this, "agent").setContentTitle("KRL Cloud").setContentText("이 기기가 호스팅 네트워크에 연결되어 있습니다")
            .setSmallIcon(R.drawable.ic_launcher).setContentIntent(open).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(1, n)
        if (wake == null) wake = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "krl:agent").apply { acquire() }
        Agent.begin()
        return START_STICKY
    }

    override fun onDestroy() {
        Agent.stop()
        wake?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    companion object {
        fun start(ctx: Context) { ctx.startForegroundService(Intent(ctx, AgentService::class.java)) }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, AgentService::class.java)) }
    }
}
