/* Demo data. Mirrors how a Monday board feeds the app: shows, people (roles +
   departments they cover), and episodes. Episode 1 of Show Alpha is the EXACT
   reference board; the rest are staggered in time and have dependency-valid
   statuses derived from "today".
   Replace App.seedData() with a Monday sync later. */
window.App = window.App || {};
(function () {
  'use strict';

  const PALETTE = ['#e8615b', '#f6a609', '#37b679', '#2d9cdb', '#9b59b6',
                   '#16a085', '#e67e22', '#d6457f', '#4b6bfb', '#0f9d8f',
                   '#c0392b', '#7f8c8d'];

  App.seedData = function () {
    const shows = [
      { id: 'sa',   name: 'Show Alpha',      prefix: 'SA', color: '#ff6f9c' },
      { id: 'sb',   name: 'Show Bravo',      prefix: 'SB', color: '#6cc24a' },
      { id: 'sc',   name: 'Show Charlie',    prefix: 'SC', color: '#f6be00' },
      { id: 'sd',   name: 'Show Delta',      prefix: 'SD', color: '#a06cd5' }
    ];

    // Each person's role is one of App.ROLES. Department staff carry a department role
    // (creative/music/animation/audio/video/ops/qc); their role key IS the department.
    const people = [
      { id: 'p1',  name: 'Jordan Blake',  role: 'producer' },
      { id: 'p2',  name: 'Sam Reyes',     role: 'manager' },
      { id: 'p3',  name: 'Alex Rivera',   role: 'director' },
      { id: 'p4',  name: 'Maya Chen',     role: 'creative' },
      { id: 'p5',  name: 'Tom Okafor',    role: 'creative' },
      { id: 'p6',  name: 'Priya Nair',    role: 'music' },
      { id: 'p7',  name: 'Diego Santos',  role: 'animation' },
      { id: 'p8',  name: 'Lena Vyas',     role: 'animation' },
      { id: 'p9',  name: 'Casey Turner',  role: 'audio' },
      { id: 'p10', name: 'Noah Kim',      role: 'video' },
      { id: 'p11', name: 'Ravi Patel',    role: 'ops' },
      { id: 'p12', name: 'Grace Lin',     role: 'qc' }
    ];
    people.forEach((p, i) => { p.color = PALETTE[i % PALETTE.length]; });

    // department -> eligible staff ids (round-robin per episode for variety)
    const byDept = {};
    people.forEach(p => { const d = App.roleDept(p.role); if (d) (byDept[d] = byDept[d] || []).push(p.id); });
    const assigneesFor = (epIndex) => {
      const map = {};
      App.TEMPLATE.forEach(t => {
        const pool = byDept[t.dept] || [];
        if (pool.length) map[t.key] = pool[epIndex % pool.length];
      });
      return map;
    };

    // exact board statuses for Episode 1 (transcribed from the reference)
    const ep1Statuses = {};
    App.TEMPLATE.forEach(t => { ep1Statuses[t.key] = t.status; });

    // The reference plan was authored around DEMO_TODAY; shifting every episode
    // by (real today − DEMO_TODAY) keeps the same past/present/future spread on
    // any date the app is opened.
    const anchor = App.diffDays(App.isoDate(App.today()), App.DEMO_TODAY);

    // (showId, num, title, shiftDays, useExact?)
    const plan = [
      ['sa', 101, 'Episode One',        0,    true ],
      ['sa', 102, 'Episode Two',        21,   false],
      ['sa', 103, 'Episode Three',     -70,   false],
      ['sa', 104, 'Episode Four',     -119,   false],
      ['sb', 211, 'Episode One',      -112,   false],
      ['sb', 212, 'Episode Two',       -49,   false],
      ['sb', 213, 'Episode Three',      35,   false],
      ['sc', 307, 'Episode One',      -126,   false],
      ['sc', 308, 'Episode Two',       -28,   false],
      ['sc', 309, 'Episode Three',      14,   false],
      ['sd', 410, 'Episode One',       -91,   false]
    ];

    const episodes = plan.map((row, i) => {
      const [showId, num, title, planShift, useExact] = row;
      const shiftDays = planShift + anchor;
      const show = shows.find(s => s.id === showId);
      return {
        id: App.uid(),
        showId,
        code: show.prefix + '-' + num,
        title,
        index: i,
        shiftDays,
        statuses: useExact ? ep1Statuses : App.deriveStatuses(shiftDays),
        assignees: assigneesFor(i)
      };
    });

    return { shows, people, episodes };
  };
})();
