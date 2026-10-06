/* Resourcing — the pieces behind the Timeline's Resources mode (js/gantt.js
   resourceRows draws the circles): whose rows a viewer gets, and the person
   panel a Manager plans from — capacity, time off, allocations to shows, and
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

  /* ---- a person: capacity, time off, allocations, their tasks ---- */
  function openPerson(id) {
    const p = App.person(id); if (!p) return;
    const edit = canEdit();
    const reassign = edit && App.canAssignOwners(App.state.role);
    const reopen = () => setTimeout(() => openPerson(id), 0);
    const dept = App.roleDept(p.role);
    const sections = [];

    // capacity
    const capFld = el('input.fld', { type: 'number', min: '0', max: '7', step: '0.5', value: App.personCapacity(p), disabled: !edit, style: { maxWidth: '90px' } });
    if (edit) capFld.addEventListener('change', () => { App.setCapacity(id, capFld.value); reopen(); });
    sections.push(section('Capacity', [el('.res-inline', null, [capFld, el('span', null, 'days a week')])]));

    // time off
    const offRows = (p.timeOff || []).slice().sort((a, b) => a.start < b.start ? -1 : 1).map(t =>
      el('.res-row', null, [
        el('span', null, App.fmtRange(t.start, t.end) + (t.note ? ' — ' + t.note : '')),
        edit ? el('button.ghost.res-x', { onclick: () => { App.removePersonTimeOff(id, t.id); reopen(); }, title: 'Remove' }, '✕') : null
      ]));
    if (edit) {
      const s = el('input.fld', { type: 'date' }), e = el('input.fld', { type: 'date' }), n = el('input.fld', { type: 'text', placeholder: 'Note (optional)' });
      offRows.push(el('.res-inline', null, [s, el('span', null, 'to'), e, n,
        el('button.ghost', { onclick: () => { App.addPersonTimeOff(id, s.value, e.value || s.value, n.value); reopen(); } }, 'Add')]));
    }
    sections.push(section('Time off', offRows.length ? offRows : [el('.res-none', null, 'None booked.')]));

    // allocations
    const allocs = (App.state.data.allocations || []).filter(a => a.personId === id).sort((a, b) => a.start < b.start ? -1 : 1);
    const allocRows = allocs.map(a => el('.res-row', null, [
      el('span.res-swatch', { style: { background: App.show(a.showId).color } }),
      el('span', null, App.show(a.showId).name + ' — ' + a.pct + '% · ' + App.fmtRange(a.start, a.end)),
      edit ? el('button.ghost.res-x', { onclick: () => allocDialog(id, a), title: 'Edit' }, '✎') : null,
      edit ? el('button.ghost.res-x', { onclick: () => { App.removeAllocation(a.id); reopen(); }, title: 'Remove' }, '✕') : null
    ]));
    if (edit) allocRows.push(el('button.ghost', { onclick: () => allocDialog(id, null) }, '＋ Allocate to a show'));
    sections.push(section('Allocations', allocRows.length ? allocRows : [el('.res-none', null, 'Not allocated to a show.')]));

    // their open tasks in the visible range
    const from = App.mondayIso(App.isoDate(App.today())), to = App.shiftIso(from, WEEKS * 7 - 1);
    const mates = App.state.data.people.filter(q => App.roleDept(q.role) === dept);
    const tasks = [];
    App.activeEpisodes().forEach(ep => App.subitems(ep).forEach(su => {
      if (su.assignee === id && su.status !== 'approved' && su.due >= from && su.start <= to) tasks.push({ ep, su });
    }));
    tasks.sort((a, b) => a.su.start < b.su.start ? -1 : 1);
    const taskRows = tasks.map(({ ep, su }) => {
      let who = null;
      if (reassign) {
        who = el('select.fld.res-who', { onchange: (e) => { if (App.reassignTask(ep.id, su.key, e.target.value || null)) reopen(); } });
        [['', 'Unassigned']].concat(mates.map(q => [q.id, q.name])).forEach(([v, l]) => {
          const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === id) o.selected = true; who.appendChild(o);
        });
      }
      return el('.res-row', null, [
        el('span.res-task', null, [el('b', null, ep.code), ' ' + su.name]),
        el('span.res-dates', null, App.fmtRange(su.start, su.due)),
        el('span.res-pill', { style: { background: App.status(su.status).color, color: App.status(su.status).ink } }, App.status(su.status).label),
        who
      ]);
    });
    sections.push(section('Open tasks, ' + App.fmtRange(from, to), taskRows.length ? taskRows : [el('.res-none', null, 'No open tasks in this range.')]));

    App.modal.open(el('.modal-card.res-card', { onclick: e => e.stopPropagation() }, [
      el('.modal-head', null, [
        el('.modal-head-main', null, [
          el('span.avatar', { style: { width: '28px', height: '28px', fontSize: '11px', background: p.color } }, App.initials(p.name)),
          el('div', null, [el('.modal-title', null, p.name),
            el('.modal-subtitle', null, App.role(p.role).label + (p.contractor ? ' · Contractor' : ''))])
        ]),
        el('button.modal-x', { onclick: () => App.modal.close(), title: 'Close' }, '✕')
      ]),
      el('.modal-body', null, sections),
      el('.modal-foot', null, [el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Done')])
    ]));
  }

  function section(title, body) {
    return el('.res-sec', null, [el('.res-sec-title', null, title)].concat(body));
  }

  function allocDialog(personId, a) {
    const show = el('select.fld');
    App.activeShows().forEach(s => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; show.appendChild(o); });
    if (a) show.value = a.showId;
    const today = App.isoDate(App.today());
    const pct = el('input.fld', { type: 'number', min: '1', max: '100', value: a ? a.pct : 100, style: { maxWidth: '90px' } });
    const s = el('input.fld', { type: 'date', value: a ? a.start : today });
    const e = el('input.fld', { type: 'date', value: a ? a.end : App.shiftIso(s.value, 27) });
    const back = () => setTimeout(() => openPerson(personId), 0);
    App.modal.open(el('.modal-card.res-card', { onclick: ev => ev.stopPropagation() }, [
      el('.modal-head', null, [el('.modal-head-main', null, [el('div', null, [
        el('.modal-title', null, a ? 'Edit allocation' : 'Allocate to a show'),
        el('.modal-subtitle', null, App.person(personId).name)])]),
        el('button.modal-x', { onclick: back, title: 'Back' }, '✕')]),
      el('.modal-body', null, [
        fieldRow('Show', show), fieldRow('Share of their week', el('.res-inline', null, [pct, el('span', null, '%')])),
        fieldRow('From', s), fieldRow('To', e)
      ]),
      el('.modal-foot', null, [
        el('button.btn-ghost', { onclick: back }, 'Cancel'),
        el('button.btn-primary', { onclick: () => {
          App.saveAllocation({ id: a && a.id, personId, showId: show.value, pct: pct.value, start: s.value, end: e.value });
          back();
        } }, 'Save')
      ])
    ]));
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
