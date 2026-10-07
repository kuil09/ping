import { HISTORY_DAYS, HISTORY_LIMIT } from "./history.js";

const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dayFormat = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" });
const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export function attachHistory(store, parent) {
  const details = document.createElement("details");
  details.id = "history";
  details.className = "history";
  // Only fixed application markup. Names/history text are inserted with textContent below.
  details.innerHTML = `
    <summary><span class="history-mark" aria-hidden="true"></span><span>이력</span><span id="history-count">0</span><span class="history-chevron" aria-hidden="true"></span></summary>
    <section class="history-content" aria-label="이 브라우저의 핑 이력">
      <div class="history-toolbar">
        <div class="history-filters" role="group" aria-label="이력 필터">
          <button type="button" data-filter="all" aria-pressed="true">전체</button>
          <button type="button" data-filter="ping" aria-pressed="false">핑</button>
        </div>
        <button id="history-clear" type="button">지우기</button>
      </div>
      <p id="history-note"></p>
      <div id="history-confirm" hidden>
        <span>이 채널의 로컬 이력을 지울까요?</span>
        <button id="history-clear-confirm" type="button">지우기</button>
        <button id="history-clear-cancel" type="button">취소</button>
      </div>
      <p class="history-empty" id="history-empty">아직 기록 없음<span>핑과 상태 변화가 생기면 여기에 남습니다.</span></p>
      <ol id="history-list" class="history-list"></ol>
      <button id="history-more" type="button" hidden>더 보기</button>
      <p class="history-footnote">이 브라우저가 확인한 활동만 기록합니다.<br>접속·이탈은 확인 시각이며, 접속 전 전체 활동은 복원하지 않습니다.</p>
    </section>`;
  parent.appendChild(details);
  const list = details.querySelector("#history-list");
  const count = details.querySelector("#history-count");
  const note = details.querySelector("#history-note");
  const empty = details.querySelector("#history-empty");
  const more = details.querySelector("#history-more");
  const confirmation = details.querySelector("#history-confirm");
  let filter = "all";
  let limit = 40;

  function render() {
    const all = store.entries();
    count.textContent = String(all.length);
    details.dataset.count = String(all.length);
    details.dataset.persistent = String(store.persistent);
    if (!details.open) return;
    note.textContent = store.persistent
      ? `이 브라우저에만 · ${HISTORY_DAYS}일 / 최대 ${HISTORY_LIMIT}건`
      : "로컬 저장 불가 · 이번 화면에서만 표시";
    const entries = all.filter((entry) => filter === "all" || entry.kind === "ping");
    empty.hidden = entries.length > 0;
    more.hidden = entries.length <= limit;
    list.replaceChildren();
    let previousDay;
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    for (const entry of entries.slice(0, limit)) {
      const date = new Date(entry.at);
      const key = dayKey(date);
      if (key !== previousDay) {
        const group = document.createElement("li");
        group.className = "history-day";
        group.textContent = key === dayKey(today) ? "오늘" : key === dayKey(yesterday) ? "어제" : dayFormat.format(date);
        list.appendChild(group);
        previousDay = key;
      }
      const row = document.createElement("li");
      row.className = "history-entry";
      row.dataset.kind = entry.kind;
      row.dataset.id = entry.id;
      const time = document.createElement("time");
      time.dateTime = date.toISOString();
      time.textContent = timeFormat.format(date);
      time.title = `${date.toLocaleString("ko-KR")} · ${entry.observed ? "확인 시각" : "발생 시각"}`;
      const dot = document.createElement("span");
      dot.className = "history-dot";
      dot.setAttribute("aria-hidden", "true");
      const text = document.createElement("div");
      text.className = "history-text";
      const name = document.createElement("bdi");
      name.className = "history-name";
      name.textContent = entry.name || "익명";
      const action = document.createElement("span");
      action.className = "history-action";
      const labels = { ping: "핑을 보냄", availability: entry.available ? "가능으로 변경" : "불가능으로 변경", join: "접속 확인", leave: "연결 종료 확인", reset: "새 배포 · 채널 초기화", nickname: "닉네임 변경" };
      action.textContent = labels[entry.kind];
      if (entry.kind === "nickname") name.textContent = `${entry.from || "익명"} → ${entry.name || "익명"}`;
      if (entry.kind !== "reset") text.appendChild(name);
      text.appendChild(action);
      row.append(time, dot, text);
      list.appendChild(row);
    }
  }
  details.addEventListener("toggle", render);
  for (const button of details.querySelectorAll("[data-filter]")) button.addEventListener("click", () => {
    filter = button.dataset.filter;
    limit = 40;
    for (const item of details.querySelectorAll("[data-filter]")) item.setAttribute("aria-pressed", String(item === button));
    render();
  });
  more.addEventListener("click", () => { limit += 40; render(); });
  details.querySelector("#history-clear").addEventListener("click", () => {
    confirmation.hidden = false;
    details.querySelector("#history-clear-cancel").focus();
  });
  details.querySelector("#history-clear-cancel").addEventListener("click", () => { confirmation.hidden = true; details.querySelector("#history-clear").focus(); });
  details.querySelector("#history-clear-confirm").addEventListener("click", () => {
    store.clear(); confirmation.hidden = true; details.querySelector("#history-clear").focus();
  });
  let refreshTimer;
  globalThis.addEventListener("storage", (event) => {
    if (event.key === null || event.key?.startsWith(store.prefix)) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => store.refresh(), 60);
    }
  });
  store.onchange = render;
  render();
  return details;
}
