/* ===== Trip engine: handicaps, net scoring, team games, skins, money ===== */
var Engine = (function () {
  var MAX_HCP = 18;
  var SEGMENTS = [
    { key: 'F', game: 'sides', label: 'Front 9', from: 1, to: 9 },
    { key: 'B', game: 'sides', label: 'Back 9', from: 10, to: 18 },
    { key: 'T', game: 'sides', label: 'Total 18', from: 1, to: 18 },
    { key: 'S1', game: 'six', label: 'Holes 1–6', from: 1, to: 6 },
    { key: 'S2', game: 'six', label: 'Holes 7–12', from: 7, to: 12 },
    { key: 'S3', game: 'six', label: 'Holes 13–18', from: 13, to: 18 }
  ];

  function isScore(v) { return typeof v === 'number' && isFinite(v) && v >= 1 && v <= 20 && Math.floor(v) === v; }

  // Strokes received on a hole with stroke index si (1 = hardest) for handicap h.
  function strokesOn(h, si) {
    if (!h || h <= 0) return 0;
    var full = Math.floor(h / 18), rem = h % 18;
    return full + (si <= rem ? 1 : 0);
  }

  // Team-game points for a player's GROSS score relative to par (handicaps never apply).
  function pointsFor(netDiff) {
    if (netDiff <= -2) return 8;
    if (netDiff === -1) return 5;
    if (netDiff === 0) return 3;
    if (netDiff === 1) return 2;
    if (netDiff === 2) return 1;
    return 0;
  }

  // Split an integer number of cents across weights so the parts sum exactly to the pool.
  function allocateCents(poolCents, weights) {
    var ids = Object.keys(weights).filter(function (k) { return weights[k] > 0; });
    var out = {};
    Object.keys(weights).forEach(function (k) { out[k] = 0; });
    var total = ids.reduce(function (s, k) { return s + weights[k]; }, 0);
    if (!ids.length || total <= 0) return out;
    var rema = [], used = 0;
    ids.forEach(function (k) {
      var exact = poolCents * weights[k] / total;
      var fl = Math.floor(exact + 1e-9);
      out[k] = fl; used += fl;
      rema.push({ k: k, r: exact - fl });
    });
    rema.sort(function (a, b) { return b.r - a.r || (a.k < b.k ? -1 : 1); });
    for (var i = 0; used < poolCents && i < rema.length; i++, used++) out[rema[i].k] += 1;
    return out;
  }

  // Returns a plain-English problem with a course card, or null when it is usable.
  function courseProblem(c) {
    if (!c) return 'No course picked for this day.';
    var par = c.par || [], si = c.si || [];
    if (par.length !== 18 || !par.every(function (p) { return p >= 3 && p <= 6 && Math.floor(p) === p; })) return 'Every hole needs a par of 3, 4, 5 or 6.';
    var seen = {};
    for (var i = 0; i < 18; i++) {
      var v = si[i];
      if (!(v >= 1 && v <= 18 && Math.floor(v) === v)) return 'Every hole needs a stroke index from 1 to 18.';
      if (seen[v]) return 'Stroke index ' + v + ' is used twice. Each number 1–18 must appear once.';
      seen[v] = 1;
    }
    return null;
  }

  function dayPlayers(day) {
    var ids = [];
    (day.groups || []).forEach(function (g) { (g.playerIds || []).forEach(function (p) { if (p && ids.indexOf(p) < 0) ids.push(p); }); });
    return ids;
  }

  // "7:50", "10:09", "1:05 pm" -> minutes after midnight (bare 1:00–5:59 read as afternoon). Blank -> Infinity.
  function timeValue(t) {
    var m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i);
    if (!m) return Infinity;
    var hh = +m[1], mm = +m[2], ap = (m[3] || '').toLowerCase();
    if (ap.charAt(0) === 'p' && hh < 12) hh += 12;
    else if (ap.charAt(0) === 'a' && hh === 12) hh = 0;
    else if (!ap && hh >= 1 && hh <= 5) hh += 12;
    return hh * 60 + mm;
  }

  // Trip standings from finished rounds in results[0..upto): most rounds, lowest total, lower latest round, then name.
  function standings(state, results, upto) {
    var rows = (state.players || []).map(function (p) {
      var g = 0, n = 0, last = null;
      results.forEach(function (r, i) {
        if (upto != null && i >= upto) return;
        var v = r.gross[p.id]; if (v != null) { g += v; n++; last = v; }
      });
      return { id: p.id, name: p.name, total: g, rounds: n, last: last };
    });
    rows.sort(function (a, b) {
      return b.rounds - a.rounds || a.total - b.total || (a.last == null ? 0 : a.last) - (b.last == null ? 0 : b.last) || a.name.localeCompare(b.name);
    });
    return rows;
  }

  // Tee-sheet foursomes set by trip total: lowest four in the earliest tee time.
  // Only decides who plays with whom. Teams for sides and 6-6-6 stay as set in day.groups.
  function autoGroups(state, results, day, idx) {
    var playing = dayPlayers(day);
    var order = standings(state, results, idx).map(function (x) { return x.id; })
      .filter(function (id) { return !playing.length || playing.indexOf(id) >= 0; });
    var times = (day.teeSlots || []).map(function (t) { return t || ''; })
      .sort(function (a, b) { return timeValue(a) - timeValue(b); });
    var groups = [];
    for (var k = 0; k * 4 < order.length; k++) {
      groups.push({ id: 'auto' + (k + 1), name: 'Group ' + (k + 1), time: times[k] || '', playerIds: order.slice(k * 4, k * 4 + 4) });
    }
    return groups;
  }

  // The Snake: the last man (highest hole number) to 3-putt, among men who haven't had it yet this trip.
  // Everyone who 3-putts that same hole is a Snake. Final once every card is in.
  function snakeFor(r, day, exempt) {
    var tp = day.threePutts || {}, best = -1, holders = [], putts = {};
    r.players.forEach(function (id) {
      var holes = (tp[id] || []).filter(function (x) { return x >= 0 && x < 18 && Math.floor(x) === x; });
      holes = holes.filter(function (x, i) { return holes.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
      putts[id] = holes;
      if (exempt[id]) return;
      holes.forEach(function (x) {
        if (x > best) { best = x; holders = [id]; } else if (x === best && holders.indexOf(id) < 0) holders.push(id);
      });
    });
    return { hole: best >= 0 ? best + 1 : null, ids: holders, resolved: r.status === 'final', putts: putts,
      exempt: Object.keys(exempt).filter(function (id) { return exempt[id]; }) };
  }

  function computeDay(state, dayIdx, prev, day, pairings) {
    day = day || state.days[dayIdx];
    var course = (state.courses || []).find(function (c) { return c.id === day.courseId; }) || null;
    var par = course ? course.par : null, si = course ? course.si : null;
    var pmap = {}; (state.players || []).forEach(function (p) { pmap[p.id] = p; });
    // Who plays: the teams, plus (on a day grouped by trip total) everyone in the foursomes, so scoring works before teams are set.
    var ids = dayPlayers(day).filter(function (id) { return pmap[id]; });
    (pairings || []).forEach(function (g) { g.playerIds.forEach(function (id) { if (pmap[id] && ids.indexOf(id) < 0) ids.push(id); }); });
    var stakes = state.stakes;
    var r = {
      idx: dayIdx, day: day, course: course, players: ids, hcp: {}, gross: {}, net: {}, thru: {},
      complete: {}, strokes: {}, netScores: {}, points: {}, birdies: {}, eagles: {}, sandys: {}, sandyHoles: {},
      teams: [], segments: [], skins: [], skinsWon: {}, sidesUnits: {}, sixUnits: {}, sbeUnits: {},
      pots: null, pay: null, status: 'upcoming', medalists: [], lowGross: null, holesEntered: 0,
      groups: day.groups || [], auto: null
    };

    // ---- handicaps (skins only), never more than MAX_HCP
    ids.forEach(function (id) {
      var ov = day.hcpOverride && day.hcpOverride[id];
      var tierDefault = Number((state.tierHcp || {})[pmap[id].tier]) || 0;
      if (typeof ov === 'number' && isFinite(ov)) { r.hcp[id] = { value: ov, source: 'override', provisional: false }; return; }
      if (!prev) { r.hcp[id] = { value: tierDefault, source: 'tier', provisional: false }; return; }
      if (prev.complete[id] && prev.lowGross != null) {
        r.hcp[id] = { value: prev.gross[id] - prev.lowGross, source: 'reset', provisional: prev.status !== 'final' };
      } else if (prev.hcp[id]) {
        r.hcp[id] = { value: prev.hcp[id].value, source: 'carry', provisional: prev.hcp[id].provisional || prev.status !== 'final' };
      } else if (prev.carryHcp && prev.carryHcp[id]) {
        r.hcp[id] = { value: prev.carryHcp[id].value, source: 'carry', provisional: prev.carryHcp[id].provisional };
      } else {
        r.hcp[id] = { value: tierDefault, source: 'tier', provisional: false };
      }
    });
    ids.forEach(function (id) { var hv = r.hcp[id]; hv.value = Math.max(0, Math.min(MAX_HCP, Math.round(hv.value))); });
    // carry handicaps forward for players who sit out this day
    r.carryHcp = {};
    if (prev) {
      Object.keys(prev.hcp).forEach(function (id) { if (!r.hcp[id]) r.carryHcp[id] = prev.hcp[id]; });
      Object.keys(prev.carryHcp || {}).forEach(function (id) { if (!r.hcp[id] && !r.carryHcp[id]) r.carryHcp[id] = prev.carryHcp[id]; });
    }

    r.courseError = courseProblem(course);
    if (r.courseError) return r;

    // ---- per-player scoring
    var anyScore = false, allDone = ids.length > 0;
    ids.forEach(function (id) {
      var sc = (day.scores && day.scores[id]) || [];
      var h = r.hcp[id].value;
      var st = [], ns = [], pts = [], g = 0, thru = 0, b = 0, e = 0;
      for (var i = 0; i < 18; i++) {
        var s = sc[i];
        var k = strokesOn(h, si[i]);
        st.push(k);
        if (isScore(s)) {
          anyScore = true; thru++; g += s;
          var n = s - k; ns.push(n); pts.push(pointsFor(s - par[i]));
          var gd = s - par[i]; if (gd === -1) b++; else if (gd <= -2) e++;
        } else { ns.push(null); pts.push(null); }
      }
      r.strokes[id] = st; r.netScores[id] = ns; r.points[id] = pts; r.thru[id] = thru;
      r.complete[id] = thru === 18;
      r.gross[id] = thru === 18 ? g : null;
      r.net[id] = thru === 18 ? g - h : null;
      r.birdies[id] = b; r.eagles[id] = e;
      // Sandys: per-hole marks when present (the count is the number of holes marked), else a legacy daily count.
      var sh = (day.sandyHoles || {})[id];
      if (Array.isArray(sh)) {
        sh = sh.filter(function (x, k) { return x >= 0 && x < 18 && Math.floor(x) === x && sh.indexOf(x) === k; }).sort(function (a, b) { return a - b; });
        r.sandyHoles[id] = sh; r.sandys[id] = sh.length;
      } else {
        r.sandyHoles[id] = []; r.sandys[id] = Math.max(0, Math.floor(Number((day.sandys || {})[id]) || 0));
      }
      r.holesEntered += thru;
      if (thru !== 18) allDone = false;
    });
    r.status = allDone ? 'final' : (anyScore ? 'live' : 'upcoming');

    var done = ids.filter(function (id) { return r.complete[id]; });
    if (done.length) {
      r.lowGross = Math.min.apply(null, done.map(function (id) { return r.gross[id]; }));
      r.medalists = done.filter(function (id) { return r.gross[id] === r.lowGross; });
    }

    // ---- teams (gross): best 3 of 4 points per hole + 1 if every member makes par or better
    (day.groups || []).forEach(function (grp) {
      var mem = (grp.playerIds || []).filter(function (id) { return pmap[id]; });
      var holes = [];
      for (var i = 0; i < 18; i++) {
        var ok = mem.length > 0 && mem.every(function (id) { return r.points[id][i] != null; });
        if (!ok) { holes.push(null); continue; }
        var arr = mem.map(function (id) { return r.points[id][i]; }).sort(function (a, b) { return b - a; });
        var count = Math.min(3, arr.length);
        var sum = arr.slice(0, count).reduce(function (s, v) { return s + v; }, 0);
        var bonus = mem.every(function (id) { return day.scores[id][i] - par[i] <= 0; }) ? 1 : 0;
        holes.push(sum + bonus);
      }
      r.teams.push({ id: grp.id, name: grp.name, time: grp.time, members: mem, holes: holes,
        total: holes.every(function (v) { return v != null; }) ? holes.reduce(function (s, v) { return s + v; }, 0) : null,
        soFar: holes.reduce(function (s, v) { return s + (v || 0); }, 0),
        thru: holes.filter(function (v) { return v != null; }).length });
    });

    // ---- sides and 6-6-6
    ids.forEach(function (id) { r.sidesUnits[id] = 0; r.sixUnits[id] = 0; r.skinsWon[id] = 0; });
    var teams = r.teams.filter(function (t) { return t.members.length; });
    SEGMENTS.forEach(function (seg) {
      var tp = {}, resolved = teams.length > 1;
      teams.forEach(function (t) {
        var s = 0;
        for (var h = seg.from - 1; h < seg.to; h++) { if (t.holes[h] == null) resolved = false; else s += t.holes[h]; }
        tp[t.id] = s;
      });
      var winners = [];
      if (resolved) {
        var best = Math.max.apply(null, teams.map(function (t) { return tp[t.id]; }));
        winners = teams.filter(function (t) { return tp[t.id] === best; }).map(function (t) { return t.id; });
        var share = 1 / winners.length;
        teams.forEach(function (t) {
          if (winners.indexOf(t.id) < 0) return;
          t.members.forEach(function (id) {
            if (seg.game === 'sides') r.sidesUnits[id] += share; else r.sixUnits[id] += share;
          });
        });
      }
      r.segments.push({ key: seg.key, game: seg.game, label: seg.label, from: seg.from, to: seg.to, teamPts: tp, winners: winners, resolved: resolved });
    });

    // ---- net skins, whole field, a tie means no skin
    for (var hI = 0; hI < 18; hI++) {
      var allIn = ids.length > 0 && ids.every(function (id) { return r.netScores[id][hI] != null; });
      if (!allIn) { r.skins.push({ hole: hI + 1, resolved: false, winner: null, low: null }); continue; }
      var low = Math.min.apply(null, ids.map(function (id) { return r.netScores[id][hI]; }));
      var at = ids.filter(function (id) { return r.netScores[id][hI] === low; });
      var w = at.length === 1 ? at[0] : null;
      if (w) r.skinsWon[w]++;
      r.skins.push({ hole: hI + 1, resolved: true, winner: w, low: low, tied: at.length });
    }

    // ---- sandys / birdies / eagles units
    var eu = Number(stakes.eagleUnits) || 1;
    ids.forEach(function (id) { r.sbeUnits[id] = r.sandys[id] + r.birdies[id] + r.eagles[id] * eu; });

    // ---- money (only once every card is in)
    if (r.status === 'final') {
      var n = ids.length;
      var games = [
        { key: 'sbe', label: 'Sandys · Birdies · Eagles', stake: +stakes.sbe || 0, units: r.sbeUnits },
        { key: 'sides', label: 'Sides', stake: +stakes.sides || 0, units: r.sidesUnits },
        { key: 'skins', label: 'Skins', stake: +stakes.skins || 0, units: r.skinsWon },
        { key: 'six', label: '6-6-6', stake: +stakes.six || 0, units: r.sixUnits }
      ];
      r.pots = {}; r.pay = {};
      ids.forEach(function (id) { r.pay[id] = { sbe: 0, sides: 0, skins: 0, six: 0, won: 0, buyin: 0, net: 0 }; });
      games.forEach(function (g) {
        var pool = Math.round(g.stake * 100) * n;
        var totalUnits = ids.reduce(function (s, id) { return s + g.units[id]; }, 0);
        var refund = totalUnits <= 1e-9;
        var weights = {};
        ids.forEach(function (id) { weights[id] = refund ? 1 : g.units[id]; });
        var alloc = allocateCents(pool, weights);
        ids.forEach(function (id) { r.pay[id][g.key] = alloc[id]; r.pay[id].buyin += Math.round(g.stake * 100); });
        r.pots[g.key] = { label: g.label, stake: g.stake, pool: pool, units: totalUnits, perUnit: refund ? 0 : pool / totalUnits, refund: refund };
      });
      ids.forEach(function (id) {
        var p = r.pay[id]; p.won = p.sbe + p.sides + p.skins + p.six; p.net = p.won - p.buyin;
      });
    }
    return r;
  }

  function compute(state) {
    var out = { days: [], totals: {} };
    var prev = null, exempt = {};
    (state.days || []).forEach(function (d, i) {
      var pairings = null, auto = null;
      if (d.autoByTotal) {
        pairings = autoGroups(state, out.days, d, i);
        var counted = out.days.filter(function (x) { return x.status === 'final'; }).length;
        auto = { locked: i > 0 && out.days.every(function (x) { return x.status === 'final'; }), daysCounted: counted, anyRounds: out.days.some(function (x) { return Object.keys(x.gross).some(function (k) { return x.gross[k] != null; }); }) };
      }
      var r = computeDay(state, i, prev, d, pairings); r.auto = auto;
      if (pairings) r.groups = pairings;
      r.snake = r.courseError ? null : snakeFor(r, d, Object.assign({}, exempt));
      if (r.snake && r.snake.resolved) r.snake.ids.forEach(function (id) { exempt[id] = i + 1; });
      out.days.push(r); prev = r;
    });
    (state.players || []).forEach(function (p) {
      var t = { rounds: 0, gross: 0, net: 0, low: null, birdies: 0, eagles: 0, sandys: 0, skins: 0, sides: 0, six: 0,
        won: 0, buyin: 0, moneyNet: 0, daysPaid: 0, scores: [] };
      out.days.forEach(function (r) {
        var g = r.gross[p.id];
        t.scores.push(g == null ? null : g);
        if (g != null) {
          t.rounds++; t.gross += g; t.net += r.net[p.id];
          t.low = t.low == null ? g : Math.min(t.low, g);
        }
        if (r.players.indexOf(p.id) >= 0) {
          t.birdies += r.birdies[p.id] || 0; t.eagles += r.eagles[p.id] || 0; t.sandys += r.sandys[p.id] || 0;
          if (r.status === 'final') { t.skins += r.skinsWon[p.id]; t.sides += r.sidesUnits[p.id]; t.six += r.sixUnits[p.id]; }
        }
        if (r.pay && r.pay[p.id]) { t.won += r.pay[p.id].won; t.buyin += r.pay[p.id].buyin; t.moneyNet += r.pay[p.id].net; t.daysPaid++; }
      });
      t.avg = t.rounds ? t.gross / t.rounds : null;
      out.totals[p.id] = t;
    });
    return out;
  }

  return { MAX_HCP: MAX_HCP, compute: compute, standings: standings, timeValue: timeValue, courseProblem: courseProblem, dayPlayers: dayPlayers, strokesOn: strokesOn, pointsFor: pointsFor, allocateCents: allocateCents, SEGMENTS: SEGMENTS, isScore: isScore };
})();
if (typeof module !== 'undefined') module.exports = Engine;
