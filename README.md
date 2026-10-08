# ping

말 대신 신호 하나로 만나는 작은 방. 링크로 입장하고 닉네임을 적용한 다음, 직접 **가능 / 불가능**을 선택한다. 누구의 새 핑이든 채널의 5분 타이머를 갱신한다.

## 실행 구조

**Cloudflare Workers Static Assets + SQLite-backed Durable Object + Hibernating WebSocket.** 별도 Deno 서버, Deno KV, Redis, Postgres, SSE, HTTP heartbeat, 보조 polling은 없다. 기존 플랫폼/API/식별자/저장 형식과의 호환 계층도 없다.

- `/r/<32자리 방 ID>`: 동일한 미니멀 화면, 닉네임은 첫 입장과 본인 구성원 카드 선택 때만 편집.
- 채널 하나에 Durable Object 하나. 닉네임, 가능 여부, 핑, 중복 방지 영수증을 SQLite에 저장한다.
- 연결은 `acceptWebSocket()`으로 수락한다. 브라우저의 15초 `~ping`은 Cloudflare의 `setWebSocketAutoResponse()`가 `~pong`으로 응답한다. 애플리케이션 핸들러와 DB 쓰기를 거치지 않는다.
- Alarm은 마지막 클라이언트 응답 시각을 확인해 45초 이상 응답 없는 연결을 제거한다. 예약 실행 지연은 있을 수 있다. 사용자나 연결 수만큼 서버 타이머를 만들지 않는다.
- 카운트다운/파비콘/5분 감쇠는 절대 만료 시각으로 브라우저에서 계산한다. 조용한 두 음의 핑 사운드와 로컬 타임라인은 유지한다.
- 같은 브라우저의 여러 탭은 동일한 익명 자격증명을 사용하고 한 사람으로 표시한다. 각 탭의 소켓은 독립적이며, 마지막 소켓이 사라져야 구성원에서 빠진다.
- 클라이언트 자격증명은 WebSocket 첫 메시지에서만 전송한다. URL이나 공개 사용자 목록에 넣지 않는다. 서버가 자격증명을 해시해 발신자를 결정한다. 닉네임은 인증 수단이 아니다.

## 로컬 개발

Node.js 22.16 이상:

```sh
npm ci
npm run dev
```

터미널의 로컬 주소 `http://127.0.0.1:8787`을 열고, 생성된 방 링크를 다른 브라우저에서 열면 된다. 로컬 Wrangler/workerd/SQLite만 사용하며 Cloudflare 계정은 개발에 필요하지 않다.

```sh
npm run check
npm test
npx playwright install --with-deps chromium webkit
npm run test:browser
npm run build  # 실제 업로드가 아닌 dry-run
```

테스트는 운영 도메인을 호출하지 않는다. Chromium/WebKit의 모바일 화면 설정은 실제 아이폰 하드웨어 검증과 다르다.

## 최초 배포: 소유자 작업

```sh
npx wrangler login
npm run deploy
```

`wrangler.jsonc`의 `ROOMS` 바인딩과 `new_sqlite_classes` 마이그레이션으로 Durable Objects 저장소가 생성된다. 별도 KV/D1 DB를 수동 생성하지 않는다. `workers.dev`에서 먼저 동작을 확인한 뒤 필요하면 같은 Worker에 자체 도메인을 연결한다.

담당자 체크리스트: [계정·최초 배포 #9](https://github.com/kuil09/ping/issues/9), [VAPID·실제 iPhone 검증 #10](https://github.com/kuil09/ping/issues/10), [Deno 운영 전환 정리 #11](https://github.com/kuil09/ping/issues/11).

GitHub Actions 배포를 사용하려면 `production` Environment에 `CLOUDFLARE_ACCOUNT_ID` **변수**와 `CLOUDFLARE_API_TOKEN` **시크릿**을 설정한다. 토큰은 해당 계정의 Worker 배포에 필요한 최소 권한으로 생성한다. 그 뒤 **Deploy Cloudflare → Run workflow → main**을 실행한다. 기본은 수동 배포이며, PR/브랜치마다 운영 배포하지 않는다. 배포 작업은 먼저 코드·단위·브라우저 검증을 통과해야 한다.

## Web Push (선택)

없어도 핑·구성원·상태·이력은 동작한다. 외부 앱 상태에서 OS 알림을 받으려면 다음 세 Worker 시크릿을 설정한다.

```sh
# 로컬에서만 실행. 키를 CI 로그나 이슈에 붙이지 않는다.
npm run vapid
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

`VAPID_SUBJECT`는 `mailto:실제이메일`이다. 이미 보관한 키를 재사용할 수도 있다. 로컬 테스트에서는 `.dev.vars.example`을 `.dev.vars`로 복사하고 값을 넣는다. `.dev.vars`는 Git에서 제외된다. 키 변경도 새 Worker 버전을 만들 수 있으므로 최초 실사용 검증 전에 설정을 마친다.

알림 허용 버튼은 사용자 조작으로만 권한을 요청한다. iPhone은 새 도메인의 방을 **홈 화면에 추가한 웹앱**에서 허용해야 한다. 일반 Safari 탭의 백그라운드 실행이나 매초 탭 제목 갱신을 강제하지 않는다. 소리는 사용자가 화면을 터치해 오디오를 활성화한 뒤 재생하며, OS 무음/볼륨 설정의 영향을 받는다. Web Push 알림음은 OS가 관리한다.

## 수명과 초기화

`CF_VERSION_METADATA.id`가 저장된 버전과 달라질 때 **해당 방이 새 코드로 실행되는 첫 시점에** 닉네임·가능 여부·핑·영수증·서버 푸시 구독을 초기화한다. 전 방을 순회하는 삭제 작업은 하지 않는다. 같은 버전에서의 Hibernation/객체 재생성은 초기화 원인이 아니다. 일반 재연결은 프로필을 복원한다.

활동이 없는 방은 마지막 활동에서 24시간 후 정리한다. 이벤트는 최대 128건·24시간, 요청 영수증은 최대 512건·24시간, 동시 구성원은 최대 64명/소켓은 128개다. 앱은 개인적인 소수 인원의 방을 위한 것이다. 무제한 공개 서비스용 가입·차단·과금 방어를 제공하지 않는다.

배포 후 닫혀 있던 웹앱은 다시 열어야 푸시 구독이 서버에 재등록된다. 브라우저의 로컬 이력은 서버 초기화와 독립적이다. 새 도메인이나 브라우저에는 기존 로컬 데이터를 옮기지 않는다.

## 비용에 관한 제한

서버 측 반복 `setInterval`/`setTimeout`이나 외부 DB watch가 없다. 그러나 Alarm, 실제 행동, 연결 수립, 암호화·푸시 발송, 저장소 작업에는 자원이 든다. Hibernation은 무과금 보증이 아니다. Workers/DO 대시보드에서 무료 한도와 실제 청구량을 확인한다. 이번 코드 검증은 사용자의 실제 Cloudflare 계정 청구량 측정이 아니다.

공식 문서: [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [자동 응답과 시각](https://developers.cloudflare.com/durable-objects/api/state/), [Alarm](https://developers.cloudflare.com/durable-objects/api/alarms/), [SQLite DO](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [버전 메타데이터](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/).
