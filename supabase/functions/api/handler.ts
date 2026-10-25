// HTTP 라우팅·인증·입력 검증. 저장소(Store)와 음식 AI(FoodAi)는 주입받는다.

import type { FoodAi } from "./analyze.ts";
import { HttpError } from "./http.ts";
import {
  ACTIVITY_LEVELS,
  type ActivityLevel,
  calcBmr,
  calcEer,
  dayFeedback,
  dayStatus,
  isDate,
  isMonth,
  type Macros,
  monthRange,
  safeEqual,
  signToken,
  targetOn,
  todayIn,
  USER_KEYS,
  type UserKey,
  verifyToken,
} from "./logic.ts";
import type { Meal, MealItem, MealPatch, MealType, Profile, Store } from "./store.ts";

export interface Config {
  users: Record<UserKey, { name: string; password: string | undefined }>;
  sessionSecret: string | undefined;
  timeZone: string;
}

export function configFromEnv(): Config {
  const env = (k: string) => Deno.env.get(k) || undefined;
  return {
    users: {
      user1: { name: env("USER1_NAME") ?? "영지", password: env("USER1_PASSWORD") },
      user2: { name: env("USER2_NAME") ?? "신혁", password: env("USER2_PASSWORD") },
    },
    sessionSecret: env("SESSION_SECRET"),
    timeZone: env("APP_TIMEZONE") ?? "Asia/Seoul",
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-app-token, authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
};

const MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner", "snack"];
const PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch { /* fall through */ }
  throw new HttpError(400, "요청 형식이 올바르지 않습니다.");
}

async function readForm(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    throw new HttpError(400, "요청 형식이 올바르지 않습니다.");
  }
}

async function readPhoto(form: FormData, required: boolean): Promise<{ data: Uint8Array; type: string } | null> {
  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    if (required) throw new HttpError(400, "사진이 없습니다.");
    return null;
  }
  if (!PHOTO_TYPES[file.type]) throw new HttpError(415, "JPEG, PNG, WEBP, GIF 사진만 올릴 수 있습니다.");
  if (file.size > MAX_PHOTO_BYTES) throw new HttpError(413, "사진은 5MB 이하만 올릴 수 있습니다.");
  return { data: new Uint8Array(await file.arrayBuffer()), type: file.type };
}

