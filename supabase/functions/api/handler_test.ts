import { assert, assertEquals } from "@std/assert";
import type { Analysis, FoodAi } from "./analyze.ts";
import { type Config, createHandler } from "./handler.ts";
import {
  calcBmr,
  calcEer,
  dayFeedback,
  dayStatus,
  macroPercents,
  monthRange,
  signToken,
  targetOn,
  todayIn,
  verifyToken,
} from "./logic.ts";
import type { TargetRow, UserKey } from "./logic.ts";
import { memoryStore } from "./memory_store.ts";

// ---------- logic ----------

Deno.test("BMR uses Mifflin-St Jeor", () => {
  assertEquals(calcBmr("male", 30, 175, 70), 1649);
  assertEquals(calcBmr("female", 30, 160, 55), 1239);
});

Deno.test("recommended intake uses the KDRI estimated energy requirement", () => {
  assertEquals(calcEer("female", 30, 160, 55, "low"), 2024);
  assertEquals(calcEer("male", 30, 175, 70, "sedentary"), 2434);
  assertEquals(calcEer("male", 30, 175, 70, "active"), 2949);
});

Deno.test("day status thresholds", () => {
  assertEquals(dayStatus(0, 1500, 0), null);
  assertEquals(dayStatus(1000, null, 2), null);
  assertEquals(dayStatus(1650, 1500, 1), "green");
  assertEquals(dayStatus(1875, 1500, 1), "orange");
  assertEquals(dayStatus(1876, 1500, 1), "red");
});

Deno.test("target history picks the value in effect on the date", () => {
  const rows: TargetRow[] = [
    { user_key: "user1", effective_date: "2026-10-10", daily_target_kcal: 1500 },
    { user_key: "user1", effective_date: "2026-10-20", daily_target_kcal: 1400 },
    { user_key: "user2", effective_date: "2026-10-01", daily_target_kcal: 2000 },
  ];
  assertEquals(targetOn(rows, "user1", "2026-10-05"), 1500);
  assertEquals(targetOn(rows, "user1", "2026-10-15"), 1500);
  assertEquals(targetOn(rows, "user1", "2026-10-20"), 1400);
  assertEquals(targetOn(rows, "user2", "2026-10-30"), 2000);
});

Deno.test("token round trip and tampering", async () => {
  const token = await signToken("s3cret", "user2", 1000);
  assertEquals(await verifyToken("s3cret", token, 1000), "user2");
  assertEquals(await verifyToken("other", token, 1000), null);
  assertEquals(await verifyToken("s3cret", token.replace("user2", "user1"), 1000), null);
  assertEquals(await verifyToken("s3cret", token, 1000 + 60 * 60 * 24 * 31), null);
});

