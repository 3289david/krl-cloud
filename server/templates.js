'use strict';

// GitHub 없이 바로 배포해 볼 수 있는 시작 템플릿
const nodeServer = `const http = require('http');
const port = process.env.PORT || 3000;
let hits = 0;
http.createServer((req, res) => {
  if (req.url === '/healthz') { res.end('ok'); return; }
  hits++;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(\`<!doctype html><meta charset=utf-8><title>KRL Node.js</title>
  <body style="font-family:system-ui;background:#0b1020;color:#e8ecff;display:grid;place-items:center;height:100vh;margin:0">
  <div style="text-align:center"><h1>🚀 Hello from KRL Cloud</h1>
  <p>이 응답은 <b>\${process.env.KRL_NODE_NAME}</b> 노드의 인스턴스 <code>\${process.env.KRL_INSTANCE_ID}</code> 에서 왔습니다.</p>
  <p>이 인스턴스 요청 수: \${hits} · 새로고침해서 로드밸런싱을 확인하세요</p>
  <p style="opacity:.6">env GREETING = \${process.env.GREETING || '(미설정)'}</p></div></body>\`);
}).listen(port, () => console.log('listening on', port));
`;

const pyServer = `import os, http.server

HITS = 0
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        global HITS
        if self.path == '/healthz':
            self.send_response(200); self.end_headers(); self.wfile.write(b'ok'); return
        HITS += 1
        body = ('<!doctype html><meta charset=utf-8><title>KRL Python</title>'
                '<body style="font-family:system-ui;background:#0b1020;color:#e8ecff;display:grid;place-items:center;height:100vh;margin:0">'
                '<div style="text-align:center"><h1>🐍 Hello from KRL Cloud</h1>'
                '<p>노드 <b>%s</b> / 인스턴스 <code>%s</code> / 요청 %d</p></div></body>' % (
                    os.environ.get('KRL_NODE_NAME'), os.environ.get('KRL_INSTANCE_ID'), HITS)).encode()
        self.send_response(200)
        self.send_header('content-type', 'text/html; charset=utf-8')
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): print(*a)

http.server.ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', 3000))), H).serve_forever()
`;

const staticIndex = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KRL Static Site</title>
<body style="font-family:system-ui;background:#0b1020;color:#e8ecff;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>🌐 정적 사이트가 KRL Cloud에서 실행 중입니다</h1>
<p>여러 사용자의 PC에서 동시에 서비스되고 있어요.</p></div></body></html>
`;

const TEMPLATES = {
  'node-hello': {
    label: 'Node.js Hello', runtime: 'node', type: 'web',
    buildCommand: '', startCommand: 'node server.js',
    files: { 'server.js': nodeServer, 'package.json': '{"name":"hello","version":"1.0.0","scripts":{"start":"node server.js"}}' },
  },
  'python-hello': {
    label: 'Python Hello', runtime: 'python', type: 'web',
    buildCommand: '', startCommand: 'python app.py',
    files: { 'app.py': pyServer },
  },
  'static-hello': {
    label: 'Static Site', runtime: 'static', type: 'static',
    buildCommand: '', startCommand: '', publishDir: '.',
    files: { 'index.html': staticIndex },
  },
};

const RUNTIME_DEFAULTS = {
  node:   { buildCommand: 'npm install', startCommand: 'npm start', image: 'node:20-alpine' },
  python: { buildCommand: 'pip install -r requirements.txt', startCommand: 'python app.py', image: 'python:3.12-slim' },
  static: { buildCommand: '', startCommand: '', image: '' },
  docker: { buildCommand: '', startCommand: '', image: '' },
  custom: { buildCommand: '', startCommand: '', image: 'ubuntu:24.04' },
};

module.exports = { TEMPLATES, RUNTIME_DEFAULTS };