function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} 값이 올바르지 않습니다 (${min}~${max}).`);
  }
  return n;
}

function num(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `${field} 값이 올바르지 않습니다 (${min}~${max}).`);
  }
  return Math.round(n * 10) / 10;
}

function dateField(v: unknown): string {
  if (!isDate(v)) throw new HttpError(400, "날짜 형식이 올바르지 않습니다.");
  return v;
}

function timestampField(v: unknown): string {
  const d = typeof v === "string" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new HttpError(400, "시각 형식이 올바르지 않습니다.");
  return d.toISOString();
}

function mealTypeField(v: unknown): MealType {
  if (!MEAL_TYPES.includes(v as MealType)) throw new HttpError(400, "끼니 값이 올바르지 않습니다.");
  return v as MealType;
}

const MAX_ITEMS = 20;

/** 음식 항목 목록을 검증하고, 목록용 이름(food_name)과 합계(calories_kcal)를 함께 만든다. */
function itemsField(v: unknown): Pick<Meal, "items" | "food_name" | "calories_kcal"> {
  let raw = v;
  if (typeof v === "string") {
    try {
      raw = JSON.parse(v);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) {
    throw new HttpError(400, `음식을 1~${MAX_ITEMS}개 입력해 주세요.`);
  }
  const items: MealItem[] = raw.map((it) => {
    const name = typeof it?.name === "string" ? it.name.trim() : "";
    if (!name || name.length > 50) throw new HttpError(400, "음식 이름을 1~50자로 입력해 주세요.");
    const item: MealItem = { name, calories_kcal: int(it.calories_kcal, `${name} 칼로리`, 0, 10000) };
    if (["carbs_g", "protein_g", "fat_g"].every((k) => it[k] !== undefined && it[k] !== null)) {
      item.carbs_g = num(it.carbs_g, `${name} 탄수화물`, 0, 2000);
      item.protein_g = num(it.protein_g, `${name} 단백질`, 0, 2000);
      item.fat_g = num(it.fat_g, `${name} 지방`, 0, 2000);
    }
    return item;
  });
  const joined = items.map((i) => i.name).join(", ");
  return {
    items,
    food_name: joined.length > 100 ? `${joined.slice(0, 99)}…` : joined,
    calories_kcal: items.reduce((sum, i) => sum + i.calories_kcal, 0),
  };
}

/** 하루 식사들의 탄단지 합계와, 탄단지 정보가 있는 음식의 칼로리 합. */
function nutrition(meals: Meal[]): { macros: Macros; macroKcal: number } {
  const macros: Macros = { carbs_g: 0, protein_g: 0, fat_g: 0 };
  let macroKcal = 0;
  for (const item of meals.flatMap((m) => m.items ?? [])) {
    if (item.carbs_g === undefined || item.protein_g === undefined || item.fat_g === undefined) continue;
    macros.carbs_g += item.carbs_g;
    macros.protein_g += item.protein_g;
    macros.fat_g += item.fat_g;
    macroKcal += item.calories_kcal;
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  return { macros: { carbs_g: r(macros.carbs_g), protein_g: r(macros.protein_g), fat_g: r(macros.fat_g) }, macroKcal };
}

/** 항목 없이 저장된 예전 기록은 하나짜리 목록으로 보여 준다. */
function withItems(m: Meal): Meal {
  return m.items?.length ? m : { ...m, items: [{ name: m.food_name, calories_kcal: m.calories_kcal }] };
}

export function createHandler(store: Store, ai: FoodAi, config: Config) {
  function photoPath(userKey: UserKey, kind: "meals" | "workouts", type: string) {
    return `${userKey}/${kind}/${crypto.randomUUID()}.${PHOTO_TYPES[type]}`;
  }

  async function authenticate(req: Request): Promise<UserKey> {
    if (!config.sessionSecret) throw new HttpError(500, "서버에 SESSION_SECRET이 설정되지 않았습니다.");
    const token = req.headers.get("x-app-token") ?? "";
    const userKey = token && await verifyToken(config.sessionSecret, token);
    if (!userKey) throw new HttpError(401, "다시 로그인해 주세요.");
    return userKey;
  }

  function usersPayload(profiles: Profile[]) {
    return USER_KEYS.map((k) => ({
      user_key: k,
      name: config.users[k].name,
      profile: profiles.find((p) => p.user_key === k) ?? null,
    }));
  }

  async function login(req: Request) {
    const body = await readJson(req);
    const userKey = body.user_key as UserKey;
    if (!USER_KEYS.includes(userKey)) throw new HttpError(400, "사용자를 선택해 주세요.");
    const expected = config.users[userKey].password;
    if (!expected || !config.sessionSecret) {
      throw new HttpError(
        500,
        "서버에 비밀번호(USER1_PASSWORD/USER2_PASSWORD)나 SESSION_SECRET이 설정되지 않았습니다.",
      );
    }
    const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();
    if (await store.countLoginFailures(userKey, since) >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, "로그인 실패가 많아 잠시 막혔습니다. 15분 뒤에 다시 시도해 주세요.");
    }
    if (!(await safeEqual(String(body.password ?? ""), expected))) {
      await store.addLoginFailure(userKey);
      throw new HttpError(401, "비밀번호가 틀렸습니다.");
    }
    return json({
      token: await signToken(config.sessionSecret, userKey),
      user_key: userKey,
      users: usersPayload(await store.getProfiles()),
    });
  }

  async function me(userKey: UserKey) {
    return json({ user_key: userKey, today: todayIn(config.timeZone), users: usersPayload(await store.getProfiles()) });
  }

  async function updateProfile(req: Request, userKey: UserKey) {
    const body = await readJson(req);
    const sex = body.sex;
    if (sex !== "male" && sex !== "female") throw new HttpError(400, "성별을 선택해 주세요.");
    const age = int(body.age, "나이", 10, 120);
    const height = num(body.height_cm, "키", 50, 250);
    const weight = num(body.weight_kg, "몸무게", 20, 300);
    const level = body.activity_level as ActivityLevel;
    if (!ACTIVITY_LEVELS.includes(level)) throw new HttpError(400, "활동 수준을 선택해 주세요.");
    const offset = int(body.goal_offset_kcal, "목표", -2000, 2000);
    const bmr = calcBmr(sex, age, height, weight);
    const eer = calcEer(sex, age, height, weight, level);
    const target = Math.max(eer + offset, 0);
    const profile: Profile = {
      user_key: userKey,
      sex,
      age,
      height_cm: height,
      weight_kg: weight,
      activity_level: level,
      bmr_kcal: bmr,
      eer_kcal: eer,
      goal_offset_kcal: offset,
      daily_target_kcal: target,
    };
    await store.updateProfile(profile);
    await store.upsertTarget({
      user_key: userKey,
      effective_date: todayIn(config.timeZone),
      daily_target_kcal: target,
    });
    return json({ profile });
  }

  async function analyzePhoto(req: Request) {
    const photo = (await readPhoto(await readForm(req), true))!;
    return json(await ai.analyzePhoto(photo.data, photo.type));
  }

  async function estimate(req: Request) {
    const body = await readJson(req);
    const names = Array.isArray(body.names) ? body.names.map((n) => (typeof n === "string" ? n.trim() : "")) : [];
    if (names.length === 0 || names.length > MAX_ITEMS || names.some((n) => !n || n.length > 50)) {
      throw new HttpError(400, `음식 이름을 1~${MAX_ITEMS}개, 각각 1~50자로 보내 주세요.`);
    }
    return json({ items: await ai.estimate(names) });
  }

  async function day(url: URL) {
    const date = dateField(url.searchParams.get("date"));
    const [meals, workouts, photos, targets] = await Promise.all([
      store.listMeals(date, date),
      store.listWorkouts(date, date),
      store.listWorkoutPhotos(date, date),
      store.getTargets(),
    ]);
    const urls = await store.signPhotoUrls([
      ...meals.flatMap((m) => (m.photo_path ? [m.photo_path] : [])),
      ...photos.map((p) => p.photo_path),
    ]);

    const users = Object.fromEntries(USER_KEYS.map((k) => {
      const mine = meals.filter((m) => m.user_key === k);
      const total = mine.reduce((s, m) => s + m.calories_kcal, 0);
      const target = targetOn(targets, k, date);
      const { macros, macroKcal } = nutrition(mine);
      return [k, {
        name: config.users[k].name,
        total_kcal: total,
        target_kcal: target,
        status: dayStatus(total, target, mine.length),
        macros,
        feedback: dayFeedback({
          mealCount: mine.length,
          totalKcal: total,
          targetKcal: target,
          macros,
          macroKcal,
          isPast: date < todayIn(config.timeZone),
        }),
        meals: mine.map((meal) => {
          const { photo_path, ...m } = withItems(meal);
          return { ...m, photo_url: photo_path ? urls[photo_path] ?? null : null };
        }),
        worked_out: workouts.some((w) => w.user_key === k),
        workout_photos: photos.filter((p) => p.user_key === k).map((p) => ({
          id: p.id,
          recorded_at: p.recorded_at,
          photo_url: urls[p.photo_path] ?? null,
        })),
      }];
    }));
    return json({ date, users });
  }

  async function calendar(url: URL) {
    const month = url.searchParams.get("month");
    if (!isMonth(month)) throw new HttpError(400, "월 형식이 올바르지 않습니다 (YYYY-MM).");
    const { from, to } = monthRange(month);
    const [meals, workouts, targets] = await Promise.all([
      store.listMeals(from, to),
      store.listWorkouts(from, to),
      store.getTargets(),
    ]);

    const dates = new Set([...meals.map((m) => m.date), ...workouts.map((w) => w.date)]);
    const days: Record<string, unknown> = {};
    for (const date of [...dates].sort()) {
      days[date] = Object.fromEntries(USER_KEYS.map((k) => {
        const mine = meals.filter((m) => m.user_key === k && m.date === date);
        const total = mine.reduce((s, m) => s + m.calories_kcal, 0);
        const target = targetOn(targets, k, date);
        return [k, {
          total_kcal: total,
          target_kcal: target,
          status: dayStatus(total, target, mine.length),
          worked_out: workouts.some((w) => w.user_key === k && w.date === date),
        }];
      }));
    }
    return json({ month, days });
  }

  async function createMeal(req: Request, userKey: UserKey) {
    const form = await readForm(req);
    const photo = await readPhoto(form, false);
    const fields = {
      user_key: userKey,
      recorded_at: timestampField(form.get("recorded_at")),
      date: dateField(form.get("date")),
      meal_type: mealTypeField(form.get("meal_type")),
      ...itemsField(form.get("items")),
      ai_estimated: form.get("ai_estimated") === "true",
    };
    let path: string | null = null;
    if (photo) {
      path = photoPath(userKey, "meals", photo.type);
      await store.uploadPhoto(path, photo.data, photo.type);
    }
    try {
      return json({ meal: await store.insertMeal({ ...fields, photo_path: path }) }, 201);
    } catch (e) {
      if (path) await store.removePhotos([path]).catch(() => {});
      throw e;
    }
  }

  async function ownMeal(id: string, userKey: UserKey): Promise<Meal> {
    const meal = await store.getMeal(id);
    if (!meal) throw new HttpError(404, "기록을 찾을 수 없습니다.");
    if (meal.user_key !== userKey) throw new HttpError(403, "다른 사람의 기록은 수정할 수 없습니다.");
    return meal;
  }

  async function patchMeal(req: Request, id: string, userKey: UserKey) {
    await ownMeal(id, userKey);
    const body = await readJson(req);
    const patch: MealPatch = {};
    if ("recorded_at" in body) patch.recorded_at = timestampField(body.recorded_at);
    if ("date" in body) patch.date = dateField(body.date);
    if ("meal_type" in body) patch.meal_type = mealTypeField(body.meal_type);
    if ("items" in body) Object.assign(patch, itemsField(body.items));
    return json({ meal: await store.updateMeal(id, patch) });
  }

  async function deleteMeal(id: string, userKey: UserKey) {
    const meal = await ownMeal(id, userKey);
    await store.deleteMeal(id);
    if (meal.photo_path) await store.removePhotos([meal.photo_path]);
    return json({ ok: true });
  }

  async function setWorkout(date: string, userKey: UserKey, on: boolean) {
    dateField(date);
    if (!on) {
      const photos = (await store.listWorkoutPhotos(date, date)).filter((p) => p.user_key === userKey);
      await store.setWorkout(userKey, date, false);
      await store.removePhotos(photos.map((p) => p.photo_path));
    } else {
      await store.setWorkout(userKey, date, true);
    }
    return json({ ok: true });
  }

  async function addWorkoutPhoto(req: Request, userKey: UserKey) {
    const form = await readForm(req);
    const photo = (await readPhoto(form, true))!;
    const date = dateField(form.get("date"));
    const recordedAt = timestampField(form.get("recorded_at"));
    const path = photoPath(userKey, "workouts", photo.type);
    await store.uploadPhoto(path, photo.data, photo.type);
    try {
      await store.setWorkout(userKey, date, true);
      const row = await store.insertWorkoutPhoto({
        user_key: userKey,
        date,
        recorded_at: recordedAt,
        photo_path: path,
      });
      return json({ photo: { id: row.id, date: row.date, recorded_at: row.recorded_at } }, 201);
    } catch (e) {
      await store.removePhotos([path]).catch(() => {});
      throw e;
    }
  }

  async function deleteWorkoutPhoto(id: string, userKey: UserKey) {
    const photo = await store.getWorkoutPhoto(id);
    if (!photo) throw new HttpError(404, "사진을 찾을 수 없습니다.");
    if (photo.user_key !== userKey) throw new HttpError(403, "다른 사람의 사진은 지울 수 없습니다.");
    await store.deleteWorkoutPhoto(id);
    await store.removePhotos([photo.photo_path]);
    return json({ ok: true });
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Supabase는 /functions/v1/api/... 를 /api/... 로 넘겨준다.
    const path = url.pathname.replace(/^.*?\/api(?=\/|$)/, "") || "/";
    const m = req.method;

    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (m === "GET" && path === "/health") return json({ ok: true });
    if (m === "POST" && path === "/login") return login(req);
    if (m === "GET" && path === "/users") {
      return json({ users: USER_KEYS.map((k) => ({ user_key: k, name: config.users[k].name })) });
    }

    const userKey = await authenticate(req);
    let match: RegExpMatchArray | null;

    if (m === "GET" && path === "/me") return me(userKey);
    if (m === "PUT" && path === "/profile") return updateProfile(req, userKey);
    if (m === "POST" && path === "/analyze") return analyzePhoto(req);
    if (m === "POST" && path === "/estimate") return estimate(req);
    if (m === "GET" && path === "/day") return day(url);
    if (m === "GET" && path === "/calendar") return calendar(url);
    if (m === "POST" && path === "/meals") return createMeal(req, userKey);
    if ((match = path.match(/^\/meals\/([0-9a-f-]{36})$/))) {
      if (m === "PATCH") return patchMeal(req, match[1], userKey);
      if (m === "DELETE") return deleteMeal(match[1], userKey);
    }
    if ((match = path.match(/^\/workouts\/(\d{4}-\d{2}-\d{2})$/))) {
      if (m === "PUT") return setWorkout(match[1], userKey, true);
      if (m === "DELETE") return setWorkout(match[1], userKey, false);
    }
    if (m === "POST" && path === "/workout-photos") return addWorkoutPhoto(req, userKey);
    if ((match = path.match(/^\/workout-photos\/([0-9a-f-]{36})$/)) && m === "DELETE") {
      return deleteWorkoutPhoto(match[1], userKey);
    }
    throw new HttpError(404, "없는 주소입니다.");
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await route(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "서버 오류가 발생했습니다." }, 500);
    }
  };
}
