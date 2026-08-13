-- ═══════════════════════════════════════════════════════════════════════════
-- Point BYOK at the users table, and give the relay a daily spend ceiling.
--
-- 001 wrote user_id as text because there was no users table to reference —
-- 002 created one. Both BYOK tables are empty on every branch, so this is the
-- moment the type can change for free; once a single key is stored it stops
-- being a two-line migration.
--
-- Safe to run repeatedly. Guarded so a re-run on an already-converted branch
-- does nothing.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- Each conversion checks whether it is still needed BEFORE checking that the
-- table is empty. Getting that order wrong would turn this into a landmine:
-- an unconditional emptiness check fails forever once the first real key is
-- stored, so a migration that is supposed to be idempotent would start
-- erroring on every subsequent run.
--
-- The USING clause cannot turn an arbitrary text user_id into a uuid, so where
-- a conversion IS still needed the table must be empty — and it says so loudly
-- rather than silently dropping credentials.

-- ── user_api_keys.user_id → uuid, referencing users ────────────────────────
do $$
declare n integer;
begin
  if (select data_type from information_schema.columns
       where table_name = 'user_api_keys' and column_name = 'user_id') = 'text' then
    select count(*) into n from user_api_keys;
    if n > 0 then
      raise exception 'user_api_keys holds % rows of text user_ids. Convert them by hand — this migration would lose keys.', n;
    end if;
    alter table user_api_keys
      alter column user_id type uuid using user_id::uuid;
    alter table user_api_keys
      add constraint user_api_keys_user_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
end $$;

-- ── user_access_tokens.user_id → uuid, same treatment ──────────────────────
do $$
declare n integer;
begin
  if (select data_type from information_schema.columns
       where table_name = 'user_access_tokens' and column_name = 'user_id') = 'text' then
    select count(*) into n from user_access_tokens;
    if n > 0 then
      raise exception 'user_access_tokens holds % rows of text user_ids. Convert them by hand.', n;
    end if;
    alter table user_access_tokens
      alter column user_id type uuid using user_id::uuid;
    alter table user_access_tokens
      add constraint user_access_tokens_user_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
end $$;

-- ── daily spend ceiling ────────────────────────────────────────────────────
-- The per-minute bucket in the relay stops a runaway loop spiking; only a
-- daily cap stops a slow leak quietly draining someone's Google quota
-- overnight. Kept on the key row rather than a usage table because it is one
-- counter per key and needs to survive a deploy — an in-memory count resets
-- every restart, which is precisely when nobody is watching.
alter table user_api_keys add column if not exists calls_day   date;
alter table user_api_keys add column if not exists calls_count integer not null default 0;

comment on column user_api_keys.calls_count is
  'Relay calls made on calls_day. Reset lazily by the relay when the date rolls.';

commit;

-- ── verify ─────────────────────────────────────────────────────────────────
select c.table_name, c.column_name, c.data_type,
       (select count(*) from pg_constraint k
         where k.conrelid = (quote_ident(c.table_name))::regclass
           and k.contype = 'f') as fk_count
  from information_schema.columns c
 where c.table_name in ('user_api_keys','user_access_tokens')
   and c.column_name = 'user_id'
 order by c.table_name;
