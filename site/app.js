"use strict";

const API = ((window.APP_CONFIG && window.APP_CONFIG.apiBase) || "").replace(/\/+$/, "");
const TOKEN_KEY = "calorie-note-token";
const SYNC_INTERVAL_MS = 30_000;
const MEAL_TYPES = [
  ["breakfast", "아침"],
  ["lunch", "점심"],
  ["dinner", "저녁"],
  ["snack", "간식"],
];
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const WEEKDAYS_LONG = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const ACTIVITY = [
  ["sedentary", "비활동적", "대부분 앉아서 생활하고 운동은 거의 하지 않아요"],
  ["low", "저활동적", "가벼운 걷기·집안일, 주 1~2회 가벼운 운동"],
  ["active", "활동적", "주 3~5회 운동하거나 많이 걷는 일을 해요"],
  ["very_active", "매우 활동적", "거의 매일 강한 운동이나 몸 쓰는 일을 해요"],
];
const GOAL_PRESETS = [
  [0, "권장량"],
  [-300, "−300"],
  [-500, "−500"],
];
const STATUS = { green: "good", orange: "warn", red: "bad" };

const ICON = {
  left: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14.5 6 8.5 12l6 6"/></svg>`,
  right: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
  dish: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 16h18M5 16a7 7 0 0 1 14 0M12 9V7"/></svg>`,
};

const state = {
  token: null,
  me: null, // "user1" | "user2"
  users: [], // [{ user_key, name, profile }]
  view: "day",
  date: ymd(new Date()),
  viewUser: null,
  month: ymd(new Date()).slice(0, 7),
  day: null,
  cal: null,
};

const $app = document.getElementById("app");
const $tabs = document.getElementById("tabs");
const $modal = document.getElementById("modal");
const $lightbox = document.getElementById("lightbox");

// ---------- 유틸 ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hm(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function fmtDate(s) {
  const d = parseYmd(s);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
}

