package kr.krl.agent

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Process
import android.os.StatFs
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.zip.ZipInputStream
import kotlin.concurrent.thread

/**
 * KRL Cloud 안드로이드 노드 에이전트.
 * 데스크톱 에이전트와 같은 프로토콜(페어링 → 하트비트 → 릴레이)을 사용하며,
 * 안드로이드에서는 사용자 코드를 실행할 수 없으므로 "빌드가 필요 없는 정적 사이트"만 호스팅한다.
 */
object Agent {
    class Inst(val id: String, var spec: JSONObject) {
        @Volatile var status = "starting"
        @Volatile var error: String? = null
        @Volatile var site: StaticSite? = null
        @Volatile var restarts = 0
        var nonce = spec.optInt("restartNonce")
    }

    private lateinit var app: Context
    private val prefs get() = app.getSharedPreferences("krl", Context.MODE_PRIVATE)
    private val instances = ConcurrentHashMap<String, Inst>()
    private val logs = java.util.Collections.synchronizedList(ArrayList<JSONObject>())
    private val pool = Executors.newFixedThreadPool(6)

    @Volatile private var running = false
    @Volatile var pairCode: String? = null
    @Volatile var message: String = "대기 중"
    @Volatile var connected = false
    @Volatile private var latency = 0
    private var lastCpu = 0L
    private var lastWall = 0L

    fun init(ctx: Context) { app = ctx.applicationContext }

    var server: String
        get() = prefs.getString("server", BuildConfig.KRL_SERVER)!!.trimEnd('/')
        set(v) { prefs.edit().putString("server", v.trim().trimEnd('/')).apply() }
    var token: String?
        get() = prefs.getString("token", null)
        set(v) { prefs.edit().putString("token", v).apply() }
    var chargingOnly: Boolean
        get() = prefs.getBoolean("chargingOnly", false)
        set(v) { prefs.edit().putBoolean("chargingOnly", v).apply() }
    var startOnBoot: Boolean
        get() = prefs.getBoolean("startOnBoot", true)
        set(v) { prefs.edit().putBoolean("startOnBoot", v).apply() }

    val paired get() = token != null
    fun instanceCount() = instances.values.count { it.status == "running" }

