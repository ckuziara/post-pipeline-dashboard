/* Slack ↔ task chat, both directions — spec stages 3 and 4's Slack half.

   Bolt's HTTPReceiver is embedded in server.js's own dispatcher rather than
   given a second port to listen on. A second port was the first design here,
   and it runs fine locally — but Render (and most single-service hosts) only
   exposes the ONE port the platform proxies to the internet, so a listener
   on port+1 is unreachable from Slack's servers no matter how correctly it's
   configured. Same code path everywhere now: one port, dev or hosted.

   Embedding still gets signature verification for free, which was the
   reason for a second listener in the first place: Bolt's HTTPReceiver
   exposes `requestListener`, a bound (req, res) handler that reads the raw
   body and verifies X-Slack-Signature itself — exactly what `.start(port)`
   hands to its own internal http.Server. server.js calls handleEvent(req, res)
   for POST /slack/events BEFORE its own readBody() ever touches the request,
   so Bolt still gets the untouched stream it needs; nothing here re-implements
   the timing-safe HMAC check or replay window Bolt already gets right.

   ── DIRECTION, AND WHY THERE'S NO LOOP ────────────────────────────────────
   web → Slack   server.js calls mirrorMessage() after a message saves.
   Slack → web   Bolt events insert via chat.postMessage and emit SSE
                 themselves — they never call mirrorMessage, so a Slack
                 message can't bounce back to Slack. The other direction is
                 filtered by bot identity: everything the bridge posts to
                 Slack is authored by the bot, and bot events are dropped.

   ── IDENTITY ──────────────────────────────────────────────────────────────
   Slack user → users row via slack_user_id, else via their Slack profile
   email (the users:read.email scope) — which also back-fills slack_user_id,
   so the API lookup happens once per person, ever. Someone with no email
   (guests, other apps) can't be a users row; their words still arrive, as a
   system event that names them in the text. Losing the message would be
   worse than losing the join.

   ── UNCONFIGURED IS A SUPPORTED STATE ─────────────────────────────────────
   No SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET → makeSlackBridge returns null
   and the app runs exactly as it does today. Same pattern as chat (needs
   Postgres) and the key vault (needs a master key). */
'use strict';

const blocks = require('./slack-blocks');

const LUCIDLINK_REGEX = /(lucid:\/\/|https:\/\/[\w-]+\.lucid\.link\/)[^\s]+/gi;