Deno.test("date helpers", () => {
  assertEquals(monthRange("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assertEquals(todayIn("Asia/Seoul", new Date("2026-10-25T16:00:00Z")), "2026-10-26");
});

// ---------- handler with in-memory store ----------

const config: Config = {
  users: { user1: { name: "영지", password: "1111" }, user2: { name: "신혁", password: "2222" } },
  sessionSecret: "test-secret",
  timeZone: "Asia/Seoul",
};

const ANALYSIS: Analysis = {
  is_food: true,
  food_name: "김치찌개, 공기밥",
  calories_kcal: 750,
  items: [
    { name: "김치찌개", calories_kcal: 450, carbs_g: 15, protein_g: 25, fat_g: 30 },
    { name: "공기밥", calories_kcal: 300, carbs_g: 66, protein_g: 6, fat_g: 0.6 },
  ],
  description: "1인분 뚝배기와 밥 한 공기로 보입니다.",
};

const fakeAi: FoodAi = {
  analyzePhoto: () => Promise.resolve(ANALYSIS),
  estimate: (names) =>
    Promise.resolve(names.map((name) => ({ name, calories_kcal: 500, carbs_g: 100, protein_g: 10, fat_g: 5 }))),
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

function setup() {
  const mem = memoryStore();
  const handler = createHandler(mem.store, fakeAi, config);
  const call = (method: string, path: string, opts: { token?: string; body?: unknown; form?: FormData } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers["x-app-token"] = opts.token;
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    return handler(new Request(`https://x.supabase.co/functions/v1/api${path}`, { method, headers, body }));
  };
  const login = async (user_key: UserKey, password: string) => {
    const res = await call("POST", "/login", { body: { user_key, password } });
    return (await res.json()).token as string;
  };
  return { ...mem, call, login };
}

function mealForm(fields: Record<string, string>, photo = true) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (photo) form.set("photo", new File([JPEG], "a.jpg", { type: "image/jpeg" }));
  return form;
}

const LUNCH = {
  recorded_at: "2026-10-25T03:30:00Z",
  date: "2026-10-25",
  meal_type: "lunch",
  items: JSON.stringify([{ name: "김치찌개", calories_kcal: 450 }, { name: "공기밥", calories_kcal: 300 }]),
  ai_estimated: "true",
};

Deno.test("login rejects wrong password and locks out after repeated failures", async () => {
  const t = setup();
  const bad = await t.call("POST", "/login", { body: { user_key: "user1", password: "0000" } });
  assertEquals(bad.status, 401);
  for (let i = 0; i < 9; i++) await t.call("POST", "/login", { body: { user_key: "user1", password: "0000" } });
  const locked = await t.call("POST", "/login", { body: { user_key: "user1", password: "1111" } });
  assertEquals(locked.status, 429);
  assert(await t.login("user2", "2222"), "other user is not locked");
});

Deno.test("requests without a valid token are rejected", async () => {
  const t = setup();
  assertEquals((await t.call("GET", "/me")).status, 401);
  assertEquals((await t.call("GET", "/me", { token: "user1.9999999999.forged" })).status, 401);
  assertEquals((await t.call("OPTIONS", "/me")).status, 204);
  const names = await (await t.call("GET", "/users")).json();
  assertEquals(names.users.map((u: { name: string }) => u.name), ["영지", "신혁"]);
});

Deno.test("profile save computes BMR and daily target", async () => {
  const t = setup();
  const token = await t.login("user1", "1111");
  const res = await t.call("PUT", "/profile", {
    token,
    body: { sex: "female", age: 30, height_cm: 160, weight_kg: 55, activity_level: "low", goal_offset_kcal: -300 },
  });
  assertEquals(res.status, 200);
  const { profile } = await res.json();
  assertEquals(profile.bmr_kcal, 1239);
  assertEquals(profile.eer_kcal, 2024);
  assertEquals(profile.daily_target_kcal, 1724);

  const me = await (await t.call("GET", "/me", { token })).json();
  assertEquals(me.users[0].name, "영지");
  assertEquals(me.users[0].profile.daily_target_kcal, 1724);
});

Deno.test("analyze returns the model result", async () => {
  const t = setup();
  const token = await t.login("user1", "1111");
  const res = await t.call("POST", "/analyze", { token, form: mealForm({}) });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).calories_kcal, 750);
});

