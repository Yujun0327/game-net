-- yujungame ledger: wallets, trophies, settlements. The Edge Function `ledger`
-- (service role) is the only writer; anon may read the leaderboard-ish views.

create table if not exists players (
  id text primary key check (length(id) = 43),
  name text not null default '' check (length(name) <= 32),
  balance bigint not null default 0 check (balance >= 0),
  trophies integer not null default 0 check (trophies >= 0),
  last_claim_kst date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists transactions (
  id bigserial primary key,
  player_id text not null references players (id),
  kind text not null check (kind in ('daily', 'stake', 'refund', 'win', 'adjust')),
  amount bigint not null,
  trophies integer not null default 0,
  app text,
  game_id text,
  created_at timestamptz not null default now()
);
create index if not exists transactions_player_day on transactions (player_id, created_at);
create index if not exists transactions_game on transactions (game_id);

create table if not exists settlements (
  game_id text primary key,
  app text not null,
  mode text not null check (mode in ('casual', 'bet')),
  stake integer not null default 0,
  status text not null default 'pending' check (status in ('pending', 'settled', 'void')),
  -- sorted, comma-joined player ids: the "table" that played, for caps
  seat_set text not null,
  settlement jsonb,
  deltas jsonb,
  attested text[] not null default '{}',
  reason text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists settlements_seat_set_day on settlements (seat_set, settled_at);

create table if not exists attestations (
  game_id text not null,
  player_id text not null,
  sig text not null,
  created_at timestamptz not null default now(),
  primary key (game_id, player_id)
);

create table if not exists escrow (
  game_id text not null,
  player_id text not null references players (id),
  amount bigint not null check (amount > 0),
  created_at timestamptz not null default now(),
  primary key (game_id, player_id)
);

create or replace view leaderboard as
  select rank() over (order by trophies desc, balance desc, created_at asc) as rank,
         id, name, trophies, balance
  from players;

-- ---------------------------------------------------------------- RLS
alter table players enable row level security;
alter table transactions enable row level security;
alter table settlements enable row level security;
alter table attestations enable row level security;
alter table escrow enable row level security;

drop policy if exists players_public_read on players;
create policy players_public_read on players for select to anon, authenticated using (true);
drop policy if exists settlements_public_read on settlements;
create policy settlements_public_read on settlements for select to anon, authenticated using (true);
-- transactions, attestations, escrow: no anon policies → invisible to clients.

grant select on players, settlements, leaderboard to anon, authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function kst_today() returns date language sql stable as $$
  select (timezone('Asia/Seoul', now()))::date
$$;

create or replace function kst_day_start() returns timestamptz language sql stable as $$
  select timezone('Asia/Seoul', (timezone('Asia/Seoul', now()))::date::timestamp)
$$;

-- ---------------------------------------------------------------- hello
create or replace function ledger_hello(p_id text, p_name text)
returns players language plpgsql security definer set search_path = public as $$
declare r players;
begin
  insert into players (id, name) values (p_id, left(p_name, 32))
  on conflict (id) do update set name = excluded.name, updated_at = now()
  returning * into r;
  return r;
end $$;

-- ---------------------------------------------------------------- daily claim
create or replace function ledger_claim(p_id text, p_amount integer)
returns table (status text, balance bigint, trophies integer) language plpgsql security definer set search_path = public as $$
declare r players;
begin
  insert into players (id) values (p_id) on conflict (id) do nothing;
  update players p set balance = p.balance + p_amount, last_claim_kst = kst_today(), updated_at = now()
    where p.id = p_id and (p.last_claim_kst is null or p.last_claim_kst < kst_today())
    returning * into r;
  if r.id is null then
    select * into r from players p where p.id = p_id;
    return query select 'already'::text, r.balance, r.trophies;
    return;
  end if;
  insert into transactions (player_id, kind, amount) values (p_id, 'daily', p_amount);
  return query select 'claimed'::text, r.balance, r.trophies;
end $$;

-- ---------------------------------------------------------------- bet lock
create or replace function ledger_lock(p_id text, p_game_id text, p_app text, p_stake integer, p_players text[])
returns table (status text, balance bigint, trophies integer) language plpgsql security definer set search_path = public as $$
declare r players; seat_set text;
begin
  perform pg_advisory_xact_lock(hashtext(p_game_id));
  seat_set := array_to_string(p_players, ',');
  insert into settlements (game_id, app, mode, stake, seat_set)
    values (p_game_id, p_app, 'bet', p_stake, seat_set)
    on conflict (game_id) do nothing;
  if exists (select 1 from settlements s where s.game_id = p_game_id and (s.stake <> p_stake or s.seat_set <> seat_set)) then
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

-- ---------------------------------------------------------------- settle
-- p_settlement: the validated settlement (jsonb); p_deltas: [{player, cash, trophies}]
-- computed by the Edge Function assuming escrow is in place and caps are not hit.
create or replace function ledger_settle(
  p_id text, p_sig text, p_settlement jsonb, p_deltas jsonb,
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
  if s.status <> 'pending' then
    select * into r from players p where p.id = p_id;
    return query select s.status, r.balance, r.trophies; return;
  end if;
  if s.seat_set <> v_seat_set or s.mode <> v_mode or s.stake <> v_stake or s.settlement <> p_settlement then
    return query select 'mismatch'::text, null::bigint, null::integer; return;
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
      where p.id = any (v_players)
        and not (p.id = any (select (w->>'player') from jsonb_array_elements(p_deltas) w where (w->>'cash')::bigint > 0))
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

  if v_mode = 'bet' and not v_escrow_ok then
    -- void: refund whatever was locked
    update players p set balance = p.balance + e.amount, updated_at = now() from escrow e
      where e.game_id = v_game_id and e.player_id = p.id;
    insert into transactions (player_id, kind, amount, app, game_id)
      select e.player_id, 'refund', e.amount, v_app, v_game_id from escrow e where e.game_id = v_game_id;
    delete from escrow where game_id = v_game_id;
    v_status := 'void';
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
    end if;
    if v_mode = 'bet' then delete from escrow where game_id = v_game_id; end if;
    v_status := 'settled';
  end if;

  update settlements set status = v_status, settled_at = now(), reason = v_reason,
    deltas = case when v_status = 'settled' and not v_over_cap then p_deltas
                  else (select jsonb_agg(jsonb_build_object('player', w->>'player', 'cash', 0, 'trophies', 0)) from jsonb_array_elements(p_deltas) w) end
    where game_id = v_game_id;
  select * into r from players p where p.id = p_id;
  return query select v_status, r.balance, r.trophies;
end $$;

-- ---------------------------------------------------------------- stale escrow
create or replace function ledger_refund_stale_escrow(p_older_than interval)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; e record;
begin
  for e in select * from escrow x where x.created_at < now() - p_older_than
           and not exists (select 1 from settlements s where s.game_id = x.game_id and s.status <> 'pending') loop
    update players p set balance = p.balance + e.amount, updated_at = now() where p.id = e.player_id;
    insert into transactions (player_id, kind, amount, game_id) values (e.player_id, 'refund', e.amount, e.game_id);
    delete from escrow where game_id = e.game_id and player_id = e.player_id;
    update settlements set status = 'void', settled_at = now(), reason = 'abandoned' where game_id = e.game_id and status = 'pending';
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function ledger_hello, ledger_claim, ledger_lock, ledger_settle, ledger_refund_stale_escrow from public, anon, authenticated;
