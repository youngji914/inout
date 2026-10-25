// DB·사진 저장소 접근. handler.ts는 Store 인터페이스에만 의존하고, 테스트에서는 메모리 구현을 쓴다.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ActivityLevel, Sex, TargetRow, UserKey } from "./logic.ts";

export interface Profile {
  user_key: UserKey;
  sex: Sex | null;
  age: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  activity_level: ActivityLevel | null;
  bmr_kcal: number | null;
  eer_kcal: number | null;
  goal_offset_kcal: number;
  daily_target_kcal: number | null;
}

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

export interface MealItem {
  name: string;
  calories_kcal: number;
  // AI가 추정했을 때만 있다
  carbs_g?: number;
  protein_g?: number;
  fat_g?: number;
}

export interface Meal {
  id: string;
  user_key: UserKey;
  recorded_at: string;
  date: string;
  meal_type: MealType;
  photo_path: string | null;
  food_name: string;
  calories_kcal: number;
  items: MealItem[];
  ai_estimated: boolean;
}

export type NewMeal = Omit<Meal, "id">;
export type MealPatch = Partial<
  Pick<Meal, "recorded_at" | "date" | "meal_type" | "food_name" | "calories_kcal" | "items">
>;

export interface Workout {
  user_key: UserKey;
  date: string;
}

export interface WorkoutPhoto {
  id: string;
  user_key: UserKey;
  date: string;
  recorded_at: string;
  photo_path: string;
}

export interface Store {
  getProfiles(): Promise<Profile[]>;
  updateProfile(p: Profile): Promise<void>;
  getTargets(): Promise<TargetRow[]>;
  upsertTarget(row: TargetRow): Promise<void>;

  listMeals(from: string, to: string): Promise<Meal[]>;
  getMeal(id: string): Promise<Meal | null>;
  insertMeal(m: NewMeal): Promise<Meal>;
  updateMeal(id: string, patch: MealPatch): Promise<Meal>;
  deleteMeal(id: string): Promise<void>;

  listWorkouts(from: string, to: string): Promise<Workout[]>;
  setWorkout(userKey: UserKey, date: string, on: boolean): Promise<void>;
  listWorkoutPhotos(from: string, to: string): Promise<WorkoutPhoto[]>;
  getWorkoutPhoto(id: string): Promise<WorkoutPhoto | null>;
  insertWorkoutPhoto(p: Omit<WorkoutPhoto, "id">): Promise<WorkoutPhoto>;
  deleteWorkoutPhoto(id: string): Promise<void>;

  countLoginFailures(userKey: UserKey, sinceIso: string): Promise<number>;
  addLoginFailure(userKey: UserKey): Promise<void>;

  uploadPhoto(path: string, data: Uint8Array, contentType: string): Promise<void>;
  removePhotos(paths: string[]): Promise<void>;
  signPhotoUrls(paths: string[]): Promise<Record<string, string>>;
}

const BUCKET = "photos";
const SIGNED_URL_SECONDS = 60 * 60;

/** Supabase가 Edge Function에 넣어 주는 secret key. 새 형식(SUPABASE_SECRET_KEYS)을 먼저 본다. */
function secretKey(): string {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys) as Record<string, string>;
      const key = parsed.default ?? Object.values(parsed)[0];
      if (key) return key;
    } catch {
      console.error("SUPABASE_SECRET_KEYS is not valid JSON; falling back to SUPABASE_SERVICE_ROLE_KEY");
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("Supabase secret key가 없습니다 (SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY).");
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export function supabaseStore(): Store {
  const db: SupabaseClient = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const MEAL_COLS = "id,user_key,recorded_at,date,meal_type,photo_path,food_name,calories_kcal,items,ai_estimated";
  const PHOTO_COLS = "id,user_key,date,recorded_at,photo_path";

  return {
    async getProfiles() {
      return check(
        await db.from("profiles")
          .select(
            "user_key,sex,age,height_cm,weight_kg,activity_level,bmr_kcal,eer_kcal,goal_offset_kcal,daily_target_kcal",
          )
          .order("user_key"),
      ) as Profile[];
    },
    async updateProfile(p) {
      const { user_key, ...fields } = p;
      check(
        await db.from("profiles").update({ ...fields, updated_at: new Date().toISOString() }).eq("user_key", user_key),
      );
    },
    async getTargets() {
      return check(await db.from("target_history").select("user_key,effective_date,daily_target_kcal")) as TargetRow[];
    },
    async upsertTarget(row) {
      check(await db.from("target_history").upsert(row));
    },

    async listMeals(from, to) {
      return check(
        await db.from("meals").select(MEAL_COLS)
          .gte("date", from).lte("date", to).order("recorded_at"),
      ) as Meal[];
    },
    async getMeal(id) {
      return check(await db.from("meals").select(MEAL_COLS).eq("id", id).maybeSingle()) as Meal | null;
    },
    async insertMeal(m) {
      return check(await db.from("meals").insert(m).select(MEAL_COLS).single()) as Meal;
    },
    async updateMeal(id, patch) {
      return check(await db.from("meals").update(patch).eq("id", id).select(MEAL_COLS).single()) as Meal;
    },
    async deleteMeal(id) {
      check(await db.from("meals").delete().eq("id", id));
    },

    async listWorkouts(from, to) {
      return check(await db.from("workouts").select("user_key,date").gte("date", from).lte("date", to)) as Workout[];
    },
    async setWorkout(userKey, date, on) {
      if (on) {
        check(await db.from("workouts").upsert({ user_key: userKey, date }, { ignoreDuplicates: true }));
      } else {
        check(await db.from("workouts").delete().eq("user_key", userKey).eq("date", date));
      }
    },
    async listWorkoutPhotos(from, to) {
      return check(
        await db.from("workout_photos").select(PHOTO_COLS)
          .gte("date", from).lte("date", to).order("recorded_at"),
      ) as WorkoutPhoto[];
    },
    async getWorkoutPhoto(id) {
      return check(await db.from("workout_photos").select(PHOTO_COLS).eq("id", id).maybeSingle()) as
        | WorkoutPhoto
        | null;
    },
    async insertWorkoutPhoto(p) {
      return check(await db.from("workout_photos").insert(p).select(PHOTO_COLS).single()) as WorkoutPhoto;
    },
    async deleteWorkoutPhoto(id) {
      check(await db.from("workout_photos").delete().eq("id", id));
    },

    async countLoginFailures(userKey, sinceIso) {
      const res = await db.from("login_failures").select("id", { count: "exact", head: true })
        .eq("user_key", userKey).gte("at", sinceIso);
      if (res.error) throw new Error(res.error.message);
      return res.count ?? 0;
    },
    async addLoginFailure(userKey) {
      check(await db.from("login_failures").insert({ user_key: userKey }));
    },

    async uploadPhoto(path, data, contentType) {
      check(await db.storage.from(BUCKET).upload(path, data, { contentType }));
    },
    async removePhotos(paths) {
      if (paths.length) check(await db.storage.from(BUCKET).remove(paths));
    },
    async signPhotoUrls(paths) {
      if (!paths.length) return {};
      const rows = check(await db.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS));
      const out: Record<string, string> = {};
      for (const r of rows ?? []) if (r.path && r.signedUrl) out[r.path] = r.signedUrl;
      return out;
    },
  };
}
