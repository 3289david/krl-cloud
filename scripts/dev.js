'use strict';
// 개발용: 컨트롤 플레인 서버만 실행합니다. 가짜 노드/데모 데이터는 없습니다.
//   1) 회원가입  2) 이 PC에서 `node agent/agent.js install --server http://localhost:8080 --allow-unsandboxed`  3) 코드 입력
const { spawn } = require('child_process');
const path = require('path');
const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { stdio: 'inherit', env: { ...process.env, TICK_SECONDS: process.env.TICK_SECONDS || '10' } });
process.on('SIGINT', () => p.kill());
process.on('SIGTERM', () => p.kill());
p.on('exit', (c) => process.exit(c || 0));