function makeSlackBridge({ chat, storage, sseEmit, appUrl }) {
  const token = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!token || !signingSecret || !chat) return null;

  const { App, HTTPReceiver, LogLevel } = require('@slack/bolt');
  const { WebClient } = require('@slack/web-api');
  const receiver = new HTTPReceiver({ signingSecret });
  /* Explicit authorize instead of handing Bolt the bare token: Bolt's default
     calls auth.test per event to learn the bot's own id (for its ignoreSelf
     middleware), which needs the network at event time. We filter bot echoes
     ourselves on bot_id, so authorization is just "this token" — no network,
     which is also what makes the receiver drivable in offline tests.
     Outbound calls go through one dedicated WebClient. */
  const app = new App({
    receiver, logLevel: LogLevel.WARN, ignoreSelf: false,
    authorize: async () => ({ botToken: token })
  });
  let web = new WebClient(token);

  const taskIdOf = (epId, taskKey) => epId + '::' + taskKey;

  /* ---- identity ---------------------------------------------------------- */
  async function resolveSlackUser(slackUserId) {
    const known = await chat.findUserBySlackId(slackUserId);
    if (known) return known;
    try {
      const info = await web.users.info({ user: slackUserId });
      const email = info.user && info.user.profile && info.user.profile.email;
      const name = (info.user && (info.user.real_name || info.user.name)) || '';
      if (!email) return { noEmail: true, name };
      return await chat.upsertUser({ email, fullName: name, slackUserId });
    } catch (e) {
      return null;
    }
  }

  /* ---- outbound: web → Slack ---------------------------------------------
     Best-effort and fire-and-forget from the caller's point of view: the
     message is already saved, and Slack being down must not make the board
     look broken. A thread is created lazily — the first message on a task
     whose show maps to a channel posts the anchoring Task Card, and
     everything after lands beneath it. */
  async function ensureThread(episodeId, taskKey) {
    const existing = await chat.findSlackThreadByTask({ episodeId, taskKey });
    if (existing) return existing;

    const board = await storage.get();
    const data = board && board.data;
    const ep = data && data.episodes.find(e => e.id === episodeId);
    if (!ep) return null;
    const show = data.shows.find(s => s.id === ep.showId);
    const pipe = (show && show.pipeline) || [];
    const t = pipe.find(x => x.key === taskKey);
    const dept = t ? t.dept : null;

    const channel = await chat.findChannel({ showId: ep.showId, deptKey: dept });
    if (!channel) return null;                     // this show doesn't talk to Slack

    const person = ep.assignees && ep.assignees[taskKey]
      ? (data.people.find(p => p.id === ep.assignees[taskKey]) || {}).name : null;
    const card = blocks.taskCard({
      code: ep.code,
      epTitle: ep.title,
      taskName: (ep.names && ep.names[taskKey]) || (t && t.name) || taskKey,
      dept: dept,
      status: (ep.statuses && ep.statuses[taskKey]) || 'not_started',
      assignee: person,
      url: appUrl ? appUrl + '/#task=' + encodeURIComponent(taskIdOf(episodeId, taskKey)) : null
    });
    const posted = await web.chat.postMessage({ channel: channel.slack_channel_id, ...card });
    return chat.mapSlackThread({
      episodeId, taskKey,
      slackChannelId: posted.channel, slackThreadTs: posted.ts
    });
  }

  async function mirrorMessage(episodeId, taskKey, msg) {
    try {
      const thread = await ensureThread(episodeId, taskKey);
      if (!thread) return;
      const payload = msg.is_system_event
        ? blocks.milestoneDivider(msg.content)
        : blocks.threadReply({ authorName: msg.author_name, content: msg.content });
      await web.chat.postMessage({
        channel: thread.slack_channel_id,
        thread_ts: thread.slack_thread_ts,
        ...payload
      });
    } catch (e) {
      console.error('[slack] mirror failed:', e.data ? e.data.error : e.message);
    }
  }

  /* ---- inbound: Slack → web ---------------------------------------------- */
  app.message(async ({ message }) => {
    // everything the bridge itself posts is bot-authored; dropping bot
    // messages is what breaks the echo loop
    if (message.subtype || message.bot_id) return;

    if (message.thread_ts) {
      const mapping = await chat.findTaskBySlackThread(message.channel, message.thread_ts);
      if (!mapping) return;
      const user = await resolveSlackUser(message.user);
      let saved;
      if (user && user.id) {
        saved = await chat.postMessage({
          episodeId: mapping.episode_id, taskKey: mapping.task_key,
          authorId: user.id, content: message.text || ''
        });
      } else {
        // a voice with no identity still gets heard — named in the text
        const who = (user && user.name) || 'someone on Slack';
        saved = await chat.postMessage({
          episodeId: mapping.episode_id, taskKey: mapping.task_key,
          content: 'From Slack (' + who + '): ' + (message.text || ''), isSystemEvent: true
        });
      }
      sseEmit('new_message', { taskId: taskIdOf(mapping.episode_id, mapping.task_key), message: saved });

      // spec 3A: a LucidLink URL in a thread reply → ephemeral offer to pin
      const lucid = (message.text || '').match(LUCIDLINK_REGEX);
      if (lucid) {
        await web.chat.postEphemeral({
          channel: message.channel, user: message.user,
          ...blocks.pinPrompt(lucid[0], taskIdOf(mapping.episode_id, mapping.task_key))
        });
      }
      return;
    }

    /* spec 3B: a task mentioned in a top-level channel message → offer to
       route it into the task's thread. The board's own mention form
       (#LA-101/Task), resolved against live board state. */
    const board = await storage.get();
    const data = board && board.data;
    if (!data) return;
    const m = (message.text || '').match(/#([A-Za-z]{1,6}(?:-|\s)?\d{1,5})(?:[\/\s]+([A-Za-z][\w-]*))?/);
    if (!m) return;
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const ep = data.episodes.find(e => norm(e.code) === norm(m[1]));
    if (!ep) return;
    const show = data.shows.find(s => s.id === ep.showId);
    const pipe = (show && show.pipeline) || [];
    const t = m[2] && pipe.find(x =>
      x.name.toLowerCase() === m[2].toLowerCase() || x.name.toLowerCase().startsWith(m[2].toLowerCase()));
    if (!t) return;                                // episode alone has no thread to route to
    await web.chat.postEphemeral({
      channel: message.channel, user: message.user,
      ...blocks.routePrompt(ep.code + ' / ' + t.name, taskIdOf(ep.id, t.key), message.text)
    });
  });

  /* Reaction on any message in a mapped thread = "seen" — the spec's
     read-state clear, same effect as opening the thread in the web app. */
  app.event('reaction_added', async ({ event }) => {
    const item = event.item || {};
    if (item.type !== 'message') return;
    const mapping = await chat.findTaskBySlackThread(item.channel, item.ts)
      || await chat.findTaskBySlackThread(item.channel, event.item.thread_ts || item.ts);
    if (!mapping) return;
    const user = await resolveSlackUser(event.user);
    if (!user || !user.id) return;
    const cleared = await chat.markThreadRead(user.id, {
      episodeId: mapping.episode_id, taskKey: mapping.task_key
    });
    if (cleared > 0) {
      sseEmit('notification_cleared', {
        taskId: taskIdOf(mapping.episode_id, mapping.task_key), userId: user.id
      });
    }
  });

  app.action('pin_lucid_link', async ({ ack, body, action, respond }) => {
    await ack();
    try {
      const v = JSON.parse(action.value);
      const sep = v.taskId.indexOf('::');
      const episodeId = v.taskId.slice(0, sep), taskKey = v.taskId.slice(sep + 2);
      const user = await resolveSlackUser(body.user.id);
      const pin = await chat.addReference({
        episodeId, taskKey, url: v.url,
        displayName: v.url.split('/').filter(Boolean).pop() || v.url,
        createdByUserId: user && user.id ? user.id : null
      });
      sseEmit('reference_pinned', { taskId: v.taskId, reference: pin });
      await respond({ text: '📌 Pinned to Task References.', replace_original: true });
    } catch (e) {
      await respond({ text: 'Could not pin that: ' + e.message, replace_original: true });
    }
  });

  app.action('route_to_task', async ({ ack, body, action, respond }) => {
    await ack();
    try {
      const v = JSON.parse(action.value);
      const sep = v.taskId.indexOf('::');
      const episodeId = v.taskId.slice(0, sep), taskKey = v.taskId.slice(sep + 2);
      const user = await resolveSlackUser(body.user.id);
      const saved = await chat.postMessage(user && user.id
        ? { episodeId, taskKey, authorId: user.id, content: v.text }
        : { episodeId, taskKey, isSystemEvent: true,
            content: 'From Slack (' + ((user && user.name) || 'someone') + '): ' + v.text });
      sseEmit('new_message', { taskId: v.taskId, message: saved });
      mirrorMessage(episodeId, taskKey, saved);    // it belongs in the thread too
      await respond({ text: '➡️ Sent to the task’s thread.', replace_original: true });
    } catch (e) {
      await respond({ text: 'Could not route that: ' + e.message, replace_original: true });
    }
  });

  return {
    kind: 'slack',
    mirrorMessage,
    // The receiver's own (req, res) handler — App's constructor already
    // called receiver.init(this), so this is live and ready with no
    // separate start-up step. Bound, so `slack.handleEvent` alone works as
    // a callback without the caller worrying about `this`.
    handleEvent: receiver.requestListener,
    _setWebClient(c) { web = c; }   // offline tests inject a fake outbound client
  };
}

module.exports = { makeSlackBridge };