function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${pad(m)}`;
}

function relDay(s) {
  const today = ymd(new Date());
  if (s === today) return "오늘";
  if (s === addDays(today, -1)) return "어제";
  return fmtDate(s);
}

function fmtKcal(n) {
  return Number(n).toLocaleString("ko-KR");
}

/** 시간대로 끼니를 추정한다: 04~10시 아침, 11~15시 점심, 그 외 저녁. */
function guessMealType(d) {
  const h = d.getHours();
  if (h >= 4 && h < 11) return "breakfast";
  if (h >= 11 && h < 16) return "lunch";
  return "dinner";
}

function storage(fn) {
  try {
    return fn(window.localStorage);
  } catch {
    return null;
  }
}

function userName(key) {
  return state.users.find((u) => u.user_key === key)?.name ?? key;
}

function myProfile() {
  return state.users.find((u) => u.user_key === state.me)?.profile ?? null;
}

function statusKey(status) {
  return STATUS[status] || "";
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

// ---------- API ----------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", json, form } = {}) {
  const headers = {};
  if (state.token) headers["x-app-token"] = state.token;
  let body;
  if (form) body = form;
  else if (json !== undefined) {
    body = JSON.stringify(json);
    headers["content-type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(API + path, { method, headers, body });
  } catch {
    throw new ApiError(0, "서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    logout();
    throw new ApiError(401, data.error || "다시 로그인해 주세요.");
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `오류가 발생했습니다 (${res.status}).`);
  return data;
}

// ---------- 사진: EXIF 촬영 시각, 리사이즈 ----------

/** JPEG EXIF에서 촬영 시각(DateTimeOriginal, 없으면 DateTime)을 읽는다. 없으면 null. */
async function readExifDate(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 10 < v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) return null;
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiffDate(v, off + 10);
      off += 2 + len;
    }
  } catch { /* 손상되었거나 잘린 EXIF */ }
  return null;
}

function parseTiffDate(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  const ifd = (o) => {
    const tags = {};
    const n = u16(o);
    for (let i = 0; i < n; i++) tags[u16(o + 2 + i * 12)] = o + 2 + i * 12;
    return tags;
  };
  const ascii = (entry) => {
    const count = u32(entry + 4);
    const o = count > 4 ? u32(entry + 8) : entry + 8;
    let s = "";
    for (let i = 0; i < count - 1; i++) s += String.fromCharCode(v.getUint8(start + o + i));
    return s;
  };
  const ifd0 = ifd(u32(4));
  let raw = null;
  if (ifd0[0x8769] !== undefined) {
    const exif = ifd(u32(ifd0[0x8769] + 8));
    if (exif[0x9003] !== undefined) raw = ascii(exif[0x9003]);
  }
  if (!raw && ifd0[0x0132] !== undefined) raw = ascii(ifd0[0x0132]);
  const m = raw && raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 ? null : d;
}

/** 긴 변 1600px JPEG로 줄인다. 브라우저가 못 여는 형식이면 원본을 그대로 쓴다. */
async function prepareImage(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    if (blob) return blob;
  } catch { /* fall through */ }
  if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type) && file.size <= 5 * 1024 * 1024) return file;
  throw new Error("이 사진 형식은 열 수 없습니다. JPEG/PNG 사진으로 다시 시도해 주세요.");
}

function pickFiles({ multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = multiple;
    input.addEventListener("change", () => resolve([...input.files]));
    input.click();
  });
}

// ---------- 로그인 ----------

async function renderLogin() {
  $tabs.hidden = true;
  let users = [];
  try {
    users = (await api("/users")).users;
  } catch (e) {
    $app.innerHTML = `<p class="eyebrow">Calorie Note</p><div class="card error">${esc(e.message)}</div>`;
    return;
  }
  let selected = storage((s) => s.getItem("calorie-note-last-user")) || users[0].user_key;
  $app.innerHTML = `
    <div class="login">
      <p class="eyebrow">Calorie Note</p>
      <h1 class="display">오늘의 식사를<br>가볍게 기록해요</h1>
      <p class="lead">사진 한 장이면 칼로리가 채워지고, 두 사람의 하루가 한 달력에 쌓여요.</p>
      <form class="card" id="login-form">
        <div class="field">
          <span class="label">누구세요?</span>
          <div class="pills fill">
            ${users.map((u) => `<button type="button" class="pill" data-user="${u.user_key}">${esc(u.name)}</button>`).join("")}
          </div>
        </div>
        <label class="field"><span class="label">비밀번호</span>
          <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <button class="btn primary block" type="submit">로그인</button>
        <p class="error small" id="login-error" style="margin:12px 0 0"></p>
      </form>
    </div>`;
  const mark = () => $app.querySelectorAll("[data-user]").forEach((b) => b.classList.toggle("on", b.dataset.user === selected));
  mark();
  $app.querySelectorAll("[data-user]").forEach((b) => b.addEventListener("click", () => {
    selected = b.dataset.user;
    mark();
    $app.querySelector("input[name=password]").focus();
  }));
  $app.querySelector("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const data = await api("/login", { method: "POST", json: { user_key: selected, password: e.target.password.value } });
      state.token = data.token;
      state.me = data.user_key;
      state.users = data.users;
      state.viewUser = data.user_key;
      storage((s) => {
        s.setItem(TOKEN_KEY, data.token);
        s.setItem("calorie-note-last-user", data.user_key);
      });
      go(needsProfile() ? "profile" : "day");
    } catch (err) {
      $app.querySelector("#login-error").textContent = err.message;
      btn.disabled = false;
    }
  });
}

function needsProfile() {
  const p = myProfile();
  return !p?.daily_target_kcal || !p.activity_level;
}

function logout() {
  state.token = null;
  state.me = null;
  storage((s) => s.removeItem(TOKEN_KEY));
  renderLogin();
}

// ---------- 화면 전환 ----------

function go(view) {
  state.view = view;
  $tabs.hidden = false;
  $tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  window.scrollTo(0, 0);
  refresh();
}

async function refresh({ silent = false } = {}) {
  if (!state.token) return;
  try {
    if (state.view === "day") {
      if (!silent) $app.innerHTML = `<p class="center muted">불러오는 중…</p>`;
      state.day = await api(`/day?date=${state.date}`);
      renderDay();
    } else if (state.view === "calendar") {
      if (!silent) $app.innerHTML = `<p class="center muted">불러오는 중…</p>`;
      state.cal = await api(`/calendar?month=${state.month}`);
      renderCalendar();
    } else if (state.view === "profile") {
      if (silent) return; // 입력 중인 값을 덮어쓰지 않는다
      const me = await api("/me");
      state.users = me.users;
      renderProfile();
    }
  } catch (e) {
    if (!silent && state.token) $app.innerHTML = `<div class="card error">${esc(e.message)}</div>`;
  }
}

$tabs.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (btn) go(btn.dataset.view);
});

// 두 사람의 기록을 준실시간으로 맞춘다: 30초마다, 그리고 앱으로 돌아올 때 새로고침.
setInterval(() => {
  if (document.visibilityState === "visible" && !$modal.open) refresh({ silent: true });
}, SYNC_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$modal.open) refresh({ silent: true });
});

// ---------- 하루 화면 ----------

function renderDay() {
  const d = state.day;
  const key = state.viewUser || state.me;
  const u = d.users[key];
  const mine = key === state.me;
  const total = u.total_kcal;
  const target = u.target_kcal;
  const s = statusKey(u.status);
  const date = parseYmd(d.date);

  let summary;
  if (target) {
    const diff = target - total;
    const pct = Math.min(100, Math.round((total / target) * 100));
    summary = `
      <p class="eyebrow">섭취 칼로리</p>
      <div class="row"><span class="num big">${fmtKcal(total)}</span><span class="of">/ ${fmtKcal(target)} kcal</span></div>
      <div class="meter"><div class="${s ? `bg-${s}` : ""}" style="width:${pct}%"></div></div>
      <div class="small ${s ? `t-${s}` : "muted"}">${diff >= 0 ? `${fmtKcal(diff)} kcal 남았어요` : `목표보다 ${fmtKcal(-diff)} kcal 더 먹었어요`}</div>`;
  } else {
    summary = `
      <p class="eyebrow">섭취 칼로리</p>
      <div class="row"><span class="num big">${fmtKcal(total)}</span><span class="of">kcal</span></div>
      <p class="small muted" style="margin:16px 0 0">${
      mine ? `하루 목표가 아직 없어요. <a href="#" data-go="profile">내 정보</a>에서 설정하세요.` : "아직 목표를 설정하지 않았어요."
    }</p>`;
  }

  const groups = MEAL_TYPES.map(([type, label]) => {
    const meals = u.meals.filter((m) => m.meal_type === type);
    if (!meals.length && type === "snack") return "";
    const sum = meals.reduce((acc, m) => acc + m.calories_kcal, 0);
    return `
      <div class="meal-group">
        <div class="group-head"><p class="eyebrow">${label}</p><span class="small muted">${meals.length ? `${fmtKcal(sum)} kcal` : ""}</span></div>
        ${
      meals.length
        ? meals.map((m) => `
          <button class="meal" data-meal="${m.id}">
            ${m.photo_url ? `<img class="thumb" src="${esc(m.photo_url)}" alt="" loading="lazy">` : `<span class="thumb ph">${ICON.dish}</span>`}
            <span class="info">
              <span class="name">${esc(m.food_name)}</span>
              <span class="meta small muted">${fmtTime(hm(new Date(m.recorded_at)))}${m.items.length > 1 ? ` · ${m.items.length}가지` : ""}${
          m.ai_estimated ? `<span class="tag">AI 추정</span>` : ""
        }</span>
            </span>
            <span class="kcal num">${fmtKcal(m.calories_kcal)} kcal</span>
          </button>`).join("")
        : (u.skipped || []).includes(type)
        ? `<div class="empty-line skipped"><span>안 먹었어요</span>${mine ? `<button class="btn text" data-unskip="${type}">취소</button>` : ""}</div>`
        : `<div class="empty-line"><span>아직 기록이 없어요</span>${
          mine && type !== "snack" ? `<button class="btn text" data-skip="${type}">안 먹음</button>` : ""
        }</div>`
    }
      </div>`;
  }).join("");

  const photos = u.workout_photos.map((p) => `
    <div class="p">
      ${p.photo_url ? `<img src="${esc(p.photo_url)}" alt="운동 사진" data-zoom loading="lazy">` : ""}
      ${mine ? `<button class="del" data-del-photo="${p.id}" aria-label="사진 삭제">${ICON.close}</button>` : ""}
    </div>`).join("");

  $app.innerHTML = `
    <div class="day-head">
      <button class="icon-btn" data-shift="-1" aria-label="전날">${ICON.left}</button>
      <div class="titles">
        <p class="eyebrow">${d.date === ymd(new Date()) ? "오늘" : WEEKDAYS_LONG[date.getDay()]}</p>
        <label class="date-pick">
          <span class="h1">${date.getMonth() + 1}월 ${date.getDate()}일</span>
          <input type="date" value="${d.date}" aria-label="날짜 선택">
        </label>
      </div>
      <button class="icon-btn" data-shift="1" aria-label="다음날">${ICON.right}</button>
    </div>

    <div class="pills fill user-switch">
      ${state.users.map((x) => `<button class="pill ${x.user_key === key ? "on" : ""}" data-user="${x.user_key}">${esc(x.name)}</button>`).join("")}
    </div>

    <div class="card summary" style="margin-top:16px">${summary}</div>

    <section class="section">
      <div class="section-head"><h2 class="h2">식사</h2></div>
      <div class="card">${groups}</div>
      ${
    mine
      ? `<div class="btn-stack" style="margin-top:16px">
             <button class="btn primary block" data-add="photo">${ICON.camera}사진으로 기록</button>
             <button class="btn outline block" data-add="manual">직접 입력</button>
           </div>`
      : ""
  }
    </section>

    <section class="section">
      <div class="band sage">
        <div class="workout-head">
          <h2 class="h2">운동</h2>
          ${
    mine
      ? `<label class="switch" aria-label="운동한 날로 표시"><input type="checkbox" id="workout-toggle" ${u.worked_out ? "checked" : ""}><span></span></label>`
      : `<span class="small">${u.worked_out ? "운동했어요" : "기록 없음"}</span>`
  }
        </div>
        <p class="small" style="margin:8px 0 0;color:var(--stone)">${
    u.worked_out ? "운동한 날로 기록됐어요." : mine ? "운동했다면 켜거나 사진을 올려 주세요." : ""
  }</p>
        ${photos ? `<div class="photos">${photos}</div>` : ""}
        ${mine ? `<button class="btn outline block" style="margin-top:20px" data-add="workout">운동 사진 올리기</button>` : ""}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="h2">${d.date === ymd(new Date()) ? "오늘의 피드백" : "이날의 피드백"}</h2></div>
      <div class="card">${feedbackHtml(u)}</div>
    </section>`;

  $app.querySelectorAll("[data-shift]").forEach((b) => b.addEventListener("click", () => {
    state.date = addDays(state.date, Number(b.dataset.shift));
    refresh();
  }));
  $app.querySelector(".date-pick input").addEventListener("change", (e) => {
    if (e.target.value) {
      state.date = e.target.value;
      refresh();
    }
  });
  $app.querySelectorAll("[data-user]").forEach((b) => b.addEventListener("click", () => {
    state.viewUser = b.dataset.user;
    renderDay();
  }));
  $app.querySelector("[data-go]")?.addEventListener("click", (e) => {
    e.preventDefault();
    go("profile");
  });
  $app.querySelectorAll("[data-meal]").forEach((b) => b.addEventListener("click", () => {
    const meal = u.meals.find((m) => m.id === b.dataset.meal);
    if (mine) openMealEditor({ meal });
    else if (meal.photo_url) zoom(meal.photo_url);
  }));
  $app.querySelectorAll("[data-zoom]").forEach((img) => img.addEventListener("click", () => zoom(img.src)));
  $app.querySelectorAll("[data-skip], [data-unskip]").forEach((b) => b.addEventListener("click", async () => {
    const type = b.dataset.skip || b.dataset.unskip;
    try {
      await api(`/skips/${state.date}/${type}`, { method: b.dataset.skip ? "PUT" : "DELETE" });
      refresh({ silent: true });
    } catch (e) {
      toast(e.message);
    }
  }));
  $app.querySelector("[data-add=photo]")?.addEventListener("click", addMealFromPhoto);
  $app.querySelector("[data-add=manual]")?.addEventListener("click", () => {
    const now = new Date();
    openMealEditor({ draft: { date: ymd(now), time: hm(now), meal_type: guessMealType(now) } });
  });
  $app.querySelector("[data-add=workout]")?.addEventListener("click", addWorkoutPhotos);
  $app.querySelector("#workout-toggle")?.addEventListener("change", (e) => toggleWorkout(e.target));
  $app.querySelectorAll("[data-del-photo]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("이 운동 사진을 삭제할까요?")) return;
    try {
      await api(`/workout-photos/${b.dataset.delPhoto}`, { method: "DELETE" });
      refresh({ silent: true });
    } catch (e) {
      toast(e.message);
    }
  }));
}

const MACRO_LABELS = [
  ["carbs_g", "탄수화물", "m-carb"],
  ["protein_g", "단백질", "m-protein"],
  ["fat_g", "지방", "m-fat"],
];

function feedbackHtml(u) {
  if (!u.meals.length && !u.feedback.length) {
    return `<p class="muted small" style="margin:0">식사를 기록하면 탄수화물·단백질·지방 비율과 피드백을 보여 드려요.</p>`;
  }
  const m = u.macros;
  const kcal = { carbs_g: m.carbs_g * 4, protein_g: m.protein_g * 4, fat_g: m.fat_g * 9 };
  const sum = kcal.carbs_g + kcal.protein_g + kcal.fat_g;
  const pct = (k) => (sum ? Math.round((kcal[k] / sum) * 100) : 0);
  const macros = sum
    ? `<p class="eyebrow">탄단지 비율</p>
       <div class="macro-bar">${MACRO_LABELS.map(([k, , cls]) => `<span class="${cls}" style="width:${(kcal[k] / sum) * 100}%"></span>`).join("")}</div>
       <div class="macro-legend">${
      MACRO_LABELS.map(([k, label, cls]) =>
        `<div><span class="swatch ${cls}"></span><span class="small">${label}</span><b class="num">${pct(k)}%</b><span class="small muted">${Math.round(m[k])}g</span></div>`
      ).join("")
    }</div>`
    : "";
  const list = u.feedback.map((f) => `<li class="fb-${f.level}">${esc(f.text)}</li>`).join("");
  return `${macros}<ul class="feedback ${sum ? "" : "flush"}">${list}</ul>`;
}

function zoom(src) {
  $lightbox.querySelector("img").src = src;
  $lightbox.showModal();
}
$lightbox.addEventListener("click", () => $lightbox.close());

async function toggleWorkout(input) {
  const on = input.checked;
  if (!on && state.day.users[state.me].workout_photos.length && !confirm("운동 표시를 끄면 이 날의 운동 사진도 삭제됩니다. 계속할까요?")) {
    input.checked = true;
    return;
  }
  try {
    await api(`/workouts/${state.date}`, { method: on ? "PUT" : "DELETE" });
    refresh({ silent: true });
  } catch (e) {
    input.checked = !on;
    toast(e.message);
  }
}

async function addWorkoutPhotos() {
  const files = await pickFiles({ multiple: true });
  if (!files.length) return;
  toast(`사진 ${files.length}장 올리는 중…`);
  const dates = new Set();
  let failed = 0;
  for (const file of files) {
    try {
      const at = (await readExifDate(file)) || new Date();
      const form = new FormData();
      form.set("photo", await prepareImage(file), "workout.jpg");
      form.set("date", ymd(at));
      form.set("recorded_at", at.toISOString());
      await api("/workout-photos", { method: "POST", form });
      dates.add(ymd(at));
    } catch (e) {
      failed++;
      console.error(e);
    }
  }
  const where = [...dates].sort().map(relDay).join(", ");
  toast(failed ? `${files.length - failed}장 올림, ${failed}장 실패` : `${where} 운동 기록에 추가했어요`);
  if (dates.size === 1 && !dates.has(state.date)) state.date = [...dates][0];
  refresh({ silent: true });
}

// ---------- 식사 기록: 사진 → 분석 → 초안 → 확인/수정 → 저장 ----------

async function addMealFromPhoto() {
  const [file] = await pickFiles();
  if (!file) return;
  let photo;
  try {
    photo = await prepareImage(file);
  } catch (e) {
    toast(e.message);
    return;
  }
  const at = (await readExifDate(file)) || new Date();
  openMealEditor({ draft: { date: ymd(at), time: hm(at), meal_type: guessMealType(at), photo, analyzing: true } });
}

const MACRO_KEYS = ["carbs_g", "protein_g", "fat_g"];

function macrosOf(it) {
  return MACRO_KEYS.every((k) => typeof it[k] === "number") ? { carbs_g: it.carbs_g, protein_g: it.protein_g, fat_g: it.fat_g } : null;
}

/** 편집용 항목. aiName/aiKcal은 AI가 마지막으로 추정한 이름·칼로리(사용자가 고쳤는지 판단용). */
function editItem(src, fromAi) {
  const macros = macrosOf(src);
  return {
    name: src.name,
    kcal: String(src.calories_kcal),
    macros,
    aiName: macros ? src.name : null,
    aiKcal: macros ? src.calories_kcal : null,
    fromAi,
  };
}

function blankItem() {
  return { name: "", kcal: "", macros: null, aiName: null, aiKcal: null, fromAi: false };
}

/** 저장할 항목. 칼로리를 고쳤으면 탄단지도 같은 비율로 맞추고, 이름이 바뀌었으면 버린다. */
function itemPayload(it) {
  const out = { name: it.name.trim(), calories_kcal: Math.round(Number(it.kcal)) };
  if (it.macros && it.aiName === it.name && it.aiKcal !== null) {
    const scale = it.aiKcal > 0 ? out.calories_kcal / it.aiKcal : 1;
    for (const k of MACRO_KEYS) out[k] = Math.round(it.macros[k] * scale * 10) / 10;
  }
  return out;
}

function openMealEditor({ meal, draft }) {
  const editing = !!meal;
  const d = editing
    ? {
      date: meal.date,
      time: hm(new Date(meal.recorded_at)),
      meal_type: meal.meal_type,
      items: meal.items.map((i) => editItem(i, false)),
      photo_url: meal.photo_url,
      ai_estimated: meal.ai_estimated,
    }
    : { items: [blankItem()], ...draft };
  let items = d.items;
  let mealType = d.meal_type;
  const previewUrl = d.photo ? URL.createObjectURL(d.photo) : d.photo_url;

  $modal.innerHTML = `
    <div class="inner">
      <div class="modal-head">
        <h2 class="h2" tabindex="-1" autofocus>${editing ? "식사 수정" : "식사 기록"}</h2>
        <button type="button" class="icon-btn" id="meal-close" aria-label="닫기">${ICON.close}</button>
      </div>
      ${previewUrl ? `<img class="preview" src="${esc(previewUrl)}" alt="">` : ""}
      <div class="ai-box" id="analysis" ${d.analyzing ? "" : "hidden"}>
        <p class="eyebrow">AI 분석</p><span class="spinner"></span>사진 속 음식을 살펴보고 있어요…
      </div>
      <form id="meal-form" novalidate>
        <div class="field">
          <span class="label">언제</span>
          <div class="when">
            <span id="when-text"></span>
            <button type="button" class="btn text" id="when-toggle">변경</button>
          </div>
          <div class="when-edit" id="when-edit" hidden>
            <label><span class="label small muted">날짜</span><input type="date" name="date" value="${d.date}"></label>
            <label><span class="label small muted">시간</span><input type="time" name="time" value="${d.time}"></label>
          </div>
        </div>
        <div class="field">
          <span class="label">끼니</span>
          <div class="pills fill" id="meal-type">${
    MEAL_TYPES.map(([t, l]) => `<button type="button" class="pill ${t === mealType ? "on" : ""}" data-t="${t}">${l}</button>`).join("")
  }</div>
        </div>
        ${
    !editing && !d.photo
      ? `<label class="check" id="skip-row" ${mealType === "snack" ? "hidden" : ""}>
          <input type="checkbox" id="skip-meal"><span>이 끼니는 안 먹었어요</span>
        </label>`
      : ""
  }
        <div class="field" id="food-field" style="margin-bottom:0">
          <span class="label">음식</span>
          <div class="items" id="items"></div>
          <p class="small muted" style="margin:8px 0 0">칼로리를 모르면 이름만 쓰세요. "라면 반 개"처럼 양을 적으면 더 정확해요.</p>
          <div class="item-actions">
            <button type="button" class="btn text" id="add-item">+ 음식 추가</button>
            <button type="button" class="btn text" id="fill-kcal" hidden>빈 칼로리 AI로 채우기</button>
          </div>
          <div class="total"><span class="eyebrow" style="margin:0">합계</span><span><span class="num" id="total">0</span> kcal</span></div>
          <p class="note" id="estimate-note" ${d.ai_estimated ? "" : "hidden"}>AI가 추정한 값이 들어 있어요. 실제와 다를 수 있으니 확인 후 수정하세요.</p>
        </div>
        <p class="error small" id="meal-error" style="margin:12px 0 0"></p>
        <div class="modal-actions">
          <button type="button" class="btn outline" id="meal-cancel">취소</button>
          <button type="submit" class="btn primary">저장</button>
        </div>
        ${editing ? `<div class="modal-foot"><button type="button" class="btn text danger" id="meal-delete">이 기록 삭제</button></div>` : ""}
      </form>
    </div>`;
  $modal.showModal();
  $modal.querySelector(".modal-head .h2").focus();

  const form = $modal.querySelector("#meal-form");
  const $items = $modal.querySelector("#items");
  const $total = $modal.querySelector("#total");
  const $whenText = $modal.querySelector("#when-text");
  const $fill = $modal.querySelector("#fill-kcal");
  const pending = new Set(); // 추정 중인 항목

  const updateWhen = () => {
    const date = form.date.value || d.date;
    const time = form.time.value || d.time;
    $whenText.textContent = `${relDay(date)} ${fmtTime(time)}`;
  };
  const totalKcal = () => items.reduce((sum, i) => sum + (Number(i.kcal) || 0), 0);
  const usesAi = () => items.some((i) => i.aiKcal !== null && i.fromAi && Number(i.kcal) === i.aiKcal);
  const refreshMeta = () => {
    $total.textContent = fmtKcal(totalKcal());
    $modal.querySelector("#estimate-note").hidden = !(usesAi() || (editing && d.ai_estimated));
    $fill.hidden = !items.some((i) => i.name.trim() && i.kcal === "" && !pending.has(i));
  };
  const rowHtml = (it, i) => `
    <div class="item-row" data-i="${i}">
      <input type="text" class="item-name" value="${esc(it.name)}" placeholder="예: 김치찌개" maxlength="50" enterkeyhint="next" aria-label="음식 이름">
      <span class="kcal-wrap ${pending.has(it) ? "busy" : ""}"><input type="number" class="item-kcal" value="${esc(it.kcal)}" min="0" max="10000" step="1" inputmode="numeric" placeholder="${pending.has(it) ? "추정 중" : "0"}" aria-label="칼로리"></span>
      <button type="button" class="remove" aria-label="삭제" ${items.length === 1 ? "disabled" : ""}>${ICON.close}</button>
    </div>`;
  const renderItems = () => {
    $items.innerHTML = items.map(rowHtml).join("");
    refreshMeta();
  };
  // 행을 다시 그리지 않고 칼로리 칸만 고친다 (입력 중인 칸의 포커스·키보드를 유지)
  const renderRow = (it) => {
    const row = $items.querySelector(`[data-i="${items.indexOf(it)}"]`);
    if (!row) return;
    const kcal = row.querySelector(".item-kcal");
    if (kcal.value !== it.kcal) kcal.value = it.kcal;
    kcal.placeholder = pending.has(it) ? "추정 중" : "0";
    row.querySelector(".kcal-wrap").classList.toggle("busy", pending.has(it));
    refreshMeta();
  };

  /** 이름만 있고 칼로리를 사용자가 정하지 않은 항목들의 칼로리·탄단지를 AI로 채운다. */
  async function estimateItems(targets) {
    targets = targets.filter((it) => it.name.trim() && !pending.has(it));
    if (!targets.length) return;
    targets.forEach((it) => pending.add(it));
    targets.forEach(renderRow);
    try {
      const { items: est } = await api("/estimate", { method: "POST", json: { names: targets.map((it) => it.name.trim()) } });
      targets.forEach((it, n) => {
        const e = est[n];
        if (!items.includes(it) || it.name.trim() !== e.name) return; // 그사이 지웠거나 이름을 바꿈
        const userSetKcal = it.kcal !== "" && Number(it.kcal) !== it.aiKcal;
        it.macros = macrosOf(e);
        it.aiName = it.name;
        it.aiKcal = e.calories_kcal;
        it.fromAi = true;
        if (!userSetKcal) it.kcal = String(e.calories_kcal);
      });
    } catch (e) {
      $modal.querySelector("#meal-error").textContent = `칼로리를 추정하지 못했어요: ${e.message}`;
    } finally {
      targets.forEach((it) => pending.delete(it));
      if ($modal.open) targets.forEach(renderRow);
    }
  }

  updateWhen();
  renderItems();

  $items.addEventListener("input", (e) => {
    const row = e.target.closest(".item-row");
    if (!row) return;
    const it = items[Number(row.dataset.i)];
    if (e.target.classList.contains("item-name")) it.name = e.target.value;
    else it.kcal = e.target.value;
    e.target.classList.remove("invalid");
    refreshMeta();
  });
  // 이름 입력을 마치면(다음 칸으로 이동·엔터) 칼로리가 비었거나 AI 값 그대로일 때 자동 추정
  $items.addEventListener("change", (e) => {
    if (!e.target.classList.contains("item-name")) return;
    const it = items[Number(e.target.closest(".item-row").dataset.i)];
    const kcalIsAuto = it.kcal === "" || (it.aiKcal !== null && Number(it.kcal) === it.aiKcal);
    if (it.name.trim() && it.name !== it.aiName && kcalIsAuto) {
      if (it.kcal !== "") it.kcal = "";
      estimateItems([it]);
    }
  });
  $items.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.classList.contains("item-name")) return;
    e.preventDefault(); // 엔터로 폼이 저장되지 않게
    e.target.closest(".item-row").querySelector(".item-kcal").focus();
  });
  $items.addEventListener("click", (e) => {
    const btn = e.target.closest(".remove");
    if (!btn || items.length === 1) return;
    items.splice(Number(btn.closest(".item-row").dataset.i), 1);
    renderItems();
  });
  $modal.querySelector("#add-item").addEventListener("click", () => {
    items.push(blankItem());
    renderItems();
    $items.querySelector(".item-row:last-child .item-name").focus();
  });
  $fill.addEventListener("click", () => estimateItems(items.filter((i) => i.name.trim() && i.kcal === "")));
  $modal.querySelector("#when-toggle").addEventListener("click", (e) => {
    const box = $modal.querySelector("#when-edit");
    box.hidden = !box.hidden;
    e.target.textContent = box.hidden ? "변경" : "닫기";
  });
  form.date.addEventListener("change", updateWhen);
  form.time.addEventListener("change", updateWhen);
  const $skip = $modal.querySelector("#skip-meal");
  const skipping = () => !!$skip?.checked && mealType !== "snack";
  const updateSkip = () => {
    $modal.querySelector("#food-field").hidden = skipping();
    const row = $modal.querySelector("#skip-row");
    if (row) row.hidden = mealType === "snack";
  };
  $skip?.addEventListener("change", updateSkip);
  $modal.querySelectorAll("#meal-type .pill").forEach((b) => b.addEventListener("click", () => {
    mealType = b.dataset.t;
    $modal.querySelectorAll("#meal-type .pill").forEach((x) => x.classList.toggle("on", x === b));
    updateSkip();
  }));
  $modal.querySelector("#meal-cancel").addEventListener("click", () => $modal.close());
  $modal.querySelector("#meal-close").addEventListener("click", () => $modal.close());

  if (d.analyzing) {
    const box = $modal.querySelector("#analysis");
    const fd = new FormData();
    fd.set("photo", d.photo, "meal.jpg");
    api("/analyze", { method: "POST", form: fd }).then((r) => {
      if (!$modal.open) return;
      if (!r.is_food) {
        box.innerHTML = `<p class="eyebrow">AI 분석</p>음식이 보이지 않아요. 직접 입력해 주세요.`;
        return;
      }
      const found = r.items.length ? r.items : [{ name: r.food_name, calories_kcal: r.calories_kcal }];
      items = found.map((i) => editItem(i, true));
      renderItems();
      box.innerHTML = `<p class="eyebrow">AI 분석</p>${esc(r.description)}`;
    }).catch((e) => {
      if ($modal.open) box.innerHTML = `<p class="eyebrow">AI 분석</p><span class="error">${esc(e.message)}</span><br>음식 이름만 적으면 칼로리는 AI가 채워 드려요.`;
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $modal.querySelector("#meal-error");
    err.textContent = "";
    if (skipping()) {
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api(`/skips/${form.date.value}/${mealType}`, { method: "PUT" });
        $modal.close();
        state.date = form.date.value;
        state.viewUser = state.me;
        toast("안 먹은 끼니로 표시했어요");
        refresh({ silent: true });
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
      return;
    }
    if (pending.size) {
      err.textContent = "칼로리를 추정하고 있어요. 잠시만 기다려 주세요.";
      return;
    }
    // 이름·칼로리가 모두 빈 줄은 무시한다
    const filled = items.map((it, i) => ({ it, i })).filter(({ it }) => it.name.trim() || it.kcal !== "");
    let bad = false;
    for (const { it, i } of filled) {
      const row = $items.querySelector(`[data-i="${i}"]`);
      if (!it.name.trim()) {
        row.querySelector(".item-name").classList.add("invalid");
        bad = true;
      }
      const k = Number(it.kcal);
      if (it.kcal === "" || !Number.isFinite(k) || k < 0 || k > 10000) {
        row.querySelector(".item-kcal").classList.add("invalid");
        bad = true;
      }
    }
    if (!filled.length) {
      err.textContent = "음식을 하나 이상 입력해 주세요.";
      return;
    }
    if (bad) {
      err.textContent = "음식 이름과 칼로리(0~10,000)를 확인해 주세요.";
      return;
    }
    const payloadItems = filled.map(({ it }) => itemPayload(it));
    const recordedAt = new Date(`${form.date.value}T${form.time.value}`);
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      if (editing) {
        await api(`/meals/${meal.id}`, {
          method: "PATCH",
          json: { date: form.date.value, recorded_at: recordedAt.toISOString(), meal_type: mealType, items: payloadItems },
        });
      } else {
        const fd = new FormData();
        fd.set("date", form.date.value);
        fd.set("recorded_at", recordedAt.toISOString());
        fd.set("meal_type", mealType);
        fd.set("items", JSON.stringify(payloadItems));
        fd.set("ai_estimated", String(usesAi()));
        if (d.photo) fd.set("photo", d.photo, "meal.jpg");
        await api("/meals", { method: "POST", form: fd });
      }
      $modal.close();
      state.date = form.date.value;
      state.viewUser = state.me;
      toast("저장했어요");
      refresh({ silent: true });
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });

  $modal.querySelector("#meal-delete")?.addEventListener("click", async () => {
    if (!confirm("이 식사 기록을 삭제할까요?")) return;
    try {
      await api(`/meals/${meal.id}`, { method: "DELETE" });
      $modal.close();
      toast("삭제했어요");
      refresh({ silent: true });
    } catch (ex) {
      $modal.querySelector("#meal-error").textContent = ex.message;
    }
  });
}

// ---------- 달력 ----------

function renderCalendar() {
  const [y, m] = state.month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = ymd(new Date());
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(`<div class="cell out"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${state.month}-${pad(day)}`;
    const info = state.cal.days[date];
    const rows = !info ? "" : state.users.map((u) => {
      const s = info[u.user_key];
      const k = statusKey(s?.status);
      return `<span class="u"><span class="dot ${k ? `bg-${k}` : ""}"></span><span class="n ${s?.worked_out ? "worked" : ""}">${esc(u.name)}</span></span>`;
    }).join("");
    cells.push(`<button class="cell ${date === today ? "today" : ""}" data-date="${date}"><span class="d">${day}</span>${rows}</button>`);
  }

  $app.innerHTML = `
    <div class="cal-head">
      <button class="icon-btn" data-month="-1" aria-label="이전 달">${ICON.left}</button>
      <div class="center">
        <p class="eyebrow">${y}</p>
        <h1 class="h1">${m}월</h1>
      </div>
      <button class="icon-btn" data-month="1" aria-label="다음 달">${ICON.right}</button>
    </div>
    <div class="cal">
      ${WEEKDAYS.map((w) => `<div class="wd">${w}</div>`).join("")}
      ${cells.join("")}
    </div>
    <div class="legend">
      <span><span class="dot bg-good"></span>목표 110% 이하</span>
      <span><span class="dot bg-warn"></span>110~125%</span>
      <span><span class="dot bg-bad"></span>125% 초과</span>
      <span><span class="chip">이름</span>운동한 날</span>
    </div>
    <p class="small muted" style="margin-top:12px">날짜를 누르면 그날의 식사·운동 기록을 볼 수 있어요.</p>`;

  $app.querySelectorAll("[data-month]").forEach((b) => b.addEventListener("click", () => {
    const d = new Date(y, m - 1 + Number(b.dataset.month), 1);
    state.month = ymd(d).slice(0, 7);
    refresh();
  }));
  $app.querySelectorAll("[data-date]").forEach((b) => b.addEventListener("click", () => {
    state.date = b.dataset.date;
    go("day");
  }));
}

// ---------- 내 정보 ----------

function calcBmr(sex, age, h, w) {
  return Math.round(10 * w + 6.25 * h - 5 * age + (sex === "male" ? 5 : -161));
}

// 한국인 영양소 섭취기준의 성인 에너지 필요추정량 (서버 logic.ts와 같은 식)
const PA = {
  male: { sedentary: 1.0, low: 1.11, active: 1.25, very_active: 1.48 },
  female: { sedentary: 1.0, low: 1.12, active: 1.27, very_active: 1.45 },
};
function calcEer(sex, age, h, w, level) {
  const pa = PA[sex][level];
  const m = h / 100;
  return Math.round(sex === "male" ? 662 - 9.53 * age + pa * (15.91 * w + 539.6 * m) : 354 - 6.91 * age + pa * (9.36 * w + 726 * m));
}

function renderProfile() {
  const p = myProfile() || {};
  let sex = p.sex || "";
  let level = p.activity_level || "";
  // 예전(기초대사량 기준) 목표는 권장섭취량 기준으로 다시 잡는다
  let offset = p.activity_level ? p.goal_offset_kcal : 0;

  $app.innerHTML = `
    <p class="eyebrow">내 정보</p>
    <h1 class="h1">${esc(userName(state.me))}님의 목표</h1>
    <p class="lead">하루 목표는 권장섭취량을 기준으로 정해요.</p>

    <form id="profile-form" class="section" style="margin-top:32px">
      <div class="card">
        <div class="field">
          <span class="label">성별</span>
          <div class="pills fill" id="sex">
            <button type="button" class="pill ${sex === "female" ? "on" : ""}" data-sex="female">여성</button>
            <button type="button" class="pill ${sex === "male" ? "on" : ""}" data-sex="male">남성</button>
          </div>
        </div>
        <div class="grid-3">
          <label class="field"><span class="label">나이</span><input type="number" name="age" value="${esc(p.age)}" min="19" max="120" inputmode="numeric"></label>
          <label class="field"><span class="label">키 (cm)</span><input type="number" name="height_cm" value="${esc(p.height_cm)}" min="50" max="250" step="0.1" inputmode="decimal"></label>
          <label class="field"><span class="label">몸무게 (kg)</span><input type="number" name="weight_kg" value="${esc(p.weight_kg)}" min="20" max="300" step="0.1" inputmode="decimal"></label>
        </div>
        <div class="field" style="margin-bottom:0">
          <span class="label">평소 활동 수준</span>
          <div class="choices">${
    ACTIVITY.map(([k, t, desc]) => `<button type="button" class="choice ${k === level ? "on" : ""}" data-level="${k}"><b>${t}</b><span>${desc}</span></button>`).join("")
  }</div>
        </div>
      </div>

      <div class="card">
        <div class="stats">
          <div class="stat"><span class="num v" id="bmr">–</span><span class="k">기초대사량</span></div>
          <div class="stat"><span class="num v" id="eer">–</span><span class="k">권장섭취량</span></div>
          <div class="stat main"><span class="num v" id="target">–</span><span class="k">하루 목표</span></div>
        </div>
        <p class="small muted center" style="margin:12px 0 24px">kcal / 일</p>
        <div class="field">
          <span class="label">목표 조정 (kcal)</span>
          <div class="pills fill" id="presets">${GOAL_PRESETS.map(([v, l]) => `<button type="button" class="pill" data-offset="${v}">${l}</button>`).join("")}</div>
        </div>
        <label class="field" style="margin-bottom:0"><span class="label">권장섭취량에서 더하거나 뺄 칼로리 (kcal)</span>
          <input type="number" name="goal_offset_kcal" value="${esc(offset)}" min="-2000" max="2000" step="10" inputmode="numeric">
        </label>
        <p class="small muted" style="margin:16px 0 0">권장섭취량은 한국인 영양소 섭취기준의 에너지 필요추정량 공식으로 계산해요. 운동 소모 칼로리는 목표에 더하지 않아요.</p>
      </div>

      <p class="error small" id="profile-error" style="margin:16px 0 0"></p>
      <div class="btn-stack" style="margin-top:16px">
        <button class="btn primary block" type="submit">저장</button>
        <button class="btn outline block" type="button" id="logout">로그아웃</button>
      </div>
    </form>`;

  const form = $app.querySelector("#profile-form");
  const values = () => ({
    age: Number(form.age.value),
    h: Number(form.height_cm.value),
    w: Number(form.weight_kg.value),
    offset: Number(form.goal_offset_kcal.value) || 0,
  });
  const update = () => {
    const { age, h, w, offset: o } = values();
    const ok = sex && age && h && w;
    $app.querySelector("#bmr").textContent = ok ? fmtKcal(calcBmr(sex, age, h, w)) : "–";
    const eer = ok && level ? calcEer(sex, age, h, w, level) : null;
    $app.querySelector("#eer").textContent = eer ? fmtKcal(eer) : "–";
    $app.querySelector("#target").textContent = eer ? fmtKcal(Math.max(0, eer + o)) : "–";
    $app.querySelectorAll("[data-offset]").forEach((b) => b.classList.toggle("on", Number(b.dataset.offset) === o));
  };
  update();
  form.addEventListener("input", update);
  $app.querySelectorAll("[data-sex]").forEach((b) => b.addEventListener("click", () => {
    sex = b.dataset.sex;
    $app.querySelectorAll("[data-sex]").forEach((x) => x.classList.toggle("on", x === b));
    update();
  }));
  $app.querySelectorAll("[data-level]").forEach((b) => b.addEventListener("click", () => {
    level = b.dataset.level;
    $app.querySelectorAll("[data-level]").forEach((x) => x.classList.toggle("on", x === b));
    update();
  }));
  $app.querySelectorAll("[data-offset]").forEach((b) => b.addEventListener("click", () => {
    form.goal_offset_kcal.value = b.dataset.offset;
    update();
  }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $app.querySelector("#profile-error");
    const { age, h, w, offset: o } = values();
    if (!sex) return (err.textContent = "성별을 선택해 주세요.");
    if (!age || !h || !w) return (err.textContent = "나이·키·몸무게를 입력해 주세요.");
    if (!level) return (err.textContent = "평소 활동 수준을 선택해 주세요.");
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const { profile } = await api("/profile", {
        method: "PUT",
        json: { sex, age, height_cm: h, weight_kg: w, activity_level: level, goal_offset_kcal: o },
      });
      state.users.find((u) => u.user_key === state.me).profile = profile;
      toast(`저장했어요. 하루 목표 ${fmtKcal(profile.daily_target_kcal)} kcal`);
      err.textContent = "";
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });
  $app.querySelector("#logout").addEventListener("click", () => {
    if (confirm("로그아웃할까요?")) logout();
  });
}

// ---------- 시작 ----------

async function start() {
  if (!API) {
    $app.innerHTML = `<p class="eyebrow">Calorie Note</p><div class="card">
      <p style="margin-top:0">서버 주소가 설정되지 않았어요.</p>
      <p class="muted small" style="margin-bottom:0">GitHub 저장소 Settings → Secrets and variables → Actions → Variables에
      <code>SUPABASE_PROJECT_REF</code>를 추가한 뒤 Pages 배포를 다시 실행하세요. (README 참고)</p></div>`;
    return;
  }
  state.token = storage((s) => s.getItem(TOKEN_KEY));
  if (!state.token) return renderLogin();
  try {
    const me = await api("/me");
    state.me = me.user_key;
    state.users = me.users;
    state.viewUser = me.user_key;
    state.date = me.today || state.date;
    go(needsProfile() ? "profile" : "day");
  } catch (e) {
    if (state.token) $app.innerHTML = `<div class="card error">${esc(e.message)}</div>`;
  }
}

start();
