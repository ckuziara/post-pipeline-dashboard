/* Resourcing — the pieces behind the Timeline's Resources mode (js/gantt.js
   resourceRows draws the circles): whose rows a viewer gets, and the person
   panel a Manager plans from — capacity, time off, which productions they're
   on (show teams, with each one's share of them worked out from their tasks), and
   reassigning their open tasks — plus adding a contractor.

   What a viewer sees is an Access Control setting (App.resourceView): 'all'
   is the whole crew, 'team' is their own department. Editing needs Manage
   Resources (App.canManageResources); without it the panel is read-only. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const WEEKS = 8;   // how far ahead the person panel lists open tasks
  const canEdit = () => App.canManageResources(App.state.role);

  // whose rows this viewer gets, after the toolbar's Dept / Owner filters
  function peopleInScope() {
    const scope = App.resourceView(App.state.role);
    const myDept = App.roleDept(App.state.role);
    const meId = App.state.user && App.state.user.personId;
    const f = App.state.filters || {};
    return App.state.data.people.filter(p => {
      const d = App.roleDept(p.role);
      if (!d) return false;   // oversight roles aren't a resource that gets booked
      if (scope === 'team' && !(myDept ? d === myDept : p.id === meId)) return false;
      if (f.dept && f.dept.length && !f.dept.includes(d)) return false;
      if (f.person && f.person.length && !f.person.includes(p.id)) return false;
      return true;
    });
  }

  App.resources = { peopleInScope, openPerson: (id) => openPerson(id), contractorDialog: () => contractorDialog() };

  /* ---- a person: capacity, time off, productions, their tasks ----
     Everything here is a DRAFT until Done: edits redraw only this panel
     (with a live preview of the weeks ahead), and Done saves the lot in one
     change (App.saveResourcePlan) — so nothing behind the panel re-renders
     while you work, and Cancel / Esc simply walks away from the draft. */
  const r1 = (n) => Math.round(n * 10) / 10;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const LEVEL_C = { ok: '#37b679', full: '#f6a609', over: 'var(--danger)' };
  const levelOf = (busy, cap) => cap <= 0 ? (busy > 0 ? 'over' : 'ok') : busy > cap + 0.01 ? 'over' : busy >= cap * 0.8 ? 'full' : 'ok';

  function openPerson(id) {
    const p = App.person(id); if (!p) return;
    const edit = canEdit();
    const canReassign = edit && App.canAssignOwners(App.state.role);
    const dept = App.roleDept(p.role), dep = App.dept(dept);
    const draft = {
      capacity: App.personCapacity(p),
      timeOff: clone(p.timeOff || []),
      shows: App.personShows(id).map(s => s.id),     // the productions they're on (show teams)
      assign: {}
    };
    const saved = JSON.stringify(draft);
    const dirty = () => JSON.stringify(draft) !== saved;
    let adding = false;          // the "add to a production" picker is open

    const mon = App.mondayIso(App.isoDate(App.today()));
    const weeks = [];
    for (let i = 0; i < WEEKS; i++) { const start = App.shiftIso(mon, i * 7); weeks.push({ key: start, start, end: App.shiftIso(start, 4) }); }
    const from = mon, to = App.shiftIso(mon, WEEKS * 7 - 1);
    const mates = App.state.data.people.filter(q => App.roleDept(q.role) === dept);
    const myTasks = [];
    App.activeEpisodes().forEach(ep => App.subitems(ep).forEach(su => {
      if (su.assignee === id && su.status !== 'approved' && su.due >= from && su.start <= to) myTasks.push({ ep, su });
    }));
    myTasks.sort((a, b) => a.su.start < b.su.start ? -1 : 1);

    const gaugeBox = el('.rp-gauge-box');
    const body = el('.modal-body.rp-body');
    const foot = el('.modal-foot.rp-foot');
    const card = el('.modal-card.res-card.rp-card', { onclick: e => e.stopPropagation() }, [
      el('.rp-hero', { style: { '--rp-dept': dep.color } }, [
        el('span.avatar.rp-avatar', { style: { background: p.color } }, App.initials(p.name)),
        el('.rp-id', null, [
          el('.rp-name', null, p.name),
          el('.rp-tags', null, [
            el('span.rp-tag.dept', null, [el('span.dot', { style: { background: dep.color } }), dep.label]),
            p.contractor ? el('span.rp-tag', null, 'Contractor') : null,
            !edit ? el('span.rp-tag', null, 'View only') : null
          ])
        ]),
        gaugeBox,
        el('button.modal-x', { onclick: () => App.modal.close(), title: 'Close' }, '✕')
      ]),
      body, foot
    ]);
    card.querySelector('.rp-hero').style.setProperty('--rp-dept', dep.color);

    const draw = () => {
      const keep = body.scrollTop;
      body.innerHTML = '';
      const pDraft = Object.assign({}, p, { capacity: { daysPerWeek: draft.capacity }, timeOff: draft.timeOff });
      const load = App.resourceLoad([pDraft], weeks, { assign: draft.assign })[id];

      // ---- this week, up in the hero ----
      const now = load[mon], busyNow = Math.max(now.booked, now.planned);
      const lvlNow = levelOf(busyNow, now.cap);
      const pct = now.cap > 0 ? Math.min(100, Math.round(busyNow / now.cap * 100)) : (busyNow > 0 ? 100 : 0);
      gaugeBox.innerHTML = '';
      const g = el('.rp-gauge', null, [el('span', null, [el('b', null, r1(busyNow)), '/' + r1(now.cap) + 'd'])]);
      g.style.setProperty('--rp-p', pct); g.style.setProperty('--rp-c', LEVEL_C[lvlNow]);
      gaugeBox.appendChild(el('.rp-gauge-wrap', { title: 'This week: ' + r1(busyNow) + ' of ' + r1(now.cap) + ' days' }, [g, el('.rp-gauge-lbl', null, 'This week')]));

      // ---- the weeks ahead ----
      body.appendChild(el('.rp-weeks', null, weeks.map((w, i) => {
        const l = load[w.key], busy = Math.max(l.booked, l.planned), lvl = levelOf(busy, l.cap);
        const away = l.days && l.off >= l.days;
        const ratio = l.cap > 0 ? busy / l.cap : (busy > 0 ? 2 : 0);
        const ring = el('.res-ring.rp-ring' + (lvl === 'over' ? '.over' : ''), null,
          [el('.res-disc', { style: { width: (26 * Math.sqrt(Math.min(1, ratio))) + 'px', height: (26 * Math.sqrt(Math.min(1, ratio))) + 'px' } })]);
        ring.style.setProperty('--res-c', LEVEL_C[lvl]);
        return el('.rp-wk' + (i === 0 ? '.now' : '') + (away ? '.away' : ''), {
          title: 'w/c ' + App.fmtDate(w.start) + ' — ' + r1(l.booked) + ' d booked' + (l.planned ? ', ' + r1(l.planned) + ' d planned' : '') +
                 ' of ' + r1(l.cap) + ' d' + (l.off ? ' (' + l.off + ' d off)' : '') + ' · ' + l.tasks.length + ' task' + (l.tasks.length === 1 ? '' : 's')
        }, [
          el('.rp-wk-lbl', null, i === 0 ? 'This wk' : App.fmtDate(w.start)),
          away ? el('.rp-wk-away', null, 'Away') : ring,
          el('.rp-wk-val.' + lvl, null, away ? '—' : r1(busy) + '/' + r1(l.cap))
        ]);
      })));

      // ---- capacity ----
      const setCap = (v) => { draft.capacity = Math.max(0, Math.min(7, Math.round(v * 2) / 2)); draw(); };
      const days = ['M', 'T', 'W', 'T', 'F'].map((d, i) => {
        const fill = Math.max(0, Math.min(1, draft.capacity - i));
        return el('.rp-day' + (edit ? '.click' : ''), { title: edit ? 'Set to ' + (i + 1) + ' day' + (i ? 's' : '') + ' a week' : null, onclick: edit ? () => setCap(i + 1) : null }, [
          el('.rp-day-fill', { style: { width: (fill * 100) + '%' } }), el('span', null, d)
        ]);
      });
      body.appendChild(section('Capacity', null, [
        el('.rp-cap', null, [
          el('.rp-days', null, days),
          edit ? el('.rp-stepper', null, [
            el('button', { onclick: () => setCap(draft.capacity - 0.5), title: 'Half a day less' }, '−'),
            el('span', null, [el('b', null, r1(draft.capacity)), ' days a week']),
            el('button', { onclick: () => setCap(draft.capacity + 0.5), title: 'Half a day more' }, '+')
          ]) : el('.rp-cap-ro', null, [el('b', null, r1(draft.capacity)), ' days a week'])
        ])
      ]));

      // ---- time off ----
      const offs = draft.timeOff.slice().sort((a, b) => a.start < b.start ? -1 : 1);
      const offBody = [el('.rp-chips', null, offs.length ? offs.map(t => el('span.rp-off', null, [
        el('b', null, App.fmtRange(t.start, t.end || t.start)), t.note ? ' · ' + t.note : '',
        edit ? el('button.rp-x', { title: 'Remove', onclick: () => { draft.timeOff = draft.timeOff.filter(x => x !== t); draw(); } }, '✕') : null
      ])) : [el('span.res-none', null, 'No time off booked.')])];
      if (edit) {
        const s = el('input.fld', { type: 'date' }), e = el('input.fld', { type: 'date' }), n = el('input.fld', { type: 'text', placeholder: 'Note (optional)' });
        offBody.push(el('.rp-add', null, [s, el('span', null, 'to'), e, n, el('button.ghost', { onclick: () => {
          if (!s.value || (e.value && e.value < s.value)) { App.toast('Pick the dates', true); return; }
          draft.timeOff.push({ id: App.uid(), start: s.value, end: e.value || s.value, note: n.value.trim() }); draw();
        } }, '＋ Add')]));
      }
      body.appendChild(section('Time off', null, offBody));

      // ---- productions: show teams, and the share of them each one gets ----
      const commit = App.personCommitment(id, from, to, { shows: draft.shows, assign: draft.assign });
      const prodCards = commit.map(c => {
        const lead = !c.offTeam && App.deptLead(c.show, dept) === id;
        const card = el('.rp-prod' + (c.offTeam ? '.off-team' : ''), null, [
          el('.rp-prod-ring', null, [el('span', null, c.pct + '%')]),
          el('.rp-prod-main', null, [
            el('.rp-prod-name', null, [c.show.name, lead ? el('span.rp-lead', null, 'Lead') : null]),
            el('.rp-prod-meta', null, c.tasks
              ? c.tasks + ' open task' + (c.tasks === 1 ? '' : 's') + ' · ' + r1(c.days) + ' of their days'
              : 'No open tasks in the next ' + WEEKS + ' weeks'),
            c.offTeam ? el('.rp-prod-warn', null, 'Has tasks here but isn’t on the production team') : null
          ]),
          edit ? (c.offTeam
            ? el('button.rp-link', { onclick: () => { draft.shows.push(c.showId); draw(); } }, '＋ Add to team')
            : el('button.rp-x', { title: 'Take off this production’s team', onclick: () => { draft.shows = draft.shows.filter(x => x !== c.showId); draw(); } }, '✕')) : null
        ]);
        // custom properties don't go through el()'s style object
        card.style.setProperty('--rp-show', c.show.color);
        card.querySelector('.rp-prod-ring').style.setProperty('--rp-p', c.pct);
        return card;
      });
      // one bar across everything: how they're split, always 100% in total
      const split = commit.length ? el('.rp-split', null, commit.map(c => el('.rp-split-seg', {
        title: c.show.name + ' — ' + c.pct + '%', style: { width: c.pct + '%', background: c.show.color }
      }))) : null;
      const open = App.activeShows().filter(sh => !draft.shows.includes(sh.id) && (!dept || App.showDepts(sh).includes(dept)));
      let picker = null;
      if (edit && adding) {
        picker = el('.rp-picker', null, open.length ? open.map(sh => {
          const b = el('button.rp-pick', { onclick: () => { draft.shows.push(sh.id); adding = false; draw(); } },
            [el('span.dot', { style: { background: sh.color } }), sh.name]);
          b.style.setProperty('--rp-show', sh.color);
          return b;
        }) : [el('span.res-none', null, 'They’re on every production that has ' + dep.label + ' work.')]);
      }
      body.appendChild(section('Productions', edit ? el('button.rp-link', { onclick: () => { adding = !adding; draw(); } }, adding ? 'Done adding' : '＋ Add to a production') : null,
        [split].concat(prodCards.length ? prodCards : [el('span.res-none', null, 'Not on any production team.')]).concat(picker ? [picker] : [])));

      // ---- open tasks ----
      const taskRows = myTasks.map(({ ep, su }) => {
        const k = ep.id + '::' + su.key;
        const moved = k in draft.assign;
        const st = App.status(su.status);
        let who = null;
        if (canReassign) {
          who = el('select.fld.rp-who', { onchange: (e) => {
            const v = e.target.value || null;
            if (v === id) delete draft.assign[k]; else draft.assign[k] = v;
            draw();
          } });
          [['', 'Unassigned']].concat(mates.map(q => [q.id, q.name])).forEach(([v, l]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = l;
            if (v === (moved ? (draft.assign[k] || '') : id)) o.selected = true;
            who.appendChild(o);
          });
        }
        const q = moved && draft.assign[k] ? App.person(draft.assign[k]) : null;
        return el('.rp-task' + (moved ? '.moved' : ''), { style: { borderLeftColor: App.dept(su.dept).color } }, [
          el('.rp-task-main', null, [
            el('.rp-task-name', null, [el('b', null, ep.code), ' ' + su.name]),
            el('.rp-task-meta', null, [
              App.fmtRange(su.start, su.due),
              moved ? el('span.rp-moved', null, '→ ' + (q ? q.name : 'Unassigned')) : null
            ])
          ]),
          el('span.res-pill', { style: { background: st.color, color: st.ink } }, st.label),
          who
        ]);
      });
      body.appendChild(section('Open tasks', App.fmtRange(from, to), taskRows.length ? taskRows : [el('span.res-none', null, 'No open tasks in the next ' + WEEKS + ' weeks.')]));

      // ---- footer ----
      foot.innerHTML = '';
      if (edit) {
        foot.appendChild(el('span.rp-dirty' + (dirty() ? '.on' : ''), null, dirty() ? 'Unsaved changes' : 'No changes'));
        foot.appendChild(el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Cancel'));
        foot.appendChild(el('button.btn-primary', { onclick: () => {
          if (dirty() && !App.saveResourcePlan(id, draft)) return;
          App.modal.close();
        } }, 'Done'));
      } else {
        foot.appendChild(el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Close'));
      }
      body.scrollTop = keep;
    };

    draw();
    App.modal.open(card);
    // the modal focuses its first field; here that's a time-off date, which
    // isn't where anyone starts — leave focus on the panel instead
    setTimeout(() => { if (card.contains(document.activeElement)) document.activeElement.blur(); }, 40);
  }

  function section(title, aside, body) {
    return el('.rp-sec', null, [
      el('.rp-sec-head', null, [el('.res-sec-title', null, title), aside == null ? null : typeof aside === 'string' ? el('span.rp-sec-aside', null, aside) : aside])
    ].concat(body));
  }

  function contractorDialog() {
    const name = el('input.fld', { type: 'text', placeholder: 'Name, or a placeholder like “Freelance animator 1”' });
    const role = el('select.fld');
    App.ROLES.filter(r => r.dept).forEach(r => { const o = document.createElement('option'); o.value = r.key; o.textContent = r.label; role.appendChild(o); });
    const myRole = App.role(App.state.role); if (myRole.dept) role.value = myRole.key;
    App.modal.open(el('.modal-card.res-card', { onclick: ev => ev.stopPropagation() }, [
      el('.modal-head', null, [el('.modal-head-main', null, [el('div', null, [
        el('.modal-title', null, 'Add a contractor'),
        el('.modal-subtitle', null, 'For planning and task ownership — no sign-in')])]),
        el('button.modal-x', { onclick: () => App.modal.close(), title: 'Close' }, '✕')]),
      el('.modal-body', null, [fieldRow('Name', name), fieldRow('Department', role)]),
      el('.modal-foot', null, [
        el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Cancel'),
        el('button.btn-primary', { onclick: () => { if (name.value.trim()) App.modal.close(); App.addContractor(name.value, role.value); } }, 'Add')
      ])
    ]));
  }

  function fieldRow(label, control) {
    return el('.field', null, [el('label.fld-label', null, label), control]);
  }
})();
