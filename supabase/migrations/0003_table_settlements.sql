-- Table settlements (game-net v0.4.0): zero-sum games whose p_deltas already
-- carry each seat's returned stake plus its net payout.
--
-- The pay-out path is unchanged: on 'settled' the escrow rows are consumed
-- and p_deltas applied. That is correct for both shapes because the Edge
-- Function computes p_deltas as "what each seat receives once the escrow is
-- gone": classic bet → winners get pot shares, losers 0; table → everyone
-- gets stake + payout (Σ payout = 0, so the pot is conserved).
--
-- Two things did have to change:
--   * the "loser account too new" check derived losers from p_deltas.cash <= 0,
--     which is wrong for table games (a loser still receives stake + payout > 0);
--     the Edge Function now names the losers explicitly (p_losers).
--   * a bet game closed by a daily/table cap used to delete the escrow without
--     paying anyone, i.e. the stakes vanished. A stake is never lost to a cap:
--     the escrow is refunded (kind 'refund') and the recorded deltas say so.
drop function if exists ledger_settle(text, text, jsonb, jsonb, integer, integer, interval);

create or replace function ledger_settle(
  p_id text, p_sig text, p_settlement jsonb, p_deltas jsonb, p_losers text[],
  p_cap_games integer, p_cap_seat_set integer, p_loser_age interval
)
returns table (status text, balance bigint, trophies integer) language plpgsql security definer set search_path = public as $$
declare
  v_game_id text := p_settlement->>'gameId';
  v_app text := p_settlement->>'app';
  v_mode text := p_settlement->>'mode';
  v_stake integer := (p_settlement->>'stake')::integer;
  v_players text[];
  v_seat_set text;
  v_n integer;
  v_attested integer;
  v_status text;
  v_reason text := null;
  v_over_cap boolean := false;
  v_escrow_ok boolean := true;
  v_deltas jsonb;
  d jsonb;
  r players;
  s settlements;
begin
  perform pg_advisory_xact_lock(hashtext(v_game_id));
  select array_agg(x order by x) into v_players from jsonb_array_elements_text(jsonb_path_query_array(p_settlement, '$.seats[*].player')) as x;
  v_seat_set := array_to_string(v_players, ',');
  v_n := array_length(v_players, 1);

  insert into settlements (game_id, app, mode, stake, seat_set, settlement)
    values (v_game_id, v_app, v_mode, v_stake, v_seat_set, p_settlement)
    on conflict (game_id) do update set settlement = coalesce(settlements.settlement, excluded.settlement);
  select * into s from settlements where game_id = v_game_id;
  -- a different result for the same game is a lie from somebody: refuse it even after settling
  if s.seat_set <> v_seat_set or s.mode <> v_mode or s.stake <> v_stake or s.settlement <> p_settlement then
    return query select 'mismatch'::text, null::bigint, null::integer; return;
  end if;
  if s.status <> 'pending' then
    select * into r from players p where p.id = p_id;
    return query select s.status, r.balance, r.trophies; return;
  end if;

  insert into attestations (game_id, player_id, sig) values (v_game_id, p_id, p_sig) on conflict do nothing;
  update settlements set attested = (select array_agg(player_id) from attestations a where a.game_id = v_game_id) where game_id = v_game_id;
  select count(*) into v_attested from attestations a where a.game_id = v_game_id and a.player_id = any (v_players);
  if v_attested < v_n then
    select * into r from players p where p.id = p_id;
    return query select 'pending'::text, r.balance, r.trophies; return;
  end if;

  -- every seat has spoken: decide the outcome once
  for d in select * from jsonb_array_elements(p_deltas) loop
    insert into players (id) values (d->>'player') on conflict (id) do nothing;
  end loop;

  if v_mode = 'bet' then
    if (select count(*) from escrow e where e.game_id = v_game_id and e.player_id = any (v_players) and e.amount = v_stake) < v_n then
      v_escrow_ok := false; v_reason := 'escrow incomplete';
    elsif exists (
      select 1 from players p
      where p.id = any (coalesce(p_losers, '{}')) and p.id = any (v_players)
        and p.created_at > now() - p_loser_age
    ) then
      v_escrow_ok := false; v_reason := 'loser account too new';
    end if;
  end if;

  if (select count(*) from settlements x where x.seat_set = v_seat_set and x.status = 'settled' and x.settled_at >= kst_day_start()) >= p_cap_seat_set then
    v_over_cap := true; v_reason := 'table cap';
  elsif exists (
    select 1 from unnest(v_players) pl
    where (select count(*) from transactions t where t.player_id = pl and t.kind = 'win' and t.created_at >= kst_day_start()) >= p_cap_games
  ) then
    v_over_cap := true; v_reason := 'daily cap';
  end if;

  if v_mode = 'bet' and (not v_escrow_ok or v_over_cap) then
    -- void (or capped): give every seat its stake back, nothing else moves
    update players p set balance = p.balance + e.amount, updated_at = now() from escrow e
      where e.game_id = v_game_id and e.player_id = p.id;
    insert into transactions (player_id, kind, amount, app, game_id)
      select e.player_id, 'refund', e.amount, v_app, v_game_id from escrow e where e.game_id = v_game_id;
    select jsonb_agg(jsonb_build_object('player', e.player_id, 'cash', e.amount, 'trophies', 0)) into v_deltas
      from escrow e where e.game_id = v_game_id;
    delete from escrow where game_id = v_game_id;
    v_status := case when v_escrow_ok then 'settled' else 'void' end;
  else
    if not v_over_cap then
      for d in select * from jsonb_array_elements(p_deltas) loop
        if (d->>'cash')::bigint <> 0 or (d->>'trophies')::integer <> 0 then
          update players p set balance = p.balance + (d->>'cash')::bigint, trophies = p.trophies + (d->>'trophies')::integer, updated_at = now()
            where p.id = d->>'player';
          insert into transactions (player_id, kind, amount, trophies, app, game_id)
            values (d->>'player', 'win', (d->>'cash')::bigint, (d->>'trophies')::integer, v_app, v_game_id);
        end if;
      end loop;
      v_deltas := p_deltas;
    end if;
    v_status := 'settled';
  end if;

  update settlements set status = v_status, settled_at = now(), reason = v_reason,
    deltas = coalesce(v_deltas, (select jsonb_agg(jsonb_build_object('player', w->>'player', 'cash', 0, 'trophies', 0)) from jsonb_array_elements(p_deltas) w))
    where game_id = v_game_id;
  select * into r from players p where p.id = p_id;
  return query select v_status, r.balance, r.trophies;
end $$;

revoke execute on function ledger_settle from public, anon, authenticated;