Deno.test("meal lifecycle: create, day view, edit, ownership, delete", async () => {
  const t = setup();
  const yj = await t.login("user1", "1111");
  const sh = await t.login("user2", "2222");
  await t.call("PUT", "/profile", {
    token: yj,
    body: { sex: "female", age: 30, height_cm: 160, weight_kg: 55, activity_level: "low", goal_offset_kcal: 0 },
  });

  const created = await t.call("POST", "/meals", { token: yj, form: mealForm(LUNCH) });
  assertEquals(created.status, 201);
  const { meal } = await created.json();
  assertEquals(t.files.size, 1);

  const day = await (await t.call("GET", "/day?date=2026-10-25", { token: sh })).json();
  assertEquals(day.users.user1.total_kcal, 750);
  assertEquals(day.users.user1.target_kcal, 2024);
  assertEquals(day.users.user1.meals[0].food_name, "김치찌개, 공기밥");
  assertEquals(day.users.user1.meals[0].items.length, 2);
  assertEquals(day.users.user1.status, "green");
  assert(day.users.user1.meals[0].photo_url.startsWith("https://signed/user1/meals/"));
  assertEquals(day.users.user2.meals.length, 0);

  assertEquals((await t.call("PATCH", `/meals/${meal.id}`, { token: sh, body: { meal_type: "dinner" } })).status, 403);
  const edited = await t.call("PATCH", `/meals/${meal.id}`, {
    token: yj,
    body: {
      items: [{ name: "삼겹살", calories_kcal: 1800 }, { name: "냉면", calories_kcal: 600 }],
      meal_type: "dinner",
    },
  });
  assertEquals((await edited.json()).meal.calories_kcal, 2400);

  const cal = await (await t.call("GET", "/calendar?month=2026-10", { token: yj })).json();
  assertEquals(cal.days["2026-10-25"].user1.status, "orange");
  assertEquals(cal.days["2026-10-25"].user2.status, null);

  assertEquals((await t.call("DELETE", `/meals/${meal.id}`, { token: yj })).status, 200);
  assertEquals(t.meals.length, 0);
  assertEquals(t.files.size, 0);
});

Deno.test("manual meal without photo and validation errors", async () => {
  const t = setup();
  const token = await t.login("user2", "2222");
  const ok = await t.call("POST", "/meals", { token, form: mealForm({ ...LUNCH, ai_estimated: "false" }, false) });
  assertEquals(ok.status, 201);
  assertEquals((await ok.json()).meal.photo_path, null);

  const bad = await t.call("POST", "/meals", {
    token,
    form: mealForm({ ...LUNCH, items: JSON.stringify([{ name: "밥", calories_kcal: -5 }]) }, false),
  });
  assertEquals(bad.status, 400);
  const empty = await t.call("POST", "/meals", { token, form: mealForm({ ...LUNCH, items: "[]" }, false) });
  assertEquals(empty.status, 400);
  const badType = await t.call("POST", "/meals", { token, form: mealForm({ ...LUNCH, meal_type: "brunch" }, false) });
  assertEquals(badType.status, 400);
});

Deno.test("workout check, photos, and uncheck removes photos", async () => {
  const t = setup();
  const token = await t.login("user1", "1111");
  const form = new FormData();
  form.set("photo", new File([JPEG], "gym.jpg", { type: "image/jpeg" }));
  form.set("date", "2026-10-24");
  form.set("recorded_at", "2026-10-24T10:00:00Z");
  assertEquals((await t.call("POST", "/workout-photos", { token, form })).status, 201);

  let day = await (await t.call("GET", "/day?date=2026-10-24", { token })).json();
  assertEquals(day.users.user1.worked_out, true);
  assertEquals(day.users.user1.workout_photos.length, 1);

  const cal = await (await t.call("GET", "/calendar?month=2026-10", { token })).json();
  assertEquals(cal.days["2026-10-24"].user1.worked_out, true);
  assertEquals(cal.days["2026-10-24"].user2.worked_out, false);

  assertEquals((await t.call("DELETE", "/workouts/2026-10-24", { token })).status, 200);
  day = await (await t.call("GET", "/day?date=2026-10-24", { token })).json();
  assertEquals(day.users.user1.worked_out, false);
  assertEquals(t.files.size, 0);

  assertEquals((await t.call("PUT", "/workouts/2026-10-23", { token })).status, 200);
  day = await (await t.call("GET", "/day?date=2026-10-23", { token })).json();
  assertEquals(day.users.user1.worked_out, true);
});

Deno.test("unknown path is 404", async () => {
  const t = setup();
  const token = await t.login("user1", "1111");
  assertEquals((await t.call("GET", "/nope", { token })).status, 404);
});

// ---------- 칼로리 추정·영양 피드백 ----------

