package kr.krl.agent

import java.io.File
import java.net.URLDecoder

/** 디렉터리를 정적 사이트로 제공 (게이트웨이가 릴레이한 요청을 직접 처리하므로 소켓이 필요 없다). */
class StaticSite(private val root: File) {
    class Resp(val status: Int, val headers: Map<String, String>, val body: ByteArray)

    private val rootPath = root.canonicalPath

    fun serve(method: String, rawPath: String): Resp {
        if (method != "GET" && method != "HEAD") return text(405, "Method Not Allowed")
        val path = try { URLDecoder.decode(rawPath.substringBefore('?').substringBefore('#'), "UTF-8") } catch (e: Exception) { return text(400, "Bad Request") }
        var f = File(root, path).canonicalFile
        if (f.path != rootPath && !f.path.startsWith(rootPath + File.separator)) return text(403, "Forbidden")
        if (f.isDirectory) f = File(f, "index.html")
        if (f.isFile) return file(200, f)
        // 확장자가 없는 경로는 SPA 폴백
        if (!path.substringAfterLast('/').contains('.')) {
            val idx = File(root, "index.html")
            if (idx.isFile) return file(200, idx)
        }
        val nf = File(root, "404.html")
        return if (nf.isFile) file(404, nf) else text(404, "Not found")
    }

    private fun file(status: Int, f: File) = Resp(status, mapOf("content-type" to mime(f.name), "cache-control" to "public, max-age=60"), f.readBytes())
    private fun text(status: Int, msg: String) = Resp(status, mapOf("content-type" to "text/plain; charset=utf-8"), msg.toByteArray())

    private fun mime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "html", "htm" -> "text/html; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "js", "mjs" -> "text/javascript; charset=utf-8"
        "json", "map" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "ico" -> "image/x-icon"
        "txt" -> "text/plain; charset=utf-8"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        "xml" -> "application/xml"
        "pdf" -> "application/pdf"
        "wasm" -> "application/wasm"
        else -> "application/octet-stream"
    }
}
