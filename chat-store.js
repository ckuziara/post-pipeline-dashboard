/* Contextual chat — data access for per-task conversation, Slack thread
   mirroring, task references and notifications.

   Shaped like the other stores in server.js (makePgActivity, makePgBackups):
   a factory returning { kind, init, ...methods }, with init() doing idempotent
   DDL so a deploy migrates itself. migrations/002_contextual_chat.sql is the
   same schema for running by hand; the two are kept deliberately in step.

   No ORM. This project has none — `pg` and SQL — and adding one for five
   tables would be a bigger change than the feature. Every query below is
   parameterised.

   ── A TASK IS NOT A ROW ──────────────────────────────────────────────────
   There is no tasks table. A task is a pipeline entry belonging to an episode
   (`layout` in episode `cn6bimwnrc`), both living inside the board_state JSON
   document. The rest of the app writes that as `episodeId::taskKey`; this
   module speaks the same language at its edges via taskId()/parseTaskId() and
   stores the two parts separately so they can be queried apart.

   ── POSTGRES ONLY ────────────────────────────────────────────────────────
   server.js runs a JSON-file backend when DATABASE_URL is unset, which is how
   local preview runs. There is no file implementation here, so chat is
   unavailable in file mode. See the note at the foot of this file. */
'use strict';

const TYPES = ['mention', 'assigned_task_chat'];

/* The composite the rest of the app already uses. Kept as helpers rather than
   inlined so there is one place that knows the format if it ever changes. */
const taskId = (episodeId, taskKey) => episodeId + '::' + taskKey;
const parseTaskId = (composite) => {
  const i = String(composite || '').indexOf('::');
  if (i < 0) return null;
  return { episodeId: composite.slice(0, i), taskKey: composite.slice(i + 2) };
};

