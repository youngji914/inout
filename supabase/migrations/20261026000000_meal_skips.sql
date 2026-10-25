-- 끼니를 거른 기록. 식사(meals)와 따로 두어 칼로리 합계·달력 색에는 영향을 주지 않는다.
create table meal_skips (
  user_key   text not null references profiles (user_key),
  date       date not null,
  meal_type  text not null check (meal_type in ('breakfast', 'lunch', 'dinner')),
  created_at timestamptz not null default now(),
  primary key (user_key, date, meal_type)
);

alter table meal_skips enable row level security;
