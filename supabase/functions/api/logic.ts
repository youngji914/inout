// 칼로리 계산·달력 색상·로그인 토큰 등 저장소와 무관한 순수 로직.

export type UserKey = "user1" | "user2";
export const USER_KEYS: UserKey[] = ["user1", "user2"];

export type Sex = "male" | "female";
export type Status = "green" | "orange" | "red";

/** Mifflin-St Jeor 공식으로 기초대사량(kcal/일)을 계산한다. */
export function calcBmr(sex: Sex, age: number, heightCm: number, weightKg: number): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(base + (sex === "male" ? 5 : -161));
}

// 달력 색상 구간: 섭취량 / 목표
//   목표의 110% 이하 → 초록, 125% 이하 → 주황, 그 이상 → 빨강
export const GREEN_MAX_RATIO = 1.1;
export const ORANGE_MAX_RATIO = 1.25;

export function dayStatus(totalKcal: number, targetKcal: number | null, mealCount: number): Status | null {
  if (mealCount === 0 || !targetKcal) return null;
  const ratio = totalKcal / targetKcal;
  if (ratio <= GREEN_MAX_RATIO) return "green";
  if (ratio <= ORANGE_MAX_RATIO) return "orange";
  return "red";
}

export interface TargetRow {
  user_key: string;
  effective_date: string;
  daily_target_kcal: number;
}

/**
 * 해당 날짜에 적용되던 목표 칼로리. 그 날짜 이전에 설정한 값 중 가장 최근 것을 쓰고,
 * 목표를 처음 설정하기 전 날짜에는 처음 설정한 값을 쓴다.
 */
export function targetOn(rows: TargetRow[], userKey: string, date: string): number | null {
  const mine = rows
    .filter((r) => r.user_key === userKey)
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  if (mine.length === 0) return null;
  let found = mine[0];
  for (const r of mine) {
    if (r.effective_date <= date) found = r;
  }
  return found.daily_target_kcal;
}

export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(now);
}

export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function isDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

export function isMonth(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

// ---- 로그인 토큰: "<user_key>.<만료 epoch초>.<HMAC-SHA256 서명>" ----

export const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(data));
}

/** 길이가 달라도 시간 차이로 내용이 새지 않게, 양쪽을 HMAC으로 고정 길이로 만든 뒤 비교한다. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const salt = crypto.randomUUID();
  const [x, y] = await Promise.all([hmac(salt, a), hmac(salt, b)]);
  const xa = new Uint8Array(x), ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

export async function signToken(
  secret: string,
  userKey: UserKey,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload = `${userKey}.${nowSec + TOKEN_TTL_SECONDS}`;
  return `${payload}.${base64url(await hmac(secret, payload))}`;
}

export async function verifyToken(
  secret: string,
  token: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<UserKey | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userKey, exp, sig] = parts;
  if (!USER_KEYS.includes(userKey as UserKey) || !/^\d+$/.test(exp) || Number(exp) < nowSec) return null;
  const expected = base64url(await hmac(secret, `${userKey}.${exp}`));
  return (await safeEqual(sig, expected)) ? userKey as UserKey : null;
}