Deno.test("macro percents and feedback rules", () => {
  assertEquals(macroPercents({ carbs_g: 0, protein_g: 0, fat_g: 0 }), null);
  assertEquals(macroPercents({ carbs_g: 100, protein_g: 25, fat_g: 11.1 }), { carbs_g: 67, protein_g: 17, fat_g: 17 });
  const base = { mealCount: 2, totalKcal: 1500, targetKcal: 2000, macroKcal: 1500, isPast: false };

  const carbHeavy = dayFeedback({ ...base, macros: { carbs_g: 300, protein_g: 30, fat_g: 20 } });
  assert(carbHeavy.some((f) => f.level === "warn" && f.text.startsWith("탄수화물 비중이 높아요")));
  assert(carbHeavy.some((f) => f.text.startsWith("단백질이 부족해요")));
  assert(!carbHeavy.some((f) => f.level === "good"));

  const balanced = dayFeedback({ ...base, macros: { carbs_g: 200, protein_g: 90, fat_g: 40 } });
  assertEquals(balanced.map((f) => f.level), ["good"]);

  const over = dayFeedback({ ...base, totalKcal: 2500, macros: { carbs_g: 200, protein_g: 90, fat_g: 40 } });
  assert(over[0].text.startsWith("목표보다 500 kcal 더 먹었어요"));

  const pastUnder = dayFeedback({
    ...base,
    totalKcal: 1000,
    macroKcal: 1000,
    isPast: true,
    macros: { carbs_g: 120, protein_g: 60, fat_g: 30 },
  });
  assert(pastUnder.some((f) => f.text.startsWith("목표보다 많이 적게")));

  assertEquals(dayFeedback({ ...base, mealCount: 0, macros: { carbs_g: 0, protein_g: 0, fat_g: 0 } }), []);
  const noMacros = dayFeedback({ ...base, macroKcal: 0, macros: { carbs_g: 0, protein_g: 0, fat_g: 0 } });
  assertEquals(noMacros[0].level, "info");
  const partial = dayFeedback({ ...base, macroKcal: 300, macros: { carbs_g: 40, protein_g: 20, fat_g: 8 } });
  assert(partial.some((f) => f.text.startsWith("영양 정보가 없는 음식이 많아")));
});

Deno.test("estimate returns typical calories for typed names", async () => {
  const t = setup();
  const token = await t.login("user1", "1111");
  const res = await t.call("POST", "/estimate", { token, body: { names: ["라면", "  김밥 한 줄 "] } });
  assertEquals(res.status, 200);
  const { items } = await res.json();
  assertEquals(items.map((i: { name: string }) => i.name), ["라면", "김밥 한 줄"]);
  assertEquals(items[0].calories_kcal, 500);
  assertEquals((await t.call("POST", "/estimate", { token, body: { names: [] } })).status, 400);
  assertEquals((await t.call("POST", "/estimate", { body: { names: ["라면"] } })).status, 401);
});

Deno.test("saved macros feed the day nutrition and feedback", async () => {
  const t = setup();
  const token = await t.login("user1", "1111");
  const items = [
    { name: "라면", calories_kcal: 500, carbs_g: 79, protein_g: 10, fat_g: 16 },
    { name: "김밥", calories_kcal: 480, carbs_g: 80, protein_g: 12, fat_g: 10 },
    { name: "물", calories_kcal: 0 },
  ];
  const created = await t.call("POST", "/meals", {
    token,
    form: mealForm({ ...LUNCH, items: JSON.stringify(items) }, false),
  });
  assertEquals(created.status, 201);
  const meal = (await created.json()).meal;
  assertEquals(meal.items[0].carbs_g, 79);
  assertEquals(meal.items[2].carbs_g, undefined);

  const day = await (await t.call("GET", "/day?date=2026-10-25", { token })).json();
  assertEquals(day.users.user1.macros, { carbs_g: 159, protein_g: 22, fat_g: 26 });
  assert(day.users.user1.feedback.some((f: { text: string }) => f.text.startsWith("탄수화물 비중이 높아요")));
  assertEquals(day.users.user2.feedback, []);
});
