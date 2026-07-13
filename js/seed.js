/* Demo data. Mirrors how a Monday board feeds the app: shows, people (roles +
   departments they cover), and episodes. Each episode expands into the 27-subitem
   TEMPLATE (see state.js). Episode 1 of Little Angel is the EXACT reference board;
   the rest are staggered in time and have dependency-valid statuses derived from "today".
   Replace App.seedData() with a Monday sync later. */
window.App = window.App || {};
(function () {
  'use strict';

  const PALETTE = ['#e8615b', '#f6a609', '#37b679', '#2d9cdb', '#9b59b6',
                   '#16a085', '#e67e22', '#d6457f', '#4b6bfb', '#0f9d8f',
                   '#c0392b', '#7f8c8d'];

  App.seedData = function () {
    const shows = [
      { id: 'la',   name: 'Little Angel',    prefix: 'LA', color: '#ff6f9c' },
      { id: 'cm',   name: 'CoComelon',       prefix: 'CM', color: '#6cc24a' },
      { id: 'bw',   name: 'Blippi Wonders',  prefix: 'BW', color: '#f6be00' },
      { id: 'mo',   name: 'Morphle',         prefix: 'MO', color: '#a06cd5' }
    ];

    // Each person's role is one of App.ROLES. Department staff carry a department role
    // (creative/music/animation/audio/video/ops/qc); their role key IS the department.
    const people = [
      { id: 'jordan', name: 'Jordan Blake',  role: 'producer' },
      { id: 'sam',    name: 'Sam Reyes',     role: 'manager' },
      { id: 'alex',   name: 'Alex Rivera',   role: 'director' },
      { id: 'maya',   name: 'Maya Chen',     role: 'creative' },
      { id: 'tom',    name: 'Tom Okafor',    role: 'creative' },
      { id: 'priya',  name: 'Priya Nair',    role: 'music' },
      { id: 'diego',  name: 'Diego Santos',  role: 'animation' },
      { id: 'lena',   name: 'Lena Vyas',     role: 'animation' },
      { id: 'chris',  name: 'Chris Kuziara', role: 'audio' },
      { id: 'noah',   name: 'Noah Kim',      role: 'video' },
      { id: 'ravi',   name: 'Ravi Patel',    role: 'ops' },
      { id: 'grace',  name: 'Grace Lin',     role: 'qc' }
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
      ['la', 101, "Joe's Little Angel",  0,    true ],
      ['la', 102, 'Jo Jo Melon',         21,   false],
      ['la', 103, 'Counting Sheep',     -70,   false],
      ['la', 104, 'Rainy Day Friends', -119,   false],
      ['cm', 211, 'Bath Song Remix',   -112,   false],
      ['cm', 212, 'Apple Picking Day',  -49,   false],
      ['cm', 213, 'Wheels on the Bus',   35,   false],
      ['bw', 307, 'Volcano Adventure', -126,   false],
      ['bw', 308, 'Deep Sea Dive',      -28,   false],
      ['bw', 309, 'Space Station Tour',  14,   false],
      ['mo', 410, 'Pet Parade',         -91,   false]
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
