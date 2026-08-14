/* Slack Block Kit payloads — every message shape the bridge sends.

   Pure functions: board facts in, JSON out. Nothing here touches the network
   or the database, which is what makes the whole surface testable before the
   bot token exists — the bridge decides WHEN to send, this decides only WHAT.

   Two rules keep the payloads honest:

     · The web app is the source of truth. Every card links back to it, and
       nothing is stated in a card that isn't read from the board at build
       time — a card is a snapshot, not a subscription.

     · mrkdwn text is escaped. Task names and message content are typed by
       people; "<AE render>" in a task name must arrive as text, not be eaten
       as a broken Slack entity reference. &, <, > are the only characters
       Slack's mrkdwn treats specially. */
'use strict';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// mrkdwn text blocks cap at 3000 chars; a long paste should truncate
// visibly rather than have Slack reject the whole message
const clamp = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const mrkdwn = (text) => ({ type: 'mrkdwn', text: clamp(text, 3000) });

/* The Task Card — the anchoring post a task's thread hangs beneath.
   `task` carries { code, epTitle, taskName, dept, status, assignee, start,
   due, url }: plain strings the bridge reads off the board when it creates
   the thread. */
function taskCard(task) {
  const fields = [
    mrkdwn('*Status*\n' + esc(task.status || '—')),
    mrkdwn('*Owner*\n' + esc(task.assignee || 'Unassigned'))
  ];
  if (task.start && task.due) fields.push(mrkdwn('*Schedule*\n' + esc(task.start) + ' → ' + esc(task.due)));
  if (task.dept) fields.push(mrkdwn('*Department*\n' + esc(task.dept)));
  return {
    text: task.code + ' · ' + task.taskName,          // notification fallback
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: clamp(task.code + ' · ' + task.taskName, 150), emoji: true } },
      { type: 'section', text: mrkdwn('*' + esc(task.epTitle) + '*' + (task.url ? '  ·  <' + task.url + '|Open in Post Pipeline>' : '')) },
      { type: 'section', fields },
      { type: 'context', elements: [mrkdwn('Replies in this thread sync to the task’s discussion in Post Pipeline.')] }
    ]
  };
}

/* A web message mirrored into the thread. Slack shows the bot as the sender,
   so the human author is stated in the text — first, where a glance lands. */
function threadReply(msg) {
  const who = msg.authorName || 'Someone';
  return {
    text: who + ': ' + msg.content,
    blocks: [
      { type: 'section', text: mrkdwn('*' + esc(who) + '*  ' + esc(msg.content)) }
    ]
  };
}

/* A revision divider, mirrored as the spec's "Milestone Divider" — the thread
   continues, the round changes. */
function milestoneDivider(label) {
  return {
    text: label,
    blocks: [
      { type: 'divider' },
      { type: 'context', elements: [mrkdwn('🏁  *' + esc(label) + '*')] }
    ]
  };
}

/* Spec section 3A — the ephemeral prompt when a LucidLink URL appears in a
   Slack message. Ephemeral: only the poster sees it, so declining is free.
   `value` must round-trip through Slack's action payload, hence JSON. */
function pinPrompt(url, taskId) {
  return {
    text: '📌 LucidLink URL detected. Pin to Task References?',
    blocks: [{
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '📌 Pin to Task References', emoji: true },
        action_id: 'pin_lucid_link',
        value: JSON.stringify({ url, taskId })
      }]
    }]
  };
}

/* Spec section 3B — the ephemeral prompt when a task is mentioned in a
   general channel: offer to route the message into that task's thread. */
function routePrompt(taskLabel, taskId, originalText) {
  return {
    text: 'Send this to ' + taskLabel + '’s thread?',
    blocks: [
      { type: 'section', text: mrkdwn('This mentions *' + esc(taskLabel) + '*. Route it into the task’s thread?') },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '➡️ Send to task thread', emoji: true },
          action_id: 'route_to_task',
          value: JSON.stringify({ taskId, text: clamp(String(originalText || ''), 1800) })
        }]
      }
    ]
  };
}

module.exports = { taskCard, threadReply, milestoneDivider, pinPrompt, routePrompt, esc };
