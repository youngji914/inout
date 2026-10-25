-- 칼로리 관리 앱 초기 스키마.
-- 모든 접근은 Edge Function(api)이 secret key로 수행한다.
-- RLS를 켜고 정책을 두지 않아 브라우저(anon/publishable key)에서는 직접 읽고 쓸 수 없다.

create table profiles (
  user_key          text primary key check (user_key in ('user1', 'user2')),
  sex               text check (sex in ('male', 'female')),
  age               int check (age between 10 and 120),
  height_cm         numeric(5, 1) check (height_cm between 50 and 250),
  weight_kg         numeric(5, 1) check (weight_kg between 20 and 300),
  bmr_kcal          int,
  goal_offset_kcal  int not null default -500,
  daily_target_kcal int,
  updated_at        timestamptz not null default now()
);

insert into profiles (user_key) values ('user1'), ('user2');

-- 목표 칼로리가 바뀌어도 지난 날짜의 달력 색이 바뀌지 않도록 날짜별로 기록한다.
create table target_history (
  user_key          text not null references profiles (user_key),
  effective_date    date not null,
  daily_target_kcal int not null,
  primary key (user_key, effective_date)
);

create table meals (
  id            uuid primary key default gen_random_uuid(),
  user_key      text not null references profiles (user_key),
  recorded_at   timestamptz not null,
  date          date not null,
  meal_type     text not null check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  photo_path    text,
  food_name     text not null,
  calories_kcal int not null check (calories_kcal between 0 and 20000),
  ai_estimated  boolean not null default false,
  created_at    timestamptz not null default now()
);

create index meals_date_idx on meals (date);

create table workouts (
  user_key   text not null references profiles (user_key),
  date       date not null,
  created_at timestamptz not null default now(),
  primary key (user_key, date)
);

create table workout_photos (
  id          uuid primary key default gen_random_uuid(),
  user_key    text not null,
  date        date not null,
  recorded_at timestamptz not null,
  photo_path  text not null,
  created_at  timestamptz not null default now(),
  foreign key (user_key, date) references workouts (user_key, date) on delete cascade
);

create index workout_photos_date_idx on workout_photos (date);

-- 간편 비밀번호 무차별 대입을 막기 위한 로그인 실패 기록.
create table login_failures (
  id       bigint generated always as identity primary key,
  user_key text not null,
  at       timestamptz not null default now()
);

create index login_failures_user_at_idx on login_failures (user_key, at);

alter table profiles enable row level security;
alter table target_history enable row level security;
alter table meals enable row level security;
alter table workouts enable row level security;
alter table workout_photos enable row level security;
alter table login_failures enable row level security;

-- 사진은 비공개 버킷에 두고, API가 짧은 기간의 서명 URL로만 내려준다.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;
