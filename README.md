# KRL Cloud — 분산형 PC 호스팅 PaaS

내 PC 자원을 제공해 크레딧을 얻고, 그 크레딧으로 다른 사람들의 PC 위에 웹사이트·API·워커를 배포하는 서비스입니다.
서비스당 **`name.krl.kr`** 무료 서브도메인 1개를 발급하는 서브도메인 시스템이 있습니다 (예: `myapp.krl.kr`, `minsu.krl.kr`; Cloudflare 와일드카드 1개로 동작).

```
Contribute (노드 제공)  ─┐
Hosting   (배포/PaaS)   ─┼─ 컨트롤 플레인(server/) ◀── 아웃바운드 연결 ── 노드 에이전트(agent/) × N
Network   (복제/복구)   ─┤        │ 게이트웨이: name.krl.kr → 인스턴스 로드밸런싱(릴레이)
Economy   (크레딧)      ─┘        └ Cloudflare DNS/SSL
```

## 빠른 시작 (로컬)

```bash
npm run dev      # 컨트롤 플레인 서버 (가짜 데이터/시뮬레이션 없음)
node agent/agent.js install --server http://localhost:8080 --allow-unsandboxed   # 이 PC를 노드로 연결
```
- 대시보드 http://localhost:8080 에서 회원가입 → My Nodes → 내 PC 연결 → 코드 입력
- 서비스 접속: `http://<slug>.localhost:8080` (브라우저가 `*.localhost` 를 자동 해석)
- `npm test` — 종단간 테스트: 실제 서버/에이전트 프로세스를 띄워 페어링 → 배포 → 3노드 분산 → 로드밸런싱 → 노드 장애 → 자동 복구 → 롤백 → 크레딧 (`E2E_REPO=<신뢰하는 GitHub 저장소>` 를 주면 실제 clone/빌드 배포도 검증)

의존성 없음 (Node.js 20+ 만 필요).

## 구현된 기능

| 영역 | 기능 |
|---|---|
| Contribute | PC 등록/다중 등록, CPU·RAM·디스크·대역폭 제공량, 유휴 시에만 제공, 일시 중지, 원격 연결 해제, 노드 그룹, 신뢰도 점수, 온도/부하/지연 모니터링, 마켓플레이스 |
| Hosting | GitHub / Docker / 템플릿 배포, Node·Python·정적·커스텀 런타임, Web/Static/Worker/Cron/Private 서비스, 환경변수(Secret), 배포 버전·롤백(무중단), 로그, 리소스 사용량, GitHub 웹훅 자동 배포, 커스텀 도메인 |
| 다중 노드 | 인스턴스 개수 지정, 자동 배치(신뢰도·여유 용량·서로 다른 제공자 우선), 지역/국가/그룹 지정, 트래픽 분산(least-load), 오토스케일, 일괄 재시작/종료, HA·Priority·Spot |
| 안정성 | 하트비트 감시, 과부하/지연 감지 → 무중단 이동(make-before-break), 장애 노드 제외 + 대체 노드 투입, 자동 재실행/재참여, 장애 기록·알림, 가동률 |
| 크레딧 | 제공 보상·신규/장기/안정 가동 보너스·출석 이벤트, 인스턴스·전송 과금, 프로젝트별 비용·월별 통계·예상 소모량 |

## 노드 에이전트 설치 — 설치하면 자동으로 호스팅 참여

토큰 복사가 필요 없습니다. 설치 → 화면에 표시된 **연결 코드**를 대시보드(**My Nodes → 내 PC 연결**)에 입력 → 끝.
이후 부팅/로그인 때마다 자동 시작되어 호스팅에 참여합니다.

| OS | 설치 명령 | 자동 시작 |
|---|---|---|
| Windows | `iwr <서버>/install.ps1 -OutFile $env:TEMP/krl.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP/krl.ps1` | 작업 스케줄러 |
| macOS / Linux | `curl -fsSL <서버>/install.sh \| sh` | launchd / systemd --user |
| Android | Termux 에서 위와 동일 | Termux:Boot |
| 단일 실행 파일 | `krl-agent-<os>-<arch> install` (Node 불필요) | 위와 동일 |

