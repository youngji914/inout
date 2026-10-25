-- 목표를 권장섭취량(에너지 필요추정량) 기준으로 바꾸고, 식사를 음식 항목별로 저장한다.

alter table profiles
  add column activity_level text check (activity_level in ('sedentary', 'low', 'active', 'very_active')),
  add column eer_kcal int;

-- 목표 기본값: 권장섭취량 그대로
alter table profiles alter column goal_offset_kcal set default 0;

-- [{ "name": "김치찌개", "calories_kcal": 450 }, ...]
-- food_name, calories_kcal은 목록과 합계를 담아 두고 집계·표시에 그대로 쓴다.
alter table meals add column items jsonb not null default '[]'::jsonb;
