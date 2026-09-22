-- ledger_lock never worked: its local `seat_set` collided with the
-- settlements.seat_set column ("column reference is ambiguous"), so every
-- bet lock failed with a 500. Rename the local.
create or replace function ledger_lock(p_id text, p_game_id text, p_app text, p_stake integer, p_players text[])
returns table (status text, balance bigint, trophies integer) language plpgsql security definer set search_path = public as $$
declare r players; v_seat_set text;
begin
  perform pg_advisory_xact_lock(hashtext(p_game_id));
  v_seat_set := array_to_string(p_players, ',');
  insert into settlements (game_id, app, mode, stake, seat_set)
    values (p_game_id, p_app, 'bet', p_stake, v_seat_set)
    on conflict (game_id) do nothing;
  if exists (select 1 from settlements s where s.game_id = p_game_id and (s.stake <> p_stake or s.seat_set <> v_seat_set)) then
    return query select 'mismatch'::text, null::bigint, null::integer; return;
  end if;
  if exists (select 1 from escrow e where e.game_id = p_game_id and e.player_id = p_id) then
    select * into r from players p where p.id = p_id;
    return query select 'locked'::text, r.balance, r.trophies; return;
  end if;
  insert into players (id) values (p_id) on conflict (id) do nothing;
  update players p set balance = p.balance - p_stake, updated_at = now()
    where p.id = p_id and p.balance >= p_stake returning * into r;
  if r.id is null then
    select * into r from players p where p.id = p_id;
    return query select 'insufficient'::text, r.balance, r.trophies; return;
  end if;
  insert into escrow (game_id, player_id, amount) values (p_game_id, p_id, p_stake);
  insert into transactions (player_id, kind, amount, app, game_id) values (p_id, 'stake', -p_stake, p_app, p_game_id);
  return query select 'locked'::text, r.balance, r.trophies;
end $$;

revoke execute on function ledger_lock from public, anon, authenticated;
