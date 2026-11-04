package kr.krl.agent

import android.Manifest
import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class MainActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var codeView: TextView
    private lateinit var statusView: TextView
    private lateinit var server: EditText
    private lateinit var action: Button
    private var serviceOn = false

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun label(t: String, size: Float, color: Int = Color.WHITE, bold: Boolean = false) = TextView(this).apply {
        text = t; textSize = size; setTextColor(color); if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        Agent.init(this)
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        val muted = Color.parseColor("#8A96BD")

        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(36), dp(20), dp(24)) }
        col.addView(label("☁ KRL Cloud", 26f, bold = true))
        col.addView(label("이 기기를 분산형 호스팅 네트워크에 연결합니다.\n빌드가 필요 없는 정적 사이트를 호스팅하고 크레딧을 얻습니다.", 14f, muted).apply { setPadding(0, dp(6), 0, dp(20)) })

        col.addView(label("서버 주소", 12f, muted))
        server = EditText(this).apply { setText(Agent.server); setTextColor(Color.WHITE); inputType = InputType.TYPE_TEXT_VARIATION_URI; setSingleLine() }
        col.addView(server)

        action = Button(this).apply { setOnClickListener { toggle() } }
        col.addView(action, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })

        codeView = label("", 34f, Color.parseColor("#5B8CFF"), true).apply { gravity = Gravity.CENTER; setPadding(0, dp(18), 0, dp(6)); letterSpacing = 0.12f }
        col.addView(codeView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        statusView = label("", 14f).apply { gravity = Gravity.CENTER }
        col.addView(statusView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        col.addView(CheckBox(this).apply { text = "충전 중일 때만 호스팅"; setTextColor(Color.WHITE); isChecked = Agent.chargingOnly; setOnCheckedChangeListener { _, c -> Agent.chargingOnly = c } })
        col.addView(CheckBox(this).apply { text = "부팅 시 자동 시작"; setTextColor(Color.WHITE); isChecked = Agent.startOnBoot; setOnCheckedChangeListener { _, c -> Agent.startOnBoot = c } })
        col.addView(Button(this).apply { text = "연결 해제 (이 기기 초기화)"; setOnClickListener { AgentService.stop(this@MainActivity); Agent.unpair(); serviceOn = false } })
        col.addView(label("안드로이드는 보안상 사용자 코드를 실행할 수 없어 정적 사이트만 호스팅합니다. Node/Python/Docker 앱은 PC 노드가 담당합니다.", 12f, muted).apply { setPadding(0, dp(18), 0, 0) })

        setContentView(ScrollView(this).apply { setBackgroundColor(Color.parseColor("#0A0E1A")); addView(col) })
    }

    private fun toggle() {
        if (serviceOn) { AgentService.stop(this); Agent.stop(); serviceOn = false; return }
        Agent.server = server.text.toString()
        AgentService.start(this)
        serviceOn = true
    }

    private val tick = object : Runnable {
        override fun run() {
            val code = Agent.pairCode
            codeView.text = if (code != null) code.take(4) + "-" + code.drop(4) else ""
            statusView.text = Agent.message
            action.text = if (serviceOn) "호스팅 중지" else if (Agent.paired) "호스팅 시작" else "이 기기 연결하기"
            ui.postDelayed(this, 1000)
        }
    }

    override fun onResume() { super.onResume(); tick.run() }
    override fun onPause() { ui.removeCallbacks(tick); super.onPause() }
}
