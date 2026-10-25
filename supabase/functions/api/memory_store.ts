// 테스트·로컬 개발용 메모리 저장소.

import type { TargetRow, UserKey } from "./logic.ts";
import type { Meal, MealSkip, Profile, Store, Workout, WorkoutPhoto } from "./store.ts";

export function memoryStore() {
  const profiles: Profile[] = (["user1", "user2"] as UserKey[]).map((k) => ({
    user_key: k,
    sex: null,
    age: null,
    height_cm: null,
    weight_kg: null,
    activity_level: null,
    bmr_kcal: null,
    eer_kcal: null,
    goal_offset_kcal: 0,
    daily_target_kcal: null,
  }));
  const targets: TargetRow[] = [];
  const meals: Meal[] = [];
  const workouts: Workout[] = [];
  const photos: WorkoutPhoto[] = [];
  const skips: MealSkip[] = [];
  const files = new Map<string, Uint8Array>();
  const failures: { user_key: string; at: string }[] = [];
  const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

  const store: Store = {
    getProfiles: () => Promise.resolve(structuredClone(profiles)),
    updateProfile: (p) => {
      profiles[profiles.findIndex((x) => x.user_key === p.user_key)] = p;
      return Promise.resolve();
    },
    getTargets: () => Promise.resolve([...targets]),
    upsertTarget: (row) => {
      const i = targets.findIndex((t) => t.user_key === row.user_key && t.effective_date === row.effective_date);
      if (i >= 0) targets[i] = row;
      else targets.push(row);
      return Promise.resolve();
    },
    listMeals: (from, to) => Promise.resolve(meals.filter((m) => inRange(m.date, from, to))),
    getMeal: (id) => Promise.resolve(meals.find((m) => m.id === id) ?? null),
    insertMeal: (m) => {
      const meal = { ...m, id: crypto.randomUUID() };
      meals.push(meal);
      return Promise.resolve(meal);
    },
    updateMeal: (id, patch) => {
      const meal = meals.find((m) => m.id === id)!;
      Object.assign(meal, patch);
      return Promise.resolve(meal);
    },
    deleteMeal: (id) => {
      meals.splice(meals.findIndex((m) => m.id === id), 1);
      return Promise.resolve();
    },
    listWorkouts: (from, to) => Promise.resolve(workouts.filter((w) => inRange(w.date, from, to))),
    setWorkout: (userKey, date, on) => {
      const i = workouts.findIndex((w) => w.user_key === userKey && w.date === date);
      if (on && i < 0) workouts.push({ user_key: userKey, date });
      if (!on && i >= 0) {
        workouts.splice(i, 1);
        for (let j = photos.length - 1; j >= 0; j--) {
          if (photos[j].user_key === userKey && photos[j].date === date) photos.splice(j, 1);
        }
      }
      return Promise.resolve();
    },
    listWorkoutPhotos: (from, to) => Promise.resolve(photos.filter((p) => inRange(p.date, from, to))),
    getWorkoutPhoto: (id) => Promise.resolve(photos.find((p) => p.id === id) ?? null),
    insertWorkoutPhoto: (p) => {
      const row = { ...p, id: crypto.randomUUID() };
      photos.push(row);
      return Promise.resolve(row);
    },
    deleteWorkoutPhoto: (id) => {
      photos.splice(photos.findIndex((p) => p.id === id), 1);
      return Promise.resolve();
    },
    listSkips: (from, to) => Promise.resolve(skips.filter((s) => inRange(s.date, from, to))),
    setSkip: (userKey, date, mealType, on) => {
      const i = skips.findIndex((s) => s.user_key === userKey && s.date === date && s.meal_type === mealType);
      if (on && i < 0) skips.push({ user_key: userKey, date, meal_type: mealType });
      if (!on && i >= 0) skips.splice(i, 1);
      return Promise.resolve();
    },
    countLoginFailures: (userKey, since) =>
      Promise.resolve(failures.filter((f) => f.user_key === userKey && f.at >= since).length),
    addLoginFailure: (userKey) => {
      failures.push({ user_key: userKey, at: new Date().toISOString() });
      return Promise.resolve();
    },
    uploadPhoto: (path, data) => {
      files.set(path, data);
      return Promise.resolve();
    },
    removePhotos: (paths) => {
      paths.forEach((p) => files.delete(p));
      return Promise.resolve();
    },
    signPhotoUrls: (paths) => Promise.resolve(Object.fromEntries(paths.map((p) => [p, `https://signed/${p}`]))),
  };
  return { store, meals, files, photos };
}
