-- ═══════════════════════════════════════════════════════════════════════════
-- Contextual chat: per-task conversation, Slack thread mirroring, references
-- and notifications.
--
-- Safe to run repeatedly. One transaction, so a failure part-way leaves the
-- database exactly as it was.
--
-- ─── THREE DEPARTURES FROM THE REQUESTED SHAPE, AND WHY ───────────────────
--
-- 1. There is no `tasks` table to reference. In this app a task is a pipeline
--    entry (`layout`, `blocking`) belonging to an episode, and both live
--    inside the board_state JSON document rather than in relational tables.
--    The rest of the app already identifies one as `episodeId::taskKey` (see
--    js/uploads.js, js/workspace.js, js/lucidlink.js). Stored here as two
--    columns instead of one composite string: same identity, but you can ask
--    "all chat for this episode" without parsing.
--
-- 2. The spec REFERENCES a revisions table it never defines — messages carry
--    revision_id, POST /api/tasks/:taskId/revisions creates one, and the chat
--    stream draws milestone dividers between them, but Section 2 has no DDL
--    for it. Defined below so the foreign key has a target. Note this is a new
--    concept for Post Pipeline: "revision" here currently means revision
--    ROUNDS in the planner (a duration multiplier in craft.js/planning.js),
--    not a versioned artifact anyone can point at.
--
-- 3. `users` is genuinely new, and it OVERLAPS with board_state.data.people.
--    `board_person_id` is the bridge: it links a row here to the person id the
--    board already uses for assignees, so the two never drift into separate
--    answers about who someone is. Nullable, because a Slack-only or SSO-only
--    account may exist before anyone puts them on a show.
--
-- Foreign keys between the NEW tables are real and enforced. References to
-- episodes and tasks cannot be, because their targets aren't rows — see the
-- integrity note at the foot of this file.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── users ──────────────────────────────────────────────────────────────────
create table if not exists users (
  id              uuid        primary key default gen_random_uuid(),
  email           text        not null,
  full_name       text        not null default '',
  slack_user_id   text,
  sso_id          text,
  board_person_id text,        -- ties to board_state.data.people[].id
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Email uniqueness is case-insensitive: Chris@ and chris@ are one person, and
-- a plain UNIQUE would happily store both and then hand you two identities.
create unique index if not exists users_email_lower_idx on users (lower(email));
-- Partial, so many rows may have NULL slack/sso without colliding.
create unique index if not exists users_slack_idx  on users (slack_user_id)   where slack_user_id is not null;
create unique index if not exists users_sso_idx    on users (sso_id)          where sso_id is not null;
create unique index if not exists users_person_idx on users (board_person_id) where board_person_id is not null;

comment on column users.board_person_id is
  'Matches board_state.data.people[].id — the bridge between auth identity and board assignees.';

-- ── revisions ──────────────────────────────────────────────────────────────
-- NOT IN THE SPEC'S SECTION 2, but the spec requires it: messages carry a
-- revision_id, POST /api/tasks/:taskId/revisions creates one, and the chat
-- stream renders "milestone dividers" between them. The DDL was simply
-- omitted. Defined here so the foreign key has a target.
--
-- `idx` is the round number a person would say out loud ("we're on v3"), kept
-- separate from the uuid so the divider can be labelled without a lookup.
create table if not exists revisions (
  id                 uuid        primary key default gen_random_uuid(),
  episode_id         text        not null,
  task_key           text        not null,
  idx                integer     not null,
  label              text,
  created_by_user_id uuid        references users(id) on delete set null,
  created_at         timestamptz not null default now()
);
create unique index if not exists revisions_task_idx on revisions (episode_id, task_key, idx);
create index if not exists revisions_task_time_idx on revisions (episode_id, task_key, created_at);

-- ── messages ───────────────────────────────────────────────────────────────
create table if not exists messages (
  id               uuid        primary key default gen_random_uuid(),
  episode_id       text        not null,
  task_key         text        not null,
  revision_id      uuid        references revisions(id) on delete set null,
  author_id        uuid        references users(id) on delete set null,
  content          text        not null,
  is_system_event  boolean     not null default false,
  cross_references jsonb       not null default '[]'::jsonb,
  created_at       timestamptz not null default now()
);

do $$
begin
  /* A system event is never attributed to a person — that stays true forever,
     so the database enforces it.

     The mirror rule ("a human message must have an author") is deliberately
     NOT here, even though it looks like the obvious pair. It is a write-time
     rule, and a CHECK is evaluated on every update: combined with the
     ON DELETE SET NULL above, deleting a user would null their author_id,
     violate the constraint, and abort the delete — making any user who had
     ever posted undeletable. Enforced in chat-store.postMessage instead,
     where "at write time" is expressible. */
  if not exists (select 1 from pg_constraint where conname = 'messages_author_rule') then
    alter table messages add constraint messages_author_rule
      check (not is_system_event or author_id is null);
  end if;
  -- jsonb accepts an object or a scalar just as happily as an array
  if not exists (select 1 from pg_constraint where conname = 'messages_xrefs_array') then
    alter table messages add constraint messages_xrefs_array
      check (jsonb_typeof(cross_references) = 'array');
  end if;
end $$;

-- the thread read: one task's messages, oldest first
create index if not exists messages_thread_idx on messages (episode_id, task_key, created_at);
-- "what has been said across this episode"
create index if not exists messages_episode_idx on messages (episode_id, created_at desc);
-- containment queries against the cross-reference array
create index if not exists messages_xrefs_gin on messages using gin (cross_references);

-- ── slack_thread_mappings ──────────────────────────────────────────────────
create table if not exists slack_thread_mappings (
  id               uuid        primary key default gen_random_uuid(),
  episode_id       text        not null,
  task_key         text        not null,
  slack_channel_id text        not null,
  slack_thread_ts  text        not null,
  created_at       timestamptz not null default now()
);

-- one task ↔ one thread, enforced from BOTH directions. The second is the one
-- that saves you: without it two tasks can claim the same Slack thread and
-- every inbound event becomes ambiguous.
create unique index if not exists slack_map_task_idx
  on slack_thread_mappings (episode_id, task_key);
create unique index if not exists slack_map_thread_idx
  on slack_thread_mappings (slack_channel_id, slack_thread_ts);

-- ── slack_channel_mappings ─────────────────────────────────────────────────
-- ALSO NOT IN THE SPEC'S SECTION 2. Section 1 says high-level scope maps to
-- Slack channels (#cyber-anim) and task threads hang beneath them — but
-- nothing records WHICH channel a show/department pair posts into, so there is
-- no way to place the anchoring Task Card. Without this, stage 3 has nowhere
-- to post.
--
-- dept_key NULL means "the whole show", used when a show has one channel
-- rather than one per department. NULLS NOT DISTINCT (PG15+, you are on 18)
-- makes that row genuinely unique — a plain UNIQUE treats every NULL as
-- different and would happily store the same show twice.
create table if not exists slack_channel_mappings (
  id               uuid        primary key default gen_random_uuid(),
  show_id          text        not null,
  dept_key         text,
  slack_channel_id text        not null,
  created_at       timestamptz not null default now()
);
create unique index if not exists slack_channel_scope_idx
  on slack_channel_mappings (show_id, dept_key) nulls not distinct;

-- ── task_references ────────────────────────────────────────────────────────
create table if not exists task_references (
  id                 uuid        primary key default gen_random_uuid(),
  episode_id         text        not null,
  task_key           text        not null,
  message_id         uuid        references messages(id) on delete set null,
  url                text        not null,
  display_name       text        not null,   -- NOT NULL per spec; fall back to the url
  created_by_user_id uuid        references users(id) on delete set null,
  created_at         timestamptz not null default now()
);

create index if not exists task_refs_task_idx on task_references (episode_id, task_key, created_at desc);
create index if not exists task_refs_msg_idx  on task_references (message_id) where message_id is not null;

-- ── notifications ──────────────────────────────────────────────────────────
create table if not exists notifications (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references users(id)    on delete cascade,
  message_id uuid        not null references messages(id) on delete cascade,
  episode_id text        not null,
  task_key   text        not null,
  type       text        not null,
  is_read    boolean     not null default false,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_type_chk') then
    alter table notifications add constraint notifications_type_chk
      check (type in ('mention', 'assigned_task_chat'));
  end if;
end $$;

-- One notification per user per message per reason. Being mentioned in a task
-- you're also assigned to should not arrive twice.
create unique index if not exists notifications_once_idx
  on notifications (user_id, message_id, type);

-- The hot query is "my unread", and it stays small while the table doesn't:
-- a partial index only carries the unread rows.
create index if not exists notifications_unread_idx
  on notifications (user_id, created_at desc) where is_read = false;

-- ── updated_at ─────────────────────────────────────────────────────────────
-- reuses the trigger function from 001_byok_keys.sql if it is already there
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at
  before update on users
  for each row execute function set_updated_at();

commit;

-- ── integrity note ─────────────────────────────────────────────────────────
-- episode_id and task_key cannot be foreign keys while episodes and pipeline
-- tasks live inside the board_state JSON document. Nothing stops a row here
-- pointing at an episode that has since been deleted, so the application must
-- either validate on write or tolerate orphans on read. Two ways out, when it
-- matters enough:
--   · promote episodes to a real table and add the FK, or
--   · a periodic sweep that deletes chat whose episode no longer exists.
-- Deliberately not solved here — it is a product decision about whether
-- deleting an episode should destroy its conversation.

-- ── verify ─────────────────────────────────────────────────────────────────
select table_name, count(*) as columns
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('users','messages','slack_thread_mappings','task_references','notifications')
 group by table_name
 order by table_name;