    // ---------- HTTP ----------
    private fun http(method: String, path: String, body: String?, timeout: Int = 15000, auth: Boolean = true): Pair<Int, String> {
        val c = URL(server + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 10000
        c.readTimeout = timeout
        c.setRequestProperty("content-type", "application/json")
        if (auth) token?.let { c.setRequestProperty("x-node-token", it) }
        if (body != null) { c.doOutput = true; c.outputStream.use { it.write(body.toByteArray()) } }
        val code = c.responseCode
        val text = (if (code >= 400) c.errorStream else c.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
        c.disconnect()
        return code to text
    }

    // ---------- 진입점 ----------
    /** 서비스가 시작될 때 호출: 페어링이 안 되어 있으면 코드를 받아 대기하고, 되면 호스팅을 시작한다. */
    fun begin() {
        if (running) return
        running = true
        thread(name = "krl-main") {
            try {
                if (token == null) pair()
                if (running && token != null) runLoops()
            } catch (e: Exception) {
                message = "오류: ${e.message}"
                running = false
            }
        }
    }

    fun stop() {
        running = false; connected = false
        for (i in instances.values) i.status = "stopped"
        instances.clear()
        if (token == null) pairCode = null
        message = "중지됨"
    }

    fun unpair() { stop(); token = null; pairCode = null }

    private fun pair() {
        val name = Build.MODEL ?: "android"
        message = "연결 코드를 요청하는 중…"
        val (code, txt) = http("POST", "/api/agent/pair/start", JSONObject().put("name", name).put("platform", "android-" + (Build.SUPPORTED_ABIS.firstOrNull() ?: "")).toString(), auth = false)
        if (code != 200) throw Exception("서버가 거부했습니다 ($code)")
        val j = JSONObject(txt)
        pairCode = j.getString("code")
        message = "대시보드 → My Nodes → 내 PC 연결 에서 코드를 입력하세요"
        val until = System.currentTimeMillis() + 15 * 60_000
        while (running && System.currentTimeMillis() < until) {
            Thread.sleep(3000)
            val (c2, t2) = try { http("GET", "/api/agent/pair/poll?id=" + j.getString("id"), null, auth = false) } catch (e: Exception) { continue }
            if (c2 != 200) continue
            val r = JSONObject(t2)
            when (r.optString("status")) {
                "approved" -> { token = r.getString("token"); pairCode = null; message = "연결 완료"; return }
                "expired" -> throw Exception("코드가 만료되었습니다. 다시 시도하세요")
            }
        }
        if (running) throw Exception("연결 시간이 초과되었습니다")
    }

    private fun runLoops() {
        thread(name = "krl-poll") { pollLoop() }
        heartbeatLoop()
    }

    // ---------- 하트비트 ----------
    private fun heartbeatLoop() {
        while (running) {
            if (chargingOnly && !charging()) {
                connected = false
                message = "충전 중이 아니라 대기 중 (설정: 충전 중에만 실행)"
                for (i in instances.values) i.status = "stopped"
                instances.clear()
                Thread.sleep(5000); continue
            }
            val t0 = System.currentTimeMillis()
            try {
                val (code, txt) = http("POST", "/api/agent/heartbeat", heartbeatBody().toString())
                latency = (System.currentTimeMillis() - t0).toInt()
                if (code == 401) { token = null; message = "이 기기는 계정에서 삭제되었습니다. 다시 연결하세요"; connected = false; running = false; return }
                if (code != 200) throw Exception("HTTP $code")
                val r = JSONObject(txt)
                if (r.optBoolean("disconnect")) { token = null; message = "원격으로 연결이 해제되었습니다"; connected = false; running = false; return }
                connected = true
                message = "호스팅 중 (인스턴스 ${instanceCount()}개)"
                reconcile(r.optJSONArray("desired") ?: JSONArray())
            } catch (e: Exception) {
                connected = false
                message = "서버 연결 오류: ${e.message}"
            }
            Thread.sleep(3000)
        }
    }

    private fun heartbeatBody(): JSONObject {
        val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val cores = Runtime.getRuntime().availableProcessors()
        val sf = StatFs(app.filesDir.path)
        val caps = JSONObject().put("cores", cores).put("ramMB", mi.totalMem / 1048576).put("diskGB", maxOf(1L, sf.availableBytes / 1_000_000_000L))
            .put("platform", "android-" + (Build.SUPPORTED_ABIS.firstOrNull() ?: "")).put("docker", false).put("sandbox", "none")
            .put("hostname", Build.MODEL ?: "android").put("version", "android-" + BuildConfig.VERSION_NAME)
        // 이 앱 프로세스의 실제 CPU 사용률 (안드로이드는 시스템 전체 CPU 통계를 앱에 공개하지 않는다)
        val cpuNow = Process.getElapsedCpuTime(); val wall = SystemClock.elapsedRealtime()
        val load = if (lastWall > 0 && wall > lastWall) ((cpuNow - lastCpu).toDouble() / (wall - lastWall) / cores * 100).coerceIn(0.0, 100.0) else 0.0
        lastCpu = cpuNow; lastWall = wall
        val metrics = JSONObject().put("cpuLoad", load).put("ramPct", ((1 - mi.availMem.toDouble() / mi.totalMem) * 100).toInt())
            .put("ramUsedMB", (mi.totalMem - mi.availMem) / 1048576).put("latencyMs", latency)
        temperature()?.let { metrics.put("temp", it) }
        val inst = JSONArray()
        for (i in instances.values) inst.put(JSONObject().put("id", i.id).put("status", i.status).put("restarts", i.restarts).put("error", i.error ?: JSONObject.NULL))
        val lg = JSONArray()
        synchronized(logs) {
            val n = minOf(200, logs.size)
            for (k in 0 until n) lg.put(logs[k])
            repeat(n) { logs.removeAt(0) }
        }
        return JSONObject().put("caps", caps).put("metrics", metrics).put("instances", inst).put("logs", lg)
    }

    private fun batteryIntent(): Intent? = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    fun charging(): Boolean = (batteryIntent()?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
    private fun temperature(): Int? { val t = batteryIntent()?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1; return if (t > 0) t / 10 else null }

    // ---------- 인스턴스 ----------
    private fun ilog(i: Inst, line: String) { logs.add(JSONObject().put("instanceId", i.id).put("stream", "stdout").put("line", line)) }

    private fun reconcile(desired: JSONArray) {
        val ids = HashSet<String>()
        for (k in 0 until desired.length()) {
            val spec = desired.getJSONObject(k)
            val id = spec.getString("id"); ids.add(id)
            val cur = instances[id]
            if (cur == null) { val i = Inst(id, spec); instances[id] = i; pool.execute { launch(i) } }
            else {
                cur.spec = spec
                if (spec.optInt("restartNonce") != cur.nonce) { cur.nonce = spec.optInt("restartNonce"); cur.restarts++; ilog(cur, "==> 재시작 요청"); pool.execute { launch(cur) } }
            }
        }
        for (id in instances.keys.toList()) if (id !in ids) instances.remove(id)?.status = "stopped"
    }

    private fun launch(i: Inst) {
        val spec = i.spec
        i.status = "starting"; i.error = null
        try {
            if (spec.optString("kind") != "static" || spec.optString("buildCommand").isNotEmpty())
                throw Exception("이 기기는 빌드가 필요 없는 정적 사이트만 호스팅합니다")
            val dir = File(app.filesDir, "work/${i.id}")
            dir.deleteRecursively(); dir.mkdirs()
            val src = spec.getJSONObject("source")
            when (src.optString("kind")) {
                "template" -> {
                    ilog(i, "==> 템플릿 파일 준비")
                    val files = spec.optJSONObject("files") ?: JSONObject()
                    for (name in files.keys()) {
                        val f = File(dir, name).canonicalFile
                        if (!f.path.startsWith(dir.canonicalPath + File.separator)) continue
                        f.parentFile?.mkdirs(); f.writeText(files.getString(name))
                    }
                }
                "github" -> { ilog(i, "==> ${src.optString("repo")} (${src.optString("branch")}) 다운로드"); downloadGithub(src.getString("repo"), src.optString("branch", "main"), dir) }
                else -> throw Exception("지원하지 않는 소스입니다 (${src.optString("kind")})")
            }
            val root = File(File(dir, spec.optString("rootDir")), spec.optString("publishDir", ".")).canonicalFile
            if (!root.path.startsWith(dir.canonicalPath)) throw Exception("잘못된 배포 경로")
            if (!root.isDirectory) throw Exception("배포 디렉터리를 찾을 수 없습니다: ${spec.optString("publishDir")}")
            i.site = StaticSite(root)
            i.status = "running"
            ilog(i, "==> 정적 사이트 제공 시작")
        } catch (e: Exception) {
            i.status = "failed"; i.error = e.message
            ilog(i, "오류: ${e.message}")
        }
    }

    private fun downloadGithub(repo: String, branch: String, dir: File) {
        val m = Regex("^https://github\\.com/([\\w.-]+)/([\\w.-]+?)(\\.git)?/?$").find(repo) ?: throw Exception("GitHub 저장소만 지원합니다")
        val url = URL("https://codeload.github.com/${m.groupValues[1]}/${m.groupValues[2]}/zip/refs/heads/$branch")
        val c = url.openConnection() as HttpURLConnection
        c.connectTimeout = 15000; c.readTimeout = 60000
        if (c.responseCode != 200) throw Exception("저장소를 내려받을 수 없습니다 (HTTP ${c.responseCode}) - 공개 저장소/브랜치를 확인하세요")
        var total = 0L
        ZipInputStream(c.inputStream).use { z ->
            while (true) {
                val e = z.nextEntry ?: break
                val rel = e.name.substringAfter('/', "")
                if (rel.isEmpty()) continue
                val out = File(dir, rel).canonicalFile
                if (!out.path.startsWith(dir.canonicalPath + File.separator)) continue // zip-slip 방지
                if (e.isDirectory) { out.mkdirs(); continue }
                out.parentFile?.mkdirs()
                out.outputStream().use { o -> total += z.copyTo(o) }
                if (total > 200L * 1024 * 1024) throw Exception("저장소가 너무 큽니다")
            }
        }
        c.disconnect()
    }

    // ---------- 릴레이 ----------
    private fun pollLoop() {
        while (running) {
            try {
                val (code, txt) = http("GET", "/api/agent/poll", null, timeout = 30000)
                if (code != 200) { Thread.sleep(2000); continue }
                val r = JSONObject(txt)
                if (r.optBoolean("disconnect")) return
                val reqs = r.optJSONArray("requests") ?: continue
                for (k in 0 until reqs.length()) { val rq = reqs.getJSONObject(k); pool.execute { relay(rq) } }
            } catch (e: Exception) { if (running) Thread.sleep(2000) }
        }
    }

    private fun relay(rq: JSONObject) {
        val inst = instances[rq.optString("instanceId")]
        val site = inst?.site
        val resp = if (inst != null && site != null && inst.status == "running") site.serve(rq.optString("method", "GET"), rq.optString("path", "/"))
        else StaticSite.Resp(502, mapOf("content-type" to "text/plain"), "instance unavailable".toByteArray())
        val headers = JSONObject(); resp.headers.forEach { (k, v) -> headers.put(k, v) }
        val body = JSONObject().put("status", resp.status).put("headers", headers).put("body", Base64.encodeToString(resp.body, Base64.NO_WRAP))
        try { http("POST", "/api/agent/respond/" + rq.getString("id"), body.toString(), timeout = 30000) } catch (_: Exception) {}
    }
}
