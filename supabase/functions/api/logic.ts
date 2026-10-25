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

export type ActivityLevel = "sedentary" | "low" | "active" | "very_active";
export const ACTIVITY_LEVELS: ActivityLevel[] = ["sedentary", "low", "active", "very_active"];

// 한국인 영양소 섭취기준(2020)의 성인 에너지 필요추정량 신체활동계수
const PA: Record<Sex, Record<ActivityLevel, number>> = {
  male: { sedentary: 1.0, low: 1.11, active: 1.25, very_active: 1.48 },
  female: { sedentary: 1.0, low: 1.12, active: 1.27, very_active: 1.45 },
};

/** 권장섭취량: 한국인 영양소 섭취기준의 성인 에너지 필요추정량(kcal/일). */
export function calcEer(sex: Sex, age: number, heightCm: number, weightKg: number, level: ActivityLevel): number {
  const h = heightCm / 100;
  const pa = PA[sex][level];
  const eer = sex === "male"
    ? 662 - 9.53 * age + pa * (15.91 * weightKg + 539.6 * h)
    : 354 - 6.91 * age + pa * (9.36 * weightKg + 726 * h);
  return Math.round(eer);
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

// ---- 하루 영양 피드백 ----

export interface Macros {
  carbs_g: number;
  protein_g: number;
  fat_g: number;
}

export interface Feedback {
  level: "good" | "warn" | "info";
  text: string;
}

// 한국인 영양소 섭취기준의 에너지 적정비율: 탄수화물 55~65%, 지방 15~30%.
// 단백질은 기준 하한(7%)이 다이어트에는 너무 낮아 15%를 하한으로 쓴다.
export const CARB_MAX_PCT = 65;
export const CARB_MIN_PCT = 45;
export const PROTEIN_MIN_PCT = 15;
export const FAT_MAX_PCT = 30;

/** 탄단지가 칼로리에서 차지하는 비율(%). 영양 정보가 없으면 null. */
export function macroPercents(m: Macros): Macros | null {
  const kcal = m.carbs_g * 4 + m.protein_g * 4 + m.fat_g * 9;
  if (kcal <= 0) return null;
  return {
    carbs_g: Math.round((m.carbs_g * 4 / kcal) * 100),
    protein_g: Math.round((m.protein_g * 4 / kcal) * 100),
    fat_g: Math.round((m.fat_g * 9 / kcal) * 100),
  };
}

export function dayFeedback(input: {
  mealCount: number;
  totalKcal: number;
  targetKcal: number | null;
  macros: Macros;
  /** 탄단지 정보가 있는 음식의 칼로리 합 */
  macroKcal: number;
  /** 이미 지난 날짜인지 (적게 먹은 날 안내용) */
  isPast: boolean;
}): Feedback[] {
  const { mealCount, totalKcal, targetKcal, macros, macroKcal, isPast } = input;
  if (mealCount === 0) return [];
  const out: Feedback[] = [];

  if (targetKcal) {
    const ratio = totalKcal / targetKcal;
    if (ratio > 1.1) {
      out.push({
        level: "warn",
        text: `목표보다 ${
          (totalKcal - targetKcal).toLocaleString("ko-KR")
        } kcal 더 먹었어요. 다음 끼니는 가볍게 드세요.`,
      });
    } else if (isPast && ratio < 0.7) {
      out.push({ level: "info", text: "목표보다 많이 적게 먹었어요. 너무 적게 먹으면 요요가 오기 쉬워요." });
    }
  }

  const pct = macroPercents(macros);
  if (pct) {
    if (pct.carbs_g > CARB_MAX_PCT) {
      out.push({
        level: "warn",
        text: `탄수화물 비중이 높아요 (${pct.carbs_g}%). 밥·면·빵을 조금 줄이고 단백질 반찬을 늘려 보세요.`,
      });
    } else if (pct.carbs_g < CARB_MIN_PCT) {
      out.push({ level: "info", text: `탄수화물이 적은 편이에요 (${pct.carbs_g}%). 너무 줄이면 쉽게 지칠 수 있어요.` });
    }
    if (pct.protein_g < PROTEIN_MIN_PCT) {
      out.push({
        level: "warn",
        text: `단백질이 부족해요 (${pct.protein_g}%). 달걀·두부·닭가슴살·생선을 곁들여 보세요.`,
      });
    }
    if (pct.fat_g > FAT_MAX_PCT) {
      out.push({
        level: "warn",
        text: `지방 비중이 높아요 (${pct.fat_g}%). 튀김·볶음보다 굽거나 찐 요리를 골라 보세요.`,
      });
    }
    if (!out.some((f) => f.level === "warn")) {
      out.push({ level: "good", text: "탄수화물·단백질·지방 균형이 좋아요. 이대로 유지해요." });
    }
    if (totalKcal > 0 && macroKcal / totalKcal < 0.5) {
      out.push({ level: "info", text: "영양 정보가 없는 음식이 많아 비율이 정확하지 않을 수 있어요." });
    }
  } else {
    out.push({
      level: "info",
      text: "영양 정보가 있는 음식이 없어요. 사진으로 기록하거나 칼로리를 AI로 채우면 탄단지를 알려 드려요.",
    });
  }
  return out;
}
