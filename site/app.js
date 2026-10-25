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
const MEAL_LABEL = Object.fromEntries(MEAL_TYPES);
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

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
    $app.innerHTML = `<h1>🍽️ 칼로리 노트</h1><div class="card error">${esc(e.message)}</div>`;
    return;
  }
  let selected = storage((s) => s.getItem("calorie-note-last-user")) || users[0].user_key;
  $app.innerHTML = `
    <h1>🍽️ 칼로리 노트</h1>
    <div class="card">
      <h2>누구세요?</h2>
      <div class="login-users">
        ${users.map((u) => `<button data-user="${u.user_key}">${esc(u.name)}</button>`).join("")}
      </div>
      <form id="login-form">
        <label class="field"><span>비밀번호</span><input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn primary block" type="submit">로그인</button>
        <p class="error small" id="login-error"></p>
      </form>
    </div>`;
  const mark = () => $app.querySelectorAll("[data-user]").forEach((b) => b.classList.toggle("selected", b.dataset.user === selected));
  mark();
  $app.querySelectorAll("[data-user]").forEach((b) => b.addEventListener("click", () => {
    selected = b.dataset.user;
    mark();
    $app.querySelector("input[name=password]").focus();
  }));
  $app.querySelector("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
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
      go(myProfile()?.daily_target_kcal ? "day" : "profile");
    } catch (err) {
      $app.querySelector("#login-error").textContent = err.message;
      btn.disabled = false;
    }
  });
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

function statusClass(status) {
  return status ? `s-${status}` : "";
}

