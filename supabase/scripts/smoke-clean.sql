-- Remove everything the smoke identities (names 'Smoke …') left behind.
-- npx supabase db query --linked --file supabase/scripts/smoke-clean.sql
with smoke as (select id from players where name like 'Smoke%'),
  games as (select distinct game_id from transactions where player_id in (select id from smoke)
            union select game_id from attestations where player_id in (select id from smoke)
            union select game_id from escrow where player_id in (select id from smoke)
            union select game_id from settlements where game_id like 'SMOKE-%'),
  d1 as (delete from transactions where player_id in (select id from smoke) or game_id in (select game_id from games)),
  d2 as (delete from attestations where player_id in (select id from smoke) or game_id in (select game_id from games)),
  d3 as (delete from escrow where player_id in (select id from smoke) or game_id in (select game_id from games)),
  d4 as (delete from settlements where game_id in (select game_id from games))
delete from players where id in (select id from smoke);
