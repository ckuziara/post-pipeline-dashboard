-- ═══════════════════════════════════════════════════════════════════════════
-- BYOK: per-user provider API keys + relay access tokens
--
-- Safe to run repeatedly, and safe on a branch that already has some of it —
-- every statement is guarded, and the whole thing is one transaction, so a
-- failure part-way leaves the database exactly as it was.
--
-- Run against: production (br-shy-band-za74mgem) and any branch that needs it.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── the encrypted keys ─────────────────────────────────────────────────────
-- Stores ONLY ciphertext. Plaintext keys, and the master key that protects
-- them, never reach the database.

create table if not exists user_api_keys (
  user_id      text        not null,
  provider     text        not null default 'gemini',

  ciphertext   bytea       not null,   -- AES-256-GCM, encrypted in the Node layer
  iv           bytea       not null,   -- 12 bytes, fresh per encryption
  auth_tag     bytea       not null,   -- 16 bytes, GCM integrity tag

  key_version  smallint    not null default 1,   -- which master key; enables rotation
  key_hint     text        not null,             -- last 4 chars, for the UI

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_used_at timestamptz,

  constraint user_api_keys_pkey primary key (user_id, provider)
);

-- Constraints go in separately rather than inline: `create table if not exists`
-- is a no-op on an existing table, so inline checks would silently never be
-- applied to a branch that already had the table.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_api_keys_iv_len') then
    alter table user_api_keys add constraint user_api_keys_iv_len
      check (octet_length(iv) = 12);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_api_keys_tag_len') then
    alter table user_api_keys add constraint user_api_keys_tag_len
      check (octet_length(auth_tag) = 16);
  end if;
end $$;

comment on table user_api_keys is
  'Per-user third-party API keys, AES-256-GCM encrypted in the application layer.';

-- keep updated_at honest without the app having to remember
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists user_api_keys_set_updated_at on user_api_keys;
create trigger user_api_keys_set_updated_at
  before update on user_api_keys
  for each row execute function set_updated_at();

-- ── relay access tokens ────────────────────────────────────────────────────
-- Hashed, not encrypted: you never need to read a token back, only compare it.
-- A hash stays useless to an attacker even if the master key leaks.

create table if not exists user_access_tokens (
  id           bigint generated always as identity primary key,
  user_id      text        not null,
  token_hash   bytea       not null unique,   -- sha256(token). Never the token.
  label        text        not null default 'MCP client',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);

-- added after the table shipped — existing branches migrate in place
alter table user_access_tokens
  add column if not exists scopes text[] not null default array['gemini:call'];

create index if not exists user_access_tokens_user_idx
  on user_access_tokens (user_id) where revoked_at is null;

comment on table user_access_tokens is
  'Scoped, revocable tokens for non-browser clients (MCP). Stored as sha256 hashes.';

commit;

-- ── verify ─────────────────────────────────────────────────────────────────
-- Expect: user_api_keys 10 cols, user_access_tokens 9 cols (incl. scopes).
select table_name, count(*) as columns
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('user_api_keys', 'user_access_tokens')
 group by table_name
 order by table_name;