`krl-agent uninstall` 로 제거, `krl-agent status` 로 연결 상태 확인. 설정은 `~/.krl-agent/config.json`.
`KRL_SERVER=https://krl.kr npm run build` 로 기본 서버 주소를 박아 넣으면 `install` 한 줄로 끝납니다.

**단일 실행 파일** 빌드: `npm run build` → `dist/krl-agent-<os>-<arch>`.
이 PC(Windows)용은 로컬 빌드되며, macOS/Linux/arm64 는 `.github/workflows/build-agent.yml` 이 각 OS 러너에서 빌드해 릴리스에 첨부합니다.

> **Android / iOS**: 네이티브 앱(APK)은 Android SDK 가 필요해 포함되지 않았습니다. Android 는 Termux 에이전트로 지원하며 정적 사이트 호스팅 위주입니다. iOS 는 백그라운드 서버 실행 제한으로 지원하지 않습니다.

### 보안 모델
- 에이전트는 **아웃바운드 연결만** 사용합니다 (포트포워딩/공인 IP 불필요, 게이트웨이가 요청을 롱폴링으로 릴레이).
- 정적 사이트는 에이전트 내부 파일 서버로 제공되어 **사용자 코드가 실행되지 않습니다**.
- Node/Python/Docker 앱은 **Docker 컨테이너**(CPU/RAM/pids 제한, cap-drop ALL)에서만 실행됩니다. Docker 가 없으면 코드 실행을 거부하며, 신뢰할 수 있는 개발용으로만 `--allow-unsandboxed` 를 명시해야 호스트에서 직접 실행됩니다.

## 운영 배포 (name.krl.kr + Cloudflare)

1. `krl.kr` 존을 Cloudflare 에 추가. API 토큰(Zone.DNS:Edit) 생성.
2. 서버 환경변수 (`.env.example` 참고): `CF_API_TOKEN`, `CF_ZONE_ID`, `CF_ORIGIN`(서버 IP 또는 호스트), `BASE_DOMAIN=krl.kr`.
3. 서버가 시작되면 Cloudflare 에 **`*.krl.kr` 와일드카드 프록시 레코드를 한 번만** 만듭니다. 이후 `myapp.krl.kr`, `minsu.krl.kr` 같은 이름은 **플랫폼의 서브도메인 시스템이 서비스당 1개씩 발급/회수**하며 DNS 를 건드리지 않습니다 (Cloudflare Universal SSL 이 `*.krl.kr` HTTPS 를 처리). 서비스별 개별 레코드가 필요하면 `CF_PER_RECORD=1`.
4. 대시보드 호스트 `app.krl.kr` / `krl.kr` 도 같은 서버로 연결하세요.
5. 커스텀 도메인 SSL: Cloudflare for SaaS 를 켜면 `custom_hostnames` API 로 자동 등록됩니다 (CNAME/TXT 검증 후).
6. 서버를 80/8080 으로 띄우고 Cloudflare SSL 모드는 Full 권장. `docker build -t krl-cloud . && docker run -p 8080:8080 -v krl-data:/data --env-file .env krl-cloud`

## 한계 / 다음 단계
- 데이터 저장은 단일 JSON 파일(소규모용) → 운영 시 SQLite/Postgres 권장. 컨트롤 플레인 이중화 없음.
- 영구 디스크/DB 서비스, 인스턴스 간 데이터 복제는 아직 없음 (현재는 stateless 서비스 전제).
- 게이트웨이 릴레이는 요청/응답을 버퍼링(10MB 제한)하며 WebSocket 은 미지원 → 스트리밍/WS 는 추후 터널로 개선.
- 크레딧은 내부 포인트이며 결제/현금화 기능은 없음. 악의적 노드(결과 조작) 방지를 위한 검증/평판 심화 필요.
- 에이전트 CPU "사용 중" 판단은 시스템 전체 CPU 기준의 근사치입니다.