function renderDay() {
  const d = state.day;
  const key = state.viewUser || state.me;
  const u = d.users[key];
  const mine = key === state.me;
  const total = u.total_kcal;
  const target = u.target_kcal;

  let summary;
  if (target) {
    const diff = target - total;
    const pct = Math.min(100, Math.round((total / target) * 100));
    summary = `
      <div class="nums"><span class="big">${fmtKcal(total)}</span><span class="muted">/ ${fmtKcal(target)} kcal</span></div>
      <div class="meter"><div class="${statusClass(u.status)}" style="width:${pct}%"></div></div>
      <div class="${u.status ? `t-${u.status}` : "muted"}">${
      diff >= 0 ? `${fmtKcal(diff)} kcal 남음` : `${fmtKcal(-diff)} kcal 초과`
    }</div>`;
  } else {
    summary = `
      <div class="nums"><span class="big">${fmtKcal(total)}</span><span class="muted">kcal</span></div>
      <p class="muted small">${mine ? `목표가 아직 없어요. <a href="#" data-go="profile">내 정보</a>에서 설정하세요.` : "아직 목표를 설정하지 않았어요."}</p>`;
  }

  const groups = MEAL_TYPES.map(([type, label]) => {
    const meals = u.meals.filter((m) => m.meal_type === type);
    if (!meals.length && type === "snack") return "";
    const sum = meals.reduce((s, m) => s + m.calories_kcal, 0);
    return `
      <div class="meal-group">
        <h3><span>${label}</span><span class="muted">${meals.length ? `${fmtKcal(sum)} kcal` : ""}</span></h3>
        ${
      meals.length
        ? meals.map((m) => `
          <button class="meal" data-meal="${m.id}">
            ${m.photo_url ? `<img src="${esc(m.photo_url)}" alt="" loading="lazy">` : `<span class="ph">🍽️</span>`}
            <span class="info">
              <span class="name">${esc(m.food_name)}</span>
              <span class="muted small">${hm(new Date(m.recorded_at))}${m.ai_estimated ? `<span class="badge">AI 추정</span>` : ""}</span>
            </span>
            <span class="kcal">${fmtKcal(m.calories_kcal)} kcal</span>
          </button>`).join("")
        : `<p class="muted small" style="margin:4px 0 8px">기록 없음</p>`
    }
      </div>`;
  }).join("");

  const photos = u.workout_photos.map((p) => `
    <div class="p">
      ${p.photo_url ? `<img src="${esc(p.photo_url)}" alt="운동 사진" data-zoom loading="lazy">` : ""}
      ${mine ? `<button class="del" data-del-photo="${p.id}" aria-label="사진 삭제">✕</button>` : ""}
    </div>`).join("");

  $app.innerHTML = `
    <div class="date-nav">
      <button data-shift="-1" aria-label="전날">‹</button>
      <span class="title">${fmtDate(d.date)}${d.date === ymd(new Date()) ? " · 오늘" : ""}<input type="date" value="${d.date}" aria-label="날짜 선택"></span>
      <button data-shift="1" aria-label="다음날">›</button>
    </div>
    <div class="user-tabs">
      ${state.users.map((x) => `<button data-user="${x.user_key}" class="${x.user_key === key ? "on" : ""}">${esc(x.name)}</button>`).join("")}
    </div>
    <div class="card summary">${summary}</div>
    <div class="card">
      ${groups}
      ${
    mine
      ? `<div class="add-row">
             <button class="btn primary" data-add="photo">📷 사진으로 기록</button>
             <button class="btn" data-add="manual">✏️ 직접 입력</button>
           </div>`
      : ""
  }
    </div>
    <div class="card">
      <div class="workout-head">
        <h2 style="margin:0">💪 운동</h2>
        ${
    mine
      ? `<label class="switch"><input type="checkbox" id="workout-toggle" ${u.worked_out ? "checked" : ""}><span></span></label>`
      : `<span class="${u.worked_out ? "t-green" : "muted"}">${u.worked_out ? "운동했어요" : "기록 없음"}</span>`
  }
      </div>
      ${photos ? `<div class="photos">${photos}</div>` : ""}
      ${mine ? `<button class="btn block" style="margin-top:12px" data-add="workout">+ 운동 사진 올리기</button>` : ""}
    </div>`;

  $app.querySelectorAll("[data-shift]").forEach((b) => b.addEventListener("click", () => {
    state.date = addDays(state.date, Number(b.dataset.shift));
    refresh();
  }));
  $app.querySelector(".date-nav input").addEventListener("change", (e) => {
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
  $app.querySelector("[data-add=photo]")?.addEventListener("click", addMealFromPhoto);
  $app.querySelector("[data-add=manual]")?.addEventListener("click", () => {
    const now = new Date();
    const at = state.date === ymd(now) ? now : new Date(`${state.date}T12:00`);
    openMealEditor({ draft: { date: state.date, time: hm(at), meal_type: guessMealType(at) } });
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

function zoom(src) {
  $lightbox.querySelector("img").src = src;
  $lightbox.showModal();
}
$lightbox.addEventListener("click", () => $lightbox.close());

async function toggleWorkout(input) {
  const on = input.checked;
  if (!on && state.day.users[state.me].workout_photos.length && !confirm("운동 체크를 끄면 이 날의 운동 사진도 삭제됩니다. 계속할까요?")) {
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
  const where = [...dates].sort().map(fmtDate).join(", ");
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

function openMealEditor({ meal, draft }) {
  const editing = !!meal;
  const d = editing
    ? {
      date: meal.date,
      time: hm(new Date(meal.recorded_at)),
      meal_type: meal.meal_type,
      food_name: meal.food_name,
      calories_kcal: meal.calories_kcal,
      photo_url: meal.photo_url,
      ai_estimated: meal.ai_estimated,
    }
    : { food_name: "", calories_kcal: "", ...draft };
  let aiCalories = null;
  const previewUrl = d.photo ? URL.createObjectURL(d.photo) : d.photo_url;

  $modal.innerHTML = `
    <div class="inner">
      <h2>${editing ? "식사 기록 수정" : "식사 기록"}</h2>
      ${previewUrl ? `<img class="preview" src="${esc(previewUrl)}" alt="">` : ""}
      <div class="analysis" id="analysis" ${d.analyzing ? "" : "hidden"}><span class="spinner"></span>사진을 분석하고 있어요…</div>
      <form id="meal-form">
        <div class="row">
          <label class="field"><span>날짜</span><input type="date" name="date" value="${d.date}" required></label>
          <label class="field"><span>시간</span><input type="time" name="time" value="${d.time}" required></label>
        </div>
        <label class="field"><span>끼니</span>
          <div class="seg" id="meal-type">${MEAL_TYPES.map(([t, l]) => `<button type="button" data-t="${t}" class="${t === d.meal_type ? "on" : ""}">${l}</button>`).join("")}</div>
        </label>
        <label class="field"><span>음식</span><input type="text" name="food_name" value="${esc(d.food_name)}" maxlength="100" required placeholder="예: 김치찌개, 공기밥"></label>
        <label class="field"><span>칼로리 (kcal)</span><input type="number" name="calories_kcal" value="${esc(d.calories_kcal)}" min="0" max="20000" step="1" inputmode="numeric" required></label>
        <p class="estimate-note" id="estimate-note" ${d.ai_estimated ? "" : "hidden"}>⚠️ AI가 사진으로 추정한 값이에요. 실제와 다를 수 있으니 확인 후 수정하세요.</p>
        <div class="row">
          ${editing ? `<button type="button" class="btn danger" id="meal-delete">삭제</button>` : ""}
          <button type="button" class="btn" id="meal-cancel">취소</button>
          <button type="submit" class="btn primary">저장</button>
        </div>
        <p class="error small" id="meal-error"></p>
      </form>
    </div>`;
  $modal.showModal();

  const form = $modal.querySelector("#meal-form");
  let mealType = d.meal_type;
  $modal.querySelectorAll("#meal-type button").forEach((b) => b.addEventListener("click", () => {
    mealType = b.dataset.t;
    $modal.querySelectorAll("#meal-type button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $modal.querySelector("#meal-cancel").addEventListener("click", () => $modal.close());

  if (d.analyzing) {
    const box = $modal.querySelector("#analysis");
    const fd = new FormData();
    fd.set("photo", d.photo, "meal.jpg");
    api("/analyze", { method: "POST", form: fd }).then((r) => {
      if (!$modal.open) return;
      if (!r.is_food) {
        box.innerHTML = `🤔 음식이 보이지 않아요. 직접 입력해 주세요.`;
        return;
      }
      form.food_name.value = r.food_name;
      form.calories_kcal.value = r.calories_kcal;
      aiCalories = r.calories_kcal;
      $modal.querySelector("#estimate-note").hidden = false;
      box.innerHTML = `<b>${esc(r.food_name)}</b> · 약 ${fmtKcal(r.calories_kcal)} kcal
        ${r.items.length > 1 ? `<ul>${r.items.map((i) => `<li>${esc(i.name)} ${fmtKcal(i.calories_kcal)} kcal</li>`).join("")}</ul>` : ""}
        <div class="muted small" style="margin-top:4px">${esc(r.description)}</div>`;
    }).catch((e) => {
      if ($modal.open) box.innerHTML = `<span class="error">분석 실패: ${esc(e.message)}</span><br>음식과 칼로리를 직접 입력해 주세요.`;
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    const err = $modal.querySelector("#meal-error");
    const recordedAt = new Date(`${form.date.value}T${form.time.value}`);
    const calories = Math.round(Number(form.calories_kcal.value));
    btn.disabled = true;
    err.textContent = "";
    try {
      if (editing) {
        await api(`/meals/${meal.id}`, {
          method: "PATCH",
          json: {
            date: form.date.value,
            recorded_at: recordedAt.toISOString(),
            meal_type: mealType,
            food_name: form.food_name.value,
            calories_kcal: calories,
          },
        });
      } else {
        const fd = new FormData();
        fd.set("date", form.date.value);
        fd.set("recorded_at", recordedAt.toISOString());
        fd.set("meal_type", mealType);
        fd.set("food_name", form.food_name.value);
        fd.set("calories_kcal", String(calories));
        fd.set("ai_estimated", String(aiCalories !== null && aiCalories === calories));
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
      const s = info?.[u.user_key];
      return `<span class="u"><span class="dot ${statusClass(s?.status)}"></span>${esc(u.name.slice(0, 1))}${
        s?.worked_out ? `<span class="gym">💪</span>` : ""
      }</span>`;
    }).join("");
    cells.push(`<button class="cell ${date === today ? "today" : ""}" data-date="${date}"><span class="d">${day}</span>${rows}</button>`);
  }

  $app.innerHTML = `
    <div class="cal-head">
      <button data-month="-1" aria-label="이전 달">‹</button>
      <span class="title">${y}년 ${m}월</span>
      <button data-month="1" aria-label="다음 달">›</button>
    </div>
    <div class="cal">
      ${WEEKDAYS.map((w) => `<div class="wd">${w}</div>`).join("")}
      ${cells.join("")}
    </div>
    <div class="legend">
      <span><span class="dot s-green"></span>목표 110% 이하</span>
      <span><span class="dot s-orange"></span>110~125%</span>
      <span><span class="dot s-red"></span>125% 초과</span>
      <span>💪 운동한 날</span>
    </div>
    <p class="muted small">날짜를 누르면 그날의 식사·운동 기록을 볼 수 있어요.</p>`;

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

function renderProfile() {
  const p = myProfile() || {};
  let sex = p.sex || "";
  $app.innerHTML = `
    <h1>${esc(userName(state.me))}님의 정보</h1>
    <form class="card" id="profile-form">
      <label class="field"><span>성별</span>
        <div class="seg" id="sex">
          <button type="button" data-sex="female" class="${sex === "female" ? "on" : ""}">여성</button>
          <button type="button" data-sex="male" class="${sex === "male" ? "on" : ""}">남성</button>
        </div>
      </label>
      <div class="row">
        <label class="field"><span>나이</span><input type="number" name="age" value="${esc(p.age)}" min="10" max="120" inputmode="numeric" required></label>
        <label class="field"><span>키 (cm)</span><input type="number" name="height_cm" value="${esc(p.height_cm)}" min="50" max="250" step="0.1" inputmode="decimal" required></label>
        <label class="field"><span>몸무게 (kg)</span><input type="number" name="weight_kg" value="${esc(p.weight_kg)}" min="20" max="300" step="0.1" inputmode="decimal" required></label>
      </div>
      <label class="field"><span>목표: 기초대사량 대비 (kcal)</span>
        <input type="number" name="goal_offset_kcal" value="${esc(p.goal_offset_kcal ?? -500)}" min="-2000" max="2000" step="10" inputmode="numeric" required>
        <div class="chips">${[-700, -500, -300, 0, 200].map((v) => `<button type="button" data-offset="${v}">${v > 0 ? "+" : ""}${v}</button>`).join("")}</div>
      </label>
      <div class="calc">
        <div><span class="muted small">기초대사량</span><b id="bmr">-</b></div>
        <div><span class="muted small">하루 목표</span><b id="target">-</b></div>
      </div>
      <p class="muted small">기초대사량은 Mifflin-St Jeor 공식으로 계산합니다. 운동 소모 칼로리는 목표에 더하지 않습니다.</p>
      <button class="btn primary block" type="submit">저장</button>
      <p class="error small" id="profile-error"></p>
    </form>
    <button class="btn block" id="logout">로그아웃</button>`;

  const form = $app.querySelector("#profile-form");
  const update = () => {
    const age = Number(form.age.value), h = Number(form.height_cm.value), w = Number(form.weight_kg.value);
    const offset = Number(form.goal_offset_kcal.value);
    const ok = sex && age && h && w;
    const bmr = ok ? calcBmr(sex, age, h, w) : null;
    $app.querySelector("#bmr").textContent = bmr ? `${fmtKcal(bmr)} kcal` : "-";
    $app.querySelector("#target").textContent = bmr ? `${fmtKcal(Math.max(0, bmr + offset))} kcal` : "-";
    $app.querySelectorAll("[data-offset]").forEach((b) => b.classList.toggle("on", Number(b.dataset.offset) === offset));
  };
  update();
  form.addEventListener("input", update);
  $app.querySelectorAll("[data-sex]").forEach((b) => b.addEventListener("click", () => {
    sex = b.dataset.sex;
    $app.querySelectorAll("[data-sex]").forEach((x) => x.classList.toggle("on", x === b));
    update();
  }));
  $app.querySelectorAll("[data-offset]").forEach((b) => b.addEventListener("click", () => {
    form.goal_offset_kcal.value = b.dataset.offset;
    update();
  }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $app.querySelector("#profile-error");
    if (!sex) {
      err.textContent = "성별을 선택해 주세요.";
      return;
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const { profile } = await api("/profile", {
        method: "PUT",
        json: {
          sex,
          age: Number(form.age.value),
          height_cm: Number(form.height_cm.value),
          weight_kg: Number(form.weight_kg.value),
          goal_offset_kcal: Number(form.goal_offset_kcal.value),
        },
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
    $app.innerHTML = `<h1>🍽️ 칼로리 노트</h1><div class="card">
      <p>서버 주소가 설정되지 않았어요.</p>
      <p class="muted small">GitHub 저장소 Settings → Secrets and variables → Actions → Variables에
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
    go(myProfile()?.daily_target_kcal ? "day" : "profile");
  } catch (e) {
    if (state.token) $app.innerHTML = `<div class="card error">${esc(e.message)}</div>`;
  }
}

start();
