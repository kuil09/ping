# ping-ws-v1

GET `/api/config`, GET `/api/health`는 저장소를 조회하지 않는다. `/api/rooms/<32 hex>/ws`만 실시간 인터페이스다. 이전 HTTP POST/SSE API는 존재하지 않는다.

연결의 Origin은 요청 origin과 같아야 한다. 첫 10초 안에 `{"type":"hello","protocol":"ping-ws-v1","credential":"64 hex secret","visible":true}`를 전송한다. 응답은 `welcome`과 서버가 계산한 `clientId`, 기준 `state`다. 자격증명은 localStorage의 `ping:v2:credential`에만 저장한다. 다른 사람에게 보내는 상태에는 자격증명/푸시 구독이 없다.

액션은 `nickname`, `availability`, `signal`, `subscribe`다. 각 액션은 `id`(UUID 등 8~80자 영숫자/하이픈/밑줄)를 갖는다. 서버의 `ack` 또는 `error`는 같은 id로 응답한다. 동일 id의 동일 행동은 24시간/최대 512개 영수증 범위에서 중복 생성하지 않는다. 내용이 바뀐 id 재사용은 `request_conflict`다. `subscribe`는 동일 사용자의 절대 구독 값을 덮어쓴다.

`state`는 generation, epoch, revision, 핑 sequence, serverTime, 현재 users, channelPing, 제한된 최근 ping events를 포함한다. 재연결 시 snapshot으로 복구하고 이벤트 ID로 로컬 중복을 제거한다. 128건을 넘어선 과거 이벤트의 완전한 복구를 보장하지 않는다. 장기 행동 이력은 각 브라우저가 직접 관찰한 기록이다.

클라이언트 `~ping` / 서버 `~pong`은 플랫폼 자동 응답이다. 이를 JSON 액션과 섞지 않는다. `visibility`는 푸시가 필요한 백그라운드 수신자를 판단하기 위한 드문 상태 변경이며 자동 응답 메시지가 아니다.

일반 close는 해당 연결을 제거한다. 응답이 없지만 열려 있는 연결은 마지막 자동 응답/행동 이후 45초가 지나면 Alarm에서 닫는다. 다른 탭이 살아 있으면 사용자는 유지된다. 핑 만료 시각과 가능 상태는 접속 상태와 독립적이다.