function makePgChat(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = (r) => r.rows[0] || null;

  return {
    kind: 'postgres',

    /* Mirrors migrations/002_contextual_chat.sql. Columns added after the
       first release go in as ALTER ... IF NOT EXISTS, the same way
       activity_log gained `dept`, so existing deployments migrate in place. */
    async init() {
      await q(`create table if not exists users (
        id uuid primary key default gen_random_uuid(),
        email text not null,
        full_name text not null default '',
        slack_user_id text, sso_id text, board_person_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now())`);
      await q('create unique index if not exists users_email_lower_idx on users (lower(email))');
      await q('create unique index if not exists users_slack_idx on users (slack_user_id) where slack_user_id is not null');
      await q('create unique index if not exists users_sso_idx on users (sso_id) where sso_id is not null');
      await q('create unique index if not exists users_person_idx on users (board_person_id) where board_person_id is not null');

      await q(`create table if not exists revisions (
        id uuid primary key default gen_random_uuid(),
        episode_id text not null, task_key text not null,
        idx integer not null, label text,
        created_by_user_id uuid references users(id) on delete set null,
        created_at timestamptz not null default now())`);
      await q('create unique index if not exists revisions_task_idx on revisions (episode_id, task_key, idx)');
      await q('create index if not exists revisions_task_time_idx on revisions (episode_id, task_key, created_at)');

      await q(`create table if not exists slack_channel_mappings (
        id uuid primary key default gen_random_uuid(),
        show_id text not null, dept_key text,
        slack_channel_id text not null,
        created_at timestamptz not null default now())`);
      await q(`create unique index if not exists slack_channel_scope_idx
        on slack_channel_mappings (show_id, dept_key) nulls not distinct`);

      await q(`create table if not exists messages (
        id uuid primary key default gen_random_uuid(),
        episode_id text not null, task_key text not null,
        revision_id uuid references revisions(id) on delete set null,
        author_id uuid references users(id) on delete set null,
        content text not null,
        is_system_event boolean not null default false,
        cross_references jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now())`);
      /* Only the half the database can hold forever: a system event is never
         attributed to a person. The mirror ("a human message has an author")
         is a write-time rule enforced in postMessage — as a CHECK it would
         make ON DELETE SET NULL abort, and any user who had posted could
         never be deleted. */
      await q(`do $$ begin
        if not exists (select 1 from pg_constraint where conname = 'messages_author_rule') then
          alter table messages add constraint messages_author_rule
            check (not is_system_event or author_id is null); end if;
        if not exists (select 1 from pg_constraint where conname = 'messages_xrefs_array') then
          alter table messages add constraint messages_xrefs_array
            check (jsonb_typeof(cross_references) = 'array'); end if;
      end $$`);
      await q('create index if not exists messages_thread_idx on messages (episode_id, task_key, created_at)');
      await q('create index if not exists messages_episode_idx on messages (episode_id, created_at desc)');
      await q('create index if not exists messages_xrefs_gin on messages using gin (cross_references)');

      await q(`create table if not exists slack_thread_mappings (
        id uuid primary key default gen_random_uuid(),
        episode_id text not null, task_key text not null,
        slack_channel_id text not null, slack_thread_ts text not null,
        created_at timestamptz not null default now())`);
      await q('create unique index if not exists slack_map_task_idx on slack_thread_mappings (episode_id, task_key)');
      await q('create unique index if not exists slack_map_thread_idx on slack_thread_mappings (slack_channel_id, slack_thread_ts)');

      await q(`create table if not exists task_references (
        id uuid primary key default gen_random_uuid(),
        episode_id text not null, task_key text not null,
        message_id uuid references messages(id) on delete set null,
        url text not null, display_name text not null,
        created_by_user_id uuid references users(id) on delete set null,
        created_at timestamptz not null default now())`);
      await q('create index if not exists task_refs_task_idx on task_references (episode_id, task_key, created_at desc)');

      await q(`create table if not exists notifications (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        message_id uuid not null references messages(id) on delete cascade,
        episode_id text not null, task_key text not null,
        type text not null,
        is_read boolean not null default false,
        created_at timestamptz not null default now())`);
      await q(`do $$ begin
        if not exists (select 1 from pg_constraint where conname = 'notifications_type_chk') then
          alter table notifications add constraint notifications_type_chk
            check (type in ('mention','assigned_task_chat')); end if;
      end $$`);
      await q('create unique index if not exists notifications_once_idx on notifications (user_id, message_id, type)');
      await q('create index if not exists notifications_unread_idx on notifications (user_id, created_at desc) where is_read = false');

      await q(`create or replace function set_updated_at() returns trigger as $$
        begin new.updated_at = now(); return new; end; $$ language plpgsql`);
      await q('drop trigger if exists users_set_updated_at on users');
      await q(`create trigger users_set_updated_at before update on users
        for each row execute function set_updated_at()`);
    },

    /* ---- users ---------------------------------------------------------
       Email is the identity, matched case-insensitively — the sign-in flow
       already treats it that way, and letting Chris@ and chris@ become two
       rows here would quietly split one person's notifications in half.
       COALESCE on update so a Slack link isn't wiped by a later SSO login
       that doesn't know about it. */
    async upsertUser({ email, fullName, slackUserId, ssoId, boardPersonId }) {
      return one(await q(
        `insert into users (email, full_name, slack_user_id, sso_id, board_person_id)
         values ($1, coalesce($2,''), $3, $4, $5)
         on conflict (lower(email)) do update set
           full_name       = coalesce(nullif(excluded.full_name,''), users.full_name),
           slack_user_id   = coalesce(excluded.slack_user_id,   users.slack_user_id),
           sso_id          = coalesce(excluded.sso_id,          users.sso_id),
           board_person_id = coalesce(excluded.board_person_id, users.board_person_id)
         returning *`,
        [email, fullName || null, slackUserId || null, ssoId || null, boardPersonId || null]));
    },

    async findUserByEmail(email) {
      return one(await q('select * from users where lower(email) = lower($1)', [email]));
    },
    async findUserBySlackId(slackUserId) {
      return one(await q('select * from users where slack_user_id = $1', [slackUserId]));
    },
    async findUsersByBoardPersonIds(ids) {
      if (!ids || !ids.length) return [];
      return (await q('select * from users where board_person_id = any($1::text[])', [ids])).rows;
    },

    /* ---- revisions -----------------------------------------------------
       Spec: "Start new revision; auto-generate is_system_event = true
       milestone message." Both happen here, in one transaction — a revision
       whose divider failed to post would leave the thread unreadable at
       exactly the point it matters. */
    async startRevision({ episodeId, taskKey, label, createdByUserId }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const nextIdx = (await client.query(
          'select coalesce(max(idx),0) + 1 as n from revisions where episode_id = $1 and task_key = $2',
          [episodeId, taskKey])).rows[0].n;
        const rev = (await client.query(
          `insert into revisions (episode_id, task_key, idx, label, created_by_user_id)
           values ($1,$2,$3,$4,$5) returning *`,
          [episodeId, taskKey, nextIdx, label || null, createdByUserId || null])).rows[0];
        const divider = (await client.query(
          `insert into messages (episode_id, task_key, revision_id, content, is_system_event)
           values ($1,$2,$3,$4,true) returning *`,
          [episodeId, taskKey, rev.id, label ? ('Revision ' + nextIdx + ' — ' + label) : ('Revision ' + nextIdx)]
        )).rows[0];
        await client.query('commit');
        return { revision: rev, divider };
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
    },

    async currentRevision({ episodeId, taskKey }) {
      return one(await q(
        'select * from revisions where episode_id = $1 and task_key = $2 order by idx desc limit 1',
        [episodeId, taskKey]));
    },

    /* ---- messages ------------------------------------------------------
       revisionId defaults to whatever round the task is currently on, so a
       caller never has to know — the spec's "continuous context" only works
       if every message lands under the right divider without being told. */
    async postMessage({ episodeId, taskKey, authorId, content, isSystemEvent, crossReferences, revisionId }) {
      const sys = !!isSystemEvent;
      if (!sys && !authorId) throw new Error('A non-system message needs an author.');
      if (!content || !String(content).trim()) throw new Error('A message needs content.');
      let rev = revisionId;
      if (rev === undefined) {
        const cur = await this.currentRevision({ episodeId, taskKey });
        rev = cur ? cur.id : null;
      }
      /* Returns the author joined on, in the same shape listThread produces.
         Not cosmetic: this row is what the caller broadcasts over SSE, and a
         bare insert row has author_id but no name — so every recipient would
         render "Someone" until they happened to reload. */
      return one(await q(
        `with ins as (
           insert into messages
             (episode_id, task_key, author_id, content, is_system_event, cross_references, revision_id)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7)
           returning *
         )
         select ins.*, u.full_name as author_name, u.email as author_email
           from ins left join users u on u.id = ins.author_id`,
        [episodeId, taskKey, sys ? null : authorId, content, sys,
         JSON.stringify(crossReferences || []), rev || null]));
    },

    /* ---- slack channel mapping ----------------------------------------
       Which channel a show (optionally a show's department) posts into.
       Falls back show-wide when no per-department channel is configured. */
    async setChannel({ showId, deptKey, slackChannelId }) {
      return one(await q(
        `insert into slack_channel_mappings (show_id, dept_key, slack_channel_id)
         values ($1,$2,$3)
         on conflict (show_id, dept_key) do update set slack_channel_id = excluded.slack_channel_id
         returning *`,
        [showId, deptKey || null, slackChannelId]));
    },
    async findChannel({ showId, deptKey }) {
      return one(await q(
        `select * from slack_channel_mappings
          where show_id = $1 and (dept_key = $2 or dept_key is null)
          order by (dept_key is null)   -- the department-specific row wins
          limit 1`,
        [showId, deptKey || null]));
    },

    /* Oldest-first, which is reading order. `before` pages backwards through
       older history without OFFSET, so a message arriving mid-scroll can't
       shift the window and duplicate a row. */
    async listThread({ episodeId, taskKey, limit = 100, before = null }) {
      const rows = (await q(
        `select m.*, u.full_name as author_name, u.email as author_email
           from messages m
           left join users u on u.id = m.author_id
          where m.episode_id = $1 and m.task_key = $2
            and ($3::timestamptz is null or m.created_at < $3)
          order by m.created_at desc
          limit $4`,
        [episodeId, taskKey, before, Math.min(limit, 500)])).rows;
      return rows.reverse();
    },

    async countThread({ episodeId, taskKey }) {
      const r = one(await q(
        'select count(*)::int as n from messages where episode_id = $1 and task_key = $2',
        [episodeId, taskKey]));
      return r ? r.n : 0;
    },

    /* ---- slack thread mapping ------------------------------------------
       Idempotent on the task: re-linking a task to a new thread replaces the
       old mapping rather than erroring, which is what re-running a /link
       command should do. */
    async mapSlackThread({ episodeId, taskKey, slackChannelId, slackThreadTs }) {
      return one(await q(
        `insert into slack_thread_mappings (episode_id, task_key, slack_channel_id, slack_thread_ts)
         values ($1,$2,$3,$4)
         on conflict (episode_id, task_key) do update set
           slack_channel_id = excluded.slack_channel_id,
           slack_thread_ts  = excluded.slack_thread_ts
         returning *`,
        [episodeId, taskKey, slackChannelId, slackThreadTs]));
    },
    // the inbound direction: a Slack event arrives, which task is it about?
    async findTaskBySlackThread(slackChannelId, slackThreadTs) {
      return one(await q(
        'select * from slack_thread_mappings where slack_channel_id = $1 and slack_thread_ts = $2',
        [slackChannelId, slackThreadTs]));
    },
    async findSlackThreadByTask({ episodeId, taskKey }) {
      return one(await q(
        'select * from slack_thread_mappings where episode_id = $1 and task_key = $2',
        [episodeId, taskKey]));
    },

    /* ---- task references ----------------------------------------------- */
    async addReference({ episodeId, taskKey, messageId, url, displayName, createdByUserId }) {
      if (!url || !String(url).trim()) throw new Error('A reference needs a url.');
      return one(await q(
        `insert into task_references
           (episode_id, task_key, message_id, url, display_name, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [episodeId, taskKey, messageId || null, url, displayName || null, createdByUserId || null]));
    },
    async listReferences({ episodeId, taskKey }) {
      return (await q(
        `select r.*, u.full_name as created_by_name
           from task_references r
           left join users u on u.id = r.created_by_user_id
          where r.episode_id = $1 and r.task_key = $2
          order by r.created_at desc`,
        [episodeId, taskKey])).rows;
    },
    async removeReference(id) {
      return (await q('delete from task_references where id = $1', [id])).rowCount > 0;
    },

    /* ---- notifications --------------------------------------------------
       Fan-out in ONE statement rather than a loop: a mention of six people is
       one round trip, and ON CONFLICT DO NOTHING means being both mentioned
       and assigned doesn't deliver the same thing twice. */
    async notify({ userIds, messageId, episodeId, taskKey, type }) {
      if (!TYPES.includes(type)) throw new Error('Unknown notification type: ' + type);
      const ids = (userIds || []).filter(Boolean);
      if (!ids.length) return [];
      return (await q(
        `insert into notifications (user_id, message_id, episode_id, task_key, type)
         select unnest($1::uuid[]), $2, $3, $4, $5
         on conflict (user_id, message_id, type) do nothing
         returning *`,
        [ids, messageId, episodeId, taskKey, type])).rows;
    },

    async listUnread(userId, limit = 50) {
      return (await q(
        `select n.*, m.content, m.created_at as message_at, u.full_name as author_name
           from notifications n
           join messages m on m.id = n.message_id
           left join users u on u.id = m.author_id
          where n.user_id = $1 and n.is_read = false
          order by n.created_at desc
          limit $2`,
        [userId, Math.min(limit, 200)])).rows;
    },

    async unreadCount(userId) {
      const r = one(await q(
        'select count(*)::int as n from notifications where user_id = $1 and is_read = false',
        [userId]));
      return r ? r.n : 0;
    },

    // scoped by user_id as well as id, so one user can never mark another's read
    async markRead(userId, notificationIds) {
      if (!notificationIds || !notificationIds.length) return 0;
      return (await q(
        'update notifications set is_read = true where user_id = $1 and id = any($2::uuid[]) and is_read = false',
        [userId, notificationIds])).rowCount;
    },
    async markThreadRead(userId, { episodeId, taskKey }) {
      return (await q(
        `update notifications set is_read = true
          where user_id = $1 and episode_id = $2 and task_key = $3 and is_read = false`,
        [userId, episodeId, taskKey])).rowCount;
    }
  };
}

module.exports = { makePgChat, taskId, parseTaskId, NOTIFICATION_TYPES: TYPES };

/* ── FILE MODE IS NOT IMPLEMENTED ───────────────────────────────────────────
   server.js picks its backend on DATABASE_URL: Postgres when set, a JSON file
   otherwise. Local preview runs the file path, so wiring this in as-is gives a
   chat feature that works on Render and is missing in development.

   Three ways out, in the order I'd consider them:
     · point local dev at the Neon dev branch (DATABASE_URL in the environment)
       — no new code, and dev then exercises the real queries;
     · write makeFileChat with the same interface, as makeFileActivity does;
     · make chat degrade visibly when no store is configured, rather than
       erroring on first use.
   Not chosen here — it depends on whether you want local dev hitting Neon. */
