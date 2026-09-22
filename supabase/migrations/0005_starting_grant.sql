-- A one-time starting grant on first registration, so new players can sit at a table on day one.
alter table transactions drop constraint if exists transactions_kind_check;
alter table transactions add constraint transactions_kind_check
  check (kind in ('daily', 'stake', 'refund', 'win', 'adjust', 'grant'));

drop function if exists ledger_hello(text, text);
create or replace function ledger_hello(p_id text, p_name text, p_grant integer default 0)
returns players language plpgsql security definer set search_path = public as $$
declare r players;
begin
  insert into players (id, name, balance) values (p_id, left(p_name, 32), greatest(p_grant, 0))
    on conflict (id) do nothing returning * into r;
  if r.id is not null then
    if p_grant > 0 then
      insert into transactions (player_id, kind, amount, game_id) values (p_id, 'grant', p_grant, 'starting-grant');
    end if;
    return r;
  end if;
  update players set name = left(p_name, 32), updated_at = now() where id = p_id returning * into r;
  return r;
end $$;

-- everyone who registered before the grant existed gets it once
insert into transactions (player_id, kind, amount, game_id)
  select p.id, 'grant', 50000, 'starting-grant' from players p
  where not exists (select 1 from transactions t where t.player_id = p.id and t.kind = 'grant');
update players p set balance = p.balance + 50000, updated_at = now()
  where exists (select 1 from transactions t where t.player_id = p.id and t.kind = 'grant' and t.created_at > now() - interval '1 minute');

revoke execute on function ledger_hello(text, text, integer) from public, anon, authenticated;
