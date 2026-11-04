package kr.krl.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 부팅 시 이미 연결된 기기라면 자동으로 호스팅을 재개한다. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Agent.init(ctx)
        if (Agent.paired && Agent.startOnBoot) try { AgentService.start(ctx) } catch (_: Exception) {}
    }
}
