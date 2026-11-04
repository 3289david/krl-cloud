'use strict';
/**
 * 에이전트 빌드:  node scripts/build.js
 *  - dist/krl-agent.js            : 모든 OS 에서 `node krl-agent.js` 로 실행 가능한 단일 파일
 *  - dist/krl-agent-<os>-<arch>   : Node SEA 단일 실행 파일 (이 스크립트를 실행한 OS 용)
 *  - dist/install.sh, install.ps1 : 설치 스크립트 (서버 주소는 서버가 내려줄 때 주입됨)
 *  - dist/SHA256SUMS
 * 다른 OS 용 실행 파일은 .github/workflows/build-agent.yml 이 각 OS 러너에서 같은 스크립트로 빌드한다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const plat = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] || process.platform;
const arch = process.arch;
const exe = process.platform === 'win32' ? '.exe' : '';

// KRL_SERVER 가 있으면 기본 서버 주소로 박아 넣는다 (예: KRL_SERVER=https://krl.kr npm run build -> 인자 없이 설치 가능)
let agentSrc = fs.readFileSync(path.join(root, 'agent', 'agent.js'), 'utf8');
if (process.env.KRL_SERVER) agentSrc = agentSrc.replace("'__DEFAULT_SERVER__'", JSON.stringify(process.env.KRL_SERVER.replace(/\/$/, '')));
fs.writeFileSync(path.join(dist, 'krl-agent.js'), agentSrc);
for (const f of ['install.sh', 'install.ps1']) fs.copyFileSync(path.join(root, 'packaging', f), path.join(dist, f));
console.log('✓ dist/krl-agent.js');

// ----- Node SEA -----
try {
  const cfgPath = path.join(dist, 'sea-config.json');
  const blob = path.join(dist, 'sea-prep.blob');
  fs.writeFileSync(cfgPath, JSON.stringify({ main: path.join(dist, 'krl-agent.js'), output: blob, disableExperimentalSEAWarning: true }));
  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });

  const out = path.join(dist, `krl-agent-${plat}-${arch}${exe}`);
  fs.copyFileSync(process.execPath, out);
  if (process.platform === 'darwin') { try { execFileSync('codesign', ['--remove-signature', out]); } catch {} }
  if (process.platform === 'win32') { try { execFileSync('signtool', ['remove', '/s', out], { stdio: 'ignore' }); } catch {} }

  const postject = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject');
  const args = [path.basename(out), 'NODE_SEA_BLOB', path.basename(blob), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  // 경로에 공백/한글이 있어도 동작하도록 dist 안에서 상대 경로로 실행한다
  const opts = { stdio: 'inherit', cwd: dist, shell: process.platform === 'win32' };
  if (fs.existsSync(postject)) execFileSync(postject, args, opts);
  else execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'postject@1.0.0-alpha.6', ...args], opts);
  if (process.platform === 'darwin') { try { execFileSync('codesign', ['--sign', '-', out]); } catch {} }
  if (process.platform !== 'win32') fs.chmodSync(out, 0o755);
  fs.rmSync(blob); fs.rmSync(cfgPath);
  console.log(`✓ ${path.relative(root, out)}`);
} catch (e) {
  console.warn('! 단일 실행 파일(SEA) 빌드 실패 — krl-agent.js 만 생성됩니다:', e.message);
}

// ----- 체크섬 -----
const sums = fs.readdirSync(dist).filter((f) => fs.statSync(path.join(dist, f)).isFile() && f !== 'SHA256SUMS')
  .map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex')}  ${f}`);
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log('✓ dist/SHA256SUMS');
