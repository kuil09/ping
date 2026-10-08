# 검증 범위

`npm run check`: TypeScript, 브라우저 JavaScript 문법, 서버 반복 타이머/외부 DB watch/레거시 통신을 금지하는 구조 검사.

`npm test`: 30개 순수 모델·로컬 이력·탭 카운트다운·음원 파형 테스트. 네트워크나 운영 계정은 사용하지 않는다.

`npm run test:runtime`: 실제 workerd에 테스트 전용 번들을 올려 두 가지를 확인한다.
1. Worker에서 생성한 Web Push 암호문을 수신자 키로 복호화하고 VAPID 서명을 검증한다. 외부 APNs/FCM으로 전송하지 않는다.
2. 같은 SQLite 저장소로 workerd를 종료/재생성했을 때 같은 배포 ID면 프로필·가능 여부·핑·푸시 구독이 보존되고, 배포 ID가 달라지면 모두 초기화되는지 확인한다. 테스트용 SQLite 조회 endpoint는 tests/ 아래의 별도 진입점에만 있고 운영 번들에는 없다.

`npm run test:browser`: 실제 Wrangler/workerd에 Chromium과 WebKit을 연결하는 9개 시나리오. 닉네임·독립 상태·핑 갱신·탭 제목·로컬 이력·다중 탭·채널 격리·45초 무응답·자격증명 기반 발신자·외부 Origin 거절·재연결 복구·네이티브 오디오와 숨김 상태를 검증한다. 16초 유휴 구간에 HTTP API polling이 없는지도 검사한다.

추가된 두 프로필 시나리오는 시계 갱신 및 상대 핑 수신 때 폼을 불필요하게 변경하지 않는지 MutationObserver로 검사한다. 엔진별로 실제 이름 저장 16회가 각각 한 번 제출/적용되는지 검증하고, 브라우저 컨텍스트 trace와 실패 시 DOM/터치/submit 정보를 기록한다. 이 파일은 중복 시작을 피하기 위해 러너의 자동 trace 대신 수동 context trace를 소유한다. 다른 테스트의 trace 설정은 유지한다.

자동화는 실제 휴대폰의 무음 스위치, APNs/FCM 배달, Cloudflare 운영 계정의 Duration/요금 측정을 대신하지 않는다. 배포와 이 검증을 혼동하지 않는다. 운영 확인은 #9~#11의 소유자 체크리스트에서 수행한다.
