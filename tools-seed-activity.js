/* Regenerates the local demo activity log (dev only — data/ is gitignored).
   Produces usage, audit, error and flow events with deliberate trends so the
   analytics page has something honest-looking to render. Delete
   data/activity.json instead if you want a clean slate. */
const fs = require('fs');
let seed = 1337;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rnd() * a.length)];

const DEPT = { producer:null, manager:null, director:null, creative:'creative',
  animation:'animation', audio:'audio', video:'video', ops:'ops', qc:'qc' };
const people = {
  producer:['chris.kuziara@moonbug.com'], manager:['sam.reyes@moonbug.com'],
  director:['alex.rivera@moonbug.com'], creative:['maya.chen@moonbug.com','tom.okafor@moonbug.com'],
  animation:['diego.santos@moonbug.com','lena.vyas@moonbug.com'], audio:['chris.k@moonbug.com'],
  video:['noah.kim@moonbug.com'], ops:['ravi.patel@moonbug.com'], qc:['grace.lin@moonbug.com']
};
// growth <1 = adoption fading, >1 = sticking
const profile = {
  producer:{base:15,growth:1.3,feats:[['view.timeline',5],['task.editDialog',3],['view.board',2],['view.dashboard',2],['timeline.dragReschedule',3],['admin.logs',1]]},
  manager:{base:9,growth:1.7,feats:[['view.dashboard',5],['admin.directory',2],['view.timeline',2],['admin.roles',1]]},
  director:{base:6,growth:0.65,feats:[['view.review',4],['task.editDialog',2],['view.board',2]]},
  creative:{base:13,growth:0.6,feats:[['view.board',6],['task.editDialog',4],['view.timeline',1],['note.add',1]]},
  animation:{base:10,growth:1.15,feats:[['view.board',5],['task.editDialog',3],['view.timeline',1]]},
  audio:{base:8,growth:1.0,feats:[['view.board',4],['task.editDialog',2],['lucidlink.delivered',1]]},
  video:{base:5,growth:1.4,feats:[['view.board',3],['task.editDialog',1],['lucidlink.delivered',1]]},
  ops:{base:9,growth:2.2,feats:[['view.timeline',5],['timeline.dragReschedule',4],['lucidlink.delivered',2],['view.board',1]]},
  qc:{base:4,growth:0.85,feats:[['view.board',2],['task.editDialog',1]]}
};
// flow name → [abandon rate early, abandon rate late], median seconds, error rate
const flows = {
  'Task edit':        { rate:[0.34,0.22], secs:38,  err:0 },
  'Create show':      { rate:[0.55,0.41], secs:210, err:0 },
  'User provisioning':{ rate:[0.62,0.58], secs:74,  err:0 },
  'LucidLink delivery':{ rate:[0.18,0.12], secs:96, err:0.14 }
};
const flowRole = {
  'Task edit':['creative','animation','audio','video','qc','producer'],
  'Create show':['producer','manager'],
  'User provisioning':['producer','manager'],
  'LucidLink delivery':['ops','audio','video']
};
const audits = [
  ['task.status', () => ({ episode:'LA-10'+(1+Math.floor(rnd()*4)), task:pick(['Animatic V1','Design','Scripts','VO Records']), from:'ready', to:'in_progress' })],
  ['task.reschedule', () => ({ episode:'BW-30'+(7+Math.floor(rnd()*2)), task:pick(['Layout','Blocking','Wallah V1']), from:'2026-07-01→2026-07-05', to:'2026-07-03→2026-07-07', brokeDependency:false })],
  ['note.add', () => ({ show:pick(['Little Angel','CoComelon','Blippi Wonders']) })]
];

const rows = [], DAYS = 60, now = Date.now();
const push = (t, role, kind, action, detail) => rows.push({
  ts: t.toISOString(), email: pick(people[role]), role, dept: DEPT[role], kind, action, detail: detail || {}
});

for (let d = DAYS - 1; d >= 0; d--) {
  const day = new Date(now - d * 86400000), dow = day.getUTCDay();
  if (dow === 0 || dow === 6) continue;                     // weekdays only
  const prog = (DAYS - d) / DAYS;
  const at = (h) => { const t = new Date(day); t.setUTCHours(h, Math.floor(rnd()*60), Math.floor(rnd()*60), 0); return t; };

  for (const role of Object.keys(profile)) {
    const p = profile[role];
    const vol = Math.max(0, Math.round(p.base * (1 + (p.growth - 1) * prog) * (0.6 + rnd()*0.8)));
    const pool = p.feats.flatMap(([f, w]) => Array(w).fill(f));
    // cluster a person's events into 1-2 sittings so session lengths are realistic
    const sittings = 1 + (rnd() < 0.45 ? 1 : 0);
    for (let sN = 0; sN < sittings; sN++) {
      const startH = 8 + Math.floor(rnd() * 8);
      const per = Math.ceil(vol / sittings);
      for (let i = 0; i < per; i++) {
        const t = at(startH); t.setUTCMinutes(t.getUTCMinutes() + Math.floor(rnd() * 22));
        push(t, role, 'usage', pick(pool));
        if (rnd() < 0.17) { const [a, mk] = pick(audits); push(t, role, 'audit', a, mk()); }
      }
    }
  }

  // flows: start → complete (timed) or abandon; LucidLink also fails sometimes
  for (const name of Object.keys(flows)) {
    const cfg = flows[name];
    const attempts = Math.max(0, Math.round((2 + rnd() * 4) * (0.7 + prog * 0.6)));
    const abRate = cfg.rate[0] + (cfg.rate[1] - cfg.rate[0]) * prog;   // friction easing over time
    for (let i = 0; i < attempts; i++) {
      const role = pick(flowRole[name]);
      const t = at(9 + Math.floor(rnd() * 8));
      push(t, role, 'usage', 'flow.start', { flow: name });
      const t2 = new Date(t);
      if (rnd() < cfg.err) {                                  // failed outright
        t2.setUTCSeconds(t2.getUTCSeconds() + 8 + Math.floor(rnd() * 20));
        push(t2, role, 'error', 'lucidlink.uploadFailed', { flow: name, message: 'connection reset' });
        push(t2, role, 'usage', 'flow.abandon', { flow: name, reason: 'upload failed' });
      } else if (rnd() < abRate) {                            // walked away
        t2.setUTCSeconds(t2.getUTCSeconds() + 5 + Math.floor(rnd() * 40));
        push(t2, role, 'usage', 'flow.abandon', { flow: name });
      } else {                                                // completed, timed
        const ms = Math.round(cfg.secs * 1000 * (0.5 + rnd() * 1.6) * (1 - 0.18 * prog));
        t2.setUTCMilliseconds(t2.getUTCMilliseconds() + ms);
        push(t2, role, 'usage', 'flow.complete', { flow: name, ms });
      }
    }
  }
}
rows.sort((a, b) => a.ts < b.ts ? -1 : 1);
fs.writeFileSync('data/activity.json', JSON.stringify(rows));
const k = {}; rows.forEach(r => { k[r.kind] = (k[r.kind]||0)+1; });
console.log('seeded', rows.length, 'rows', JSON.stringify(k));
console.log('span', rows[0].ts.slice(0,10), '→', rows[rows.length-1].ts.slice(0,10));
