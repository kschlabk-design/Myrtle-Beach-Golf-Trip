/* ===== App ===== */
(function () {
  var API = '/api';
  var DRAFT_KEY = 'mbt-draft-v1', ME_KEY = 'mbt-me-v1', PIN_KEY = 'mbt-pin-v1', CACHE_KEY = 'mbt-cache-v1';
  var POLL_MS = 30000;

  var LS = {
    get: function (k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { } }
  };

  // Start from the data built into the page, then the last copy this phone saw from the server (works with no signal).
  var S = JSON.parse(document.getElementById('trip-data').textContent);
  // Saved data older than the setup built into this page is ignored (e.g. demo scores from before the 2026 setup).
  var SEED_AT = String(S.savedAt || '');
  var cached = LS.get(CACHE_KEY);
  if (cached && validState(cached.state) && String(cached.state.savedAt || '') >= String(S.savedAt || '')) S = cached.state;
  var baseRev = S.rev;
  var R = null, P = {};
  var ui = { tab: 'today', day: null, board: 'players', sortNet: false, money: 'day', sheet: null, admin: 'scores', group: 0, cur: { p: 0, h: 0 }, ten: false, open: {}, toast: null, importText: '', hofYear: '', pinEntry: '', pinErr: '', pinBusy: false };
  var pin = LS.get(PIN_KEY);
  var admin = { on: !!pin, dirty: false, publishing: false, remote: null };
  var net = { ok: null };

  // ---------- unpublished edits survive a closed app (scorer's phone only)
  if (pin) {
    var draft = LS.get(DRAFT_KEY);
    if (draft && validState(draft.state)) { S = draft.state; baseRev = draft.baseRev; admin.dirty = true; }
  }

  var me = LS.get(ME_KEY);
  var tabFromHash = (location.hash || '').replace('#', '');
  if (['today', 'board', 'money', 'snake', 'players'].indexOf(tabFromHash) >= 0) ui.tab = tabFromHash;
  if (tabFromHash === 'history') { ui.tab = 'players'; ui.roster = 'hof'; }
  if (admin.on && (tabFromHash === 'admin' || admin.dirty)) ui.tab = 'admin';

  // ---------- helpers
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function rid() { return Math.random().toString(36).slice(2, 10); }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtDate(s, long) {
    if (!s) return 'Date TBD';
    var d = new Date(s + 'T12:00:00'); if (isNaN(d)) return s;
    return d.toLocaleDateString('en-US', long ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function money(c) { c = Math.round(c || 0); return (c < 0 ? '−' : '') + '$' + (Math.abs(c) / 100).toFixed(2); }
  function signed(c) { c = Math.round(c || 0); return c > 0 ? '+' + money(c) : money(c); }
  function sgnClass(c) { return c > 0 ? 'pos' : c < 0 ? 'neg' : 'muted'; }
  function units(u) { var r = Math.round(u * 100) / 100; return String(r); }
  function nameOf(id) { return P[id] ? P[id].name : 'Unknown'; }
  function short(id) {
    var p = P[id]; if (!p) return '?';
    if (p.nick && String(p.nick).trim()) return String(p.nick).trim();
    var m = p.name.match(/"([^"]+)"/); if (m) return m[1];
    var parts = p.name.trim().split(/\s+/), first = parts[0] || p.name;
    var dup = S.players.some(function (q) { return q.id !== id && !/"/.test(q.name) && (q.name.trim().split(/\s+/)[0] || '').toLowerCase() === first.toLowerCase(); });
    return dup && parts.length > 1 ? first + ' ' + parts[parts.length - 1][0] + '.' : first;
  }
  function scClass(s, par) { if (s == null) return ''; var d = s - par; return d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 1 ? 'bogey' : d >= 2 ? 'dbl' : ''; }
  function dots(n) { return n > 0 ? '<span class="dots">' + (n > 1 ? '••' : '•') + '</span>' : ''; }
  function rankLabels(list, key) {
    var out = [], prev = null, pos = 0;
    list.forEach(function (x, i) {
      var v = key(x);
      if (v == null) { out.push('–'); return; }
      if (v !== prev) pos = i + 1;
      var tied = list.some(function (y, j) { return j !== i && key(y) === v; });
      out.push((tied ? 'T' : '') + pos); prev = v;
    });
    return out;
  }
  function normName(n) { return String(n || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function stripNick(n) { return normName(String(n || '').replace(/"[^"]*"/g, ' ')); }
  function hofFor(name) {
    var a = normName(name), b = stripNick(name);
    return (S.hof || []).find(function (x) { return normName(x.name) === a; }) || (S.hof || []).find(function (x) { return stripNick(x.name) === b; }) || null;
  }
  function dayCount(di) { return Engine.dayPlayers(S.days[di]).filter(function (id) { return P[id]; }).length; }
  function buyinPerDay() { var s = S.stakes; return (+s.sbe || 0) + (+s.sides || 0) + (+s.skins || 0) + (+s.six || 0); }

  // Players with finished rounds, most rounds first, then lowest total strokes. uptoDay (exclusive) limits which days count.
  function tripStandings(uptoDay) {
    return Engine.standings(S, R.days, uptoDay).filter(function (x) { return x.rounds; }).map(function (x) { return x.id; });
  }
  function recompute() {
    P = {}; S.players.forEach(function (p) { P[p.id] = p; });
    S.days.forEach(function (d) {
      d.scores = d.scores || {}; d.sandys = d.sandys || {}; d.threePutts = d.threePutts || {}; d.hcpOverride = d.hcpOverride || {}; d.groups = d.groups || [];
    });
    R = Engine.compute(S);
    if (ui.day == null || ui.day >= S.days.length) ui.day = defaultDay();
  }
  function defaultDay() {
    if (!S.days.length) return 0;
    var t = todayStr();
    var i = S.days.findIndex(function (d) { return d.date === t; });
    if (i >= 0) return (R.days[i].status === 'final' && i + 1 < S.days.length) ? i + 1 : i;
    var first = S.days[0].date;
    if (first && t < first) return 0;
    i = R.days.findIndex(function (r) { return r.status !== 'final'; });
    return i >= 0 ? i : S.days.length - 1;
  }

  // ---------- icons
  var IC = {
    today: '<svg viewBox="0 0 24 24"><path d="M6 21V3"/><path d="M6 4h11l-2.5 4L17 12H6"/></svg>',
    board: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    money: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M16.5 7H10a2.5 2.5 0 0 0 0 5h4a2.5 2.5 0 0 1 0 5H7"/></svg>',
    players: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.6 3-5.5 6-5.5s5.4 1.9 6 5.5"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.8c1.7.7 2.7 2.4 3 5.2"/></svg>',
    snake: '<span class="ico-snake" aria-hidden="true"></span>',
    history: '<svg viewBox="0 0 24 24"><path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3.3 4M16 6h3a3 3 0 0 1-3.3 4"/><path d="M12 13v4M9 20h6"/></svg>',
    admin: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>'
  };

  // ---------- render root
  var app = document.getElementById('app');
  var renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return; renderQueued = true;
    setTimeout(function () { renderQueued = false; render(); }, 0);
  }
  function render() {
    var active = document.activeElement && document.activeElement.id;
    var sheetScroll = (document.querySelector('.sheet') || {}).scrollTop || 0;
    recompute();
    var showKeypad = ui.tab === 'admin' && admin.on && ui.admin === 'scores' && !ui.sheet && currentGroup();
    document.body.classList.toggle('keypad-on', !!showKeypad);
    document.documentElement.classList.toggle('sheet-open', !!ui.sheet);
    var html = header() + '<main>' + view() + '</main>' + '<footer class="credit">' + (admin.on ? '' : '<button class="scorer-link" data-a="login">Scorer login</button>') + '<div><i>powered by</i> <a href="https://www.linkedin.com/in/kyle-schlabach-8217ab59" target="_blank" rel="noopener noreferrer" aria-label="Praxis Execution on LinkedIn (opens in a new tab)">PRAXIS EXECUTION</a></div></footer>' + tabbar() + (showKeypad ? keypad() : '') + sheet() + (ui.toast ? '<div class="toast" role="status">' + h(ui.toast) + '</div>' : '');
    app.innerHTML = html;
    if (active) { var el = document.getElementById(active); if (el && el.focus) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } } }
    var sh = document.querySelector('.sheet'); if (sh) sh.scrollTop = sheetScroll;
    syncHeads();
    var act = document.querySelector('.cell.active'); if (act && ui._scrollCell) { ui._scrollCell = false; act.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
  // Keep table column labels pinned under the sticky header while the page scrolls.
  // (CSS sticky can't do this inside a sideways-scrolling table, so the header row is shifted down instead.)
  function syncHeads() {
    var top = document.querySelector('.top');
    var limit = top ? top.getBoundingClientRect().bottom : 0;
    var tables = document.querySelectorAll('main table.board');
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i], head = t.tHead; if (!head) continue;
      var box = t.getBoundingClientRect(), hh = head.getBoundingClientRect().height;
      var room = box.height - hh - (t.tFoot ? t.tFoot.getBoundingClientRect().height : 0) - 44;
      var off = Math.max(0, Math.min(limit - box.top, room));
      head.style.transform = off > 0 ? 'translateY(' + Math.round(off) + 'px)' : '';
      head.classList.toggle('stuck', off > 0);
    }
  }
  var headQueued = false;
  function queueHeads() { if (headQueued) return; headQueued = true; requestAnimationFrame(function () { headQueued = false; syncHeads(); }); }
  window.addEventListener('scroll', queueHeads, { passive: true });
  window.addEventListener('resize', queueHeads);
  var toastTimer;
  function toast(msg) { ui.toast = msg; render(); clearTimeout(toastTimer); toastTimer = setTimeout(function () { ui.toast = null; render(); }, 3200); }

  function header() {
    var upd = S.savedAt ? 'Updated ' + new Date(S.savedAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    if (net.ok === false) upd = (upd ? upd + ' · ' : '') + 'offline';
    var chips = S.days.map(function (d, i) {
      var r = R.days[i], dt = d.date ? new Date(d.date + 'T12:00:00') : null;
      var sub = dt && !isNaN(dt) ? dt.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + (dt.getMonth() + 1) + '/' + dt.getDate() : 'TBD';
      return '<button class="day-chip st-' + r.status + '" data-a="day" data-i="' + i + '" aria-pressed="' + (i === ui.day) + '" aria-label="' + h((d.label || 'Day ' + (i + 1)) + ', ' + fmtDate(d.date, true) + ', ' + r.status) + '"><b>' + h(d.label || ('Day ' + (i + 1))) + '</b><span>' + h(sub) + '</span></button>';
    }).join('');
    return '<header class="top"><div class="top-in"><div class="top-row"><div class="brand"><b>' + h(S.trip.name || 'Golf Trip') + '</b><small>' + h([S.trip.place, upd].filter(Boolean).join(' · ')) + '</small></div>' +
      '<button class="me-btn" data-a="me">' + (me && P[me] ? h(short(me)) : 'Who are you?') + '</button></div>' +
      (S.days.length ? '<div class="days" role="group" aria-label="Pick a day">' + chips + '</div>' : '') + '</div></header>';
  }

  function tabbar() {
    var tabs = [['today', 'Today'], ['board', 'Board'], ['money', 'Money'], ['snake', 'Snake'], ['players', 'Players']];
    if (admin.on) tabs.push(['admin', 'Scorer']);
    return '<nav class="tabbar"><div class="tabbar-in">' + tabs.map(function (t) {
      return '<button class="tab' + (t[0] === 'admin' ? ' admin-tab' : '') + '" data-a="tab" data-t="' + t[0] + '"' + (ui.tab === t[0] ? ' aria-current="page"' : '') + '>' + IC[t[0]] + t[1] + (t[0] === 'admin' && admin.dirty ? ' •' : '') + '</button>';
    }).join('') + '</div></nav>';
  }

  function view() {
    if (!S.days.length && ui.tab !== 'admin' && ui.tab !== 'players') return '<div class="card empty">The trip isn\'t set up yet. Check back soon.</div>';
    switch (ui.tab) {
      case 'board': return viewBoard();
      case 'money': return viewMoney();
      case 'players': return viewPlayers();
      case 'snake': return viewSnake();
      case 'admin': return admin.on ? viewAdmin() : viewToday();
      default: return viewToday();
    }
  }

  function demoBanner() {
    return S.demo ? '<div class="banner"><b>Demo data.</b> The 2023 roster and each man\'s real 2023 18-hole totals, spread across holes so every screen can be tested. This gets cleared before the trip.</div>' : '';
  }
  function statusPill(r) {
    if (r.status === 'final') return '<span class="pill final">Final</span>';
    if (r.status === 'live') return '<span class="pill live">In progress</span>';
    return '<span class="pill">Upcoming</span>';
  }

  // ---------- TODAY
  function viewToday() {
    var di = ui.day, d = S.days[di], r = R.days[di];
    var out = demoBanner();
    var myGroup = null;
    var pending = r.auto && !r.auto.anyRounds;   // grouped by trip total, but no scores yet
    if (me && !pending) (r.groups || []).forEach(function (g, gi) { if ((g.playerIds || []).indexOf(me) >= 0) myGroup = { g: g, gi: gi }; });

    if (me && P[me] && myGroup) {
      var hc = r.hcp[me];
      var mates = myGroup.g.playerIds.filter(function (x) { return x && x !== me && P[x]; }).map(short).join(', ');
      var prevLine = '';
      for (var k = di - 1; k >= 0; k--) {
        var pr = R.days[k];
        if (pr.players.indexOf(me) >= 0 && pr.gross[me] != null) {
          prevLine = h(S.days[k].label || ('Day ' + (k + 1))) + (pr.course ? ' at ' + h(pr.course.name) : '') + ': <b>' + pr.gross[me] + '</b>' +
            (pr.pay ? ' · ' + (pr.pay[me].net >= 0 ? 'up ' : 'down ') + money(Math.abs(pr.pay[me].net)) : '') +
            (pr.skinsWon && pr.skinsWon[me] ? ' · ' + pr.skinsWon[me] + ' skin' + (pr.skinsWon[me] > 1 ? 's' : '') : '');
          break;
        }
      }
      var st = r.status === 'final' && r.gross[me] != null ? { e: 'Your score', v: r.gross[me] } : { e: 'Tee time', v: myGroup.g.time || 'TBD' };
      out += '<section class="you"><div><div class="eyebrow">' + h(d.label || ('Day ' + (di + 1))) + ' · ' + st.e + '</div><div class="big num">' + h(st.v) + '</div>' +
        '<div class="sub">' + h(myGroup.g.name || ('Group ' + (myGroup.gi + 1))) + (r.course ? ' · ' + h(r.course.name) : '') + '</div></div>' +
        '<div class="side"><div class="eyebrow">Skins hcp</div><div class="big num">' + (hc ? hc.value : '–') + '</div>' + (hc && hc.provisional ? '<div class="sub">pending</div>' : '') + '</div>' +
        '<div class="mates"><div><span>With</span><div>' + h(mates || 'TBD') + '</div></div>' + (r.auto && teamOf(r, me) ? '<div><span>Team</span><div>' + h(teamOf(r, me).members.filter(function (x) { return x !== me; }).map(short).join(', ')) + '</div></div>' : '') +
        (prevLine ? '<div class="lastday"><span>Last round</span><div>' + prevLine + '</div></div>' : '') + '</div></section>';
    } else if (!me || !P[me]) {
      out += '<section class="card row between wrap"><div><h3>Find your tee time</h3><div class="muted small">Pick your name once. This phone remembers it.</div></div><button class="btn primary" data-a="me">Pick my name</button></section>';
    } else {
      out += '<section class="card"><div class="muted">' + (pending ? h(short(me)) + ', your ' + h(d.label || 'this day') + ' tee time is set by trip total once scores are in.' : h(short(me)) + ', you\'re not in a group for ' + h(d.label || 'this day') + ' yet.') + '</div></section>';
    }

    // day card + tee sheet
    var par = r.course ? r.course.par.reduce(function (a, b) { return a + (+b || 0); }, 0) : null;
    out += '<section class="card"><div class="card-head"><div><div class="eyebrow">' + h(fmtDate(d.date, true)) + '</div>' +
      '<h2>' + h(r.course ? r.course.name : 'Course TBD') + '</h2></div>' + statusPill(r) + '</div>' +
      '<div class="muted small">' + (par ? 'Par ' + par + ' · ' : '') + r.players.length + ' players · $' + buyinPerDay() + ' a man' + (d.notes ? ' · ' + h(d.notes) : '') + '</div>' +
      (r.courseError ? '<div class="banner" style="margin-top:10px"><b>Scorecard not ready.</b> ' + h(r.courseError) + '</div>' : '') +
      autoNote(r) +
      '<div style="margin-top:6px">' + (pending ? r.groups.map(function (g, gi) {
        return '<div class="tee"><div class="time num">' + h(g.time || 'TBD') + '<small>Group ' + (gi + 1) + '</small></div><div class="muted small" style="align-self:center">' + (gi === 0 ? 'Lowest four trip totals' : gi === r.groups.length - 1 ? 'Highest four trip totals' : 'Set by trip total') + '</div></div>';
      }).join('') : (r.groups || []).length ? r.groups.map(function (g, gi) {
        var mine = me && g.playerIds.indexOf(me) >= 0;
        var team = r.auto ? null : r.teams[gi];
        return '<div class="tee' + (mine ? ' mine' : '') + '"><div class="time num">' + h(g.time || 'TBD') + '<small>' + h(g.name || ('Group ' + (gi + 1))) + '</small></div><ul>' +
          g.playerIds.filter(function (x) { return x && P[x]; }).map(function (x) {
            var hc = r.hcp[x];
            return '<li><span class="tier">' + P[x].tier + '</span><span class="nm">' + h(short(x)) + (r.auto && teamOf(r, x) ? ' <span class="small muted">' + h(teamOf(r, x).name) + '</span>' : '') + '</span><span class="hc num">' +
              (r.status !== 'upcoming' && r.thru[x] ? (r.thru[x] === 18 ? '<b>' + r.gross[x] + '</b>' : 'thru ' + r.thru[x]) : (hc ? 'hcp ' + hc.value : '')) + '</span></li>';
          }).join('') + '</ul>' +
          (team && team.thru ? '<div class="small muted" style="grid-column:2">Team points: <b class="num">' + team.soFar + '</b>' + (team.thru < 18 ? ' thru ' + team.thru : '') + '</div>' : '') +
          '</div>';
      }).join('') : '<div class="empty">Groups and tee times aren\'t posted yet.</div>') + '</div>' +
      '<div class="small muted" style="margin-top:6px">Numbers next to names are the tier (1-men through 4-men).' + (di > 0 ? ' Handicaps (skins only) reset from the previous day\'s medalist.' : ' Handicaps count for skins only.') + '</div></section>' +
      (r.auto ? teamsCard(r) : '');

    // recap
    var ri = r.status === 'final' || r.status === 'live' ? di : -1;
    if (ri < 0) for (var j = di - 1; j >= 0; j--) if (R.days[j].status === 'final') { ri = j; break; }
    if (ri >= 0) out += recap(ri);
    return out;
  }

  function recap(i) {
    var r = R.days[i], d = S.days[i];
    var med = r.medalists.map(short).join(', ');
    var skinW = r.players.filter(function (x) { return r.skinsWon[x]; }).sort(function (a, b) { return r.skinsWon[b] - r.skinsWon[a]; });
    var sidesTeams = r.segments.filter(function (s) { return s.resolved; });
    var topMoney = r.pay ? r.players.slice().sort(function (a, b) { return r.pay[b].net - r.pay[a].net; })[0] : null;
    var totalBirdies = r.players.reduce(function (s, x) { return s + (r.birdies[x] || 0) + (r.eagles[x] || 0); }, 0);
    var teamWins = {};
    sidesTeams.forEach(function (s) { s.winners.forEach(function (w) { teamWins[w] = (teamWins[w] || 0) + 1 / s.winners.length; }); });
    var topTeam = Object.keys(teamWins).sort(function (a, b) { return teamWins[b] - teamWins[a]; })[0];
    var tt = topTeam ? r.teams.find(function (t) { return t.id === topTeam; }) : null;
    var row = function (label, value, sub) { return '<div class="res"><dt>' + h(label) + '</dt><dd>' + value + (sub ? '<span class="small">' + h(sub) + '</span>' : '') + '</dd></div>'; };
    var sandyW = r.players.filter(function (x) { return r.sandys[x]; }).sort(function (a, b) { return r.sandys[b] - r.sandys[a]; });
    var sandyN = sandyW.reduce(function (s, x) { return s + r.sandys[x]; }, 0);
    var skinsN = skinW.reduce(function (s, x) { return s + r.skinsWon[x]; }, 0);
    return '<section class="card"><div class="card-head"><div><div class="eyebrow">' + (r.status === 'final' ? 'How it went' : 'So far') + '</div><h3>' + h(d.label || ('Day ' + (i + 1))) + (r.course ? ' · ' + h(r.course.name) : '') + '</h3></div>' + statusPill(r) + '</div>' +
      '<div class="tiles n3" style="margin-top:12px">' +
      tile(r.lowGross != null ? r.lowGross : '–', 'Medalist', med || 'Waiting on cards') +
      tile(fieldAvg(r), 'Day avg', r.players.filter(function (x) { return r.complete[x]; }).length === r.players.length ? 'All cards in' : r.players.filter(function (x) { return r.complete[x]; }).length + '/' + r.players.length + ' cards') +
      tile(totalBirdies, 'Birdies', '+ eagles') +
      '</div><dl class="results">' +
      row('Skins', skinsN ? h(skinW.map(function (x) { return short(x) + (r.skinsWon[x] > 1 ? ' ×' + r.skinsWon[x] : ''); }).join(', ')) : (r.status === 'final' ? 'None won' : 'Pending'), skinsN ? skinsN + ' skin' + (skinsN > 1 ? 's' : '') + ' won' : '') +
      row('Sandys', sandyW.length ? h(sandyW.map(function (x) { return short(x) + (r.sandys[x] > 1 ? ' ×' + r.sandys[x] : ''); }).join(', ')) : 'None', sandyN ? sandyN + ' Sand' + (sandyN > 1 ? 'ys' : 'y') + ' · 1 unit each' : '') +
      (r.snake ? row(r.snake.resolved ? 'The Snake' : 'Holding snake', r.snake.ids.length ? h(r.snake.ids.map(short).join(', ')) : (r.snake.resolved ? 'Nobody' : 'Still loose'), r.snake.hole ? '3-putt on ' + r.snake.hole + (r.snake.resolved ? ' · buys a round' : '') : '') : '') +
      (tt ? row('Most sides', h(tt.members.map(short).join(', ')), units(teamWins[topTeam]) + ' of 6 · front, back, total & 6-6-6') : '') +
      (topMoney ? row('Big winner', h(short(topMoney)) + ' <span class="pos">' + signed(r.pay[topMoney].net) + '</span>', '') : '') +
      '</dl></section>';
  }
  function teamOf(r, pid) { return r.teams.find(function (t) { return t.members.indexOf(pid) >= 0; }) || null; }
  function teamsCard(r) {
    if (!r.teams.some(function (tm) { return tm.members.length; })) {
      return '<section class="card"><div class="eyebrow">Sides &amp; 6-6-6</div><h3>Today\'s teams</h3><div class="banner" style="margin-top:8px"><b>Teams aren\'t set yet.</b> They\'ll be posted before this round.</div></section>';
    }
    return '<section class="card"><div class="eyebrow">Sides &amp; 6-6-6</div><h3>Today\'s teams</h3><div class="small muted" style="margin-bottom:6px">Teams don\'t play together today. Your team\'s points come from four different groups.</div>' +
      r.teams.map(function (t) {
        var mine = me && t.members.indexOf(me) >= 0;
        return '<div class="tee' + (mine ? ' mine' : '') + '" style="grid-template-columns:84px 1fr"><div class="time" style="font-size:19px">' + h(t.name || 'Team') + (t.thru ? '<small>' + t.soFar + ' pts' + (t.thru < 18 ? ' · thru ' + t.thru : '') + '</small>' : '') + '</div><ul>' +
          t.members.map(function (x) {
            var g = r.groups.find(function (gg) { return gg.playerIds.indexOf(x) >= 0; });
            return '<li><span class="tier">' + P[x].tier + '</span><span class="nm">' + h(short(x)) + '</span><span class="hc num">' + h(g && g.time ? g.time : '') + '</span></li>';
          }).join('') + '</ul></div>';
      }).join('') + '</section>';
  }
  function autoNote(r) {
    if (!r.auto) return '';
    var msg = r.auto.locked ? 'Groups are set by trip total. Lowest four tee off first.'
      : r.auto.anyRounds ? 'Projected from trip totals through ' + r.auto.daysCounted + ' day' + (r.auto.daysCounted === 1 ? '' : 's') + '. Lowest four tee off first. This updates every night as scores are posted.'
      : 'Groups will be set by trip total once scores are in. Lowest four tee off first.';
    return '<div class="banner" style="margin-top:10px">' + (r.auto.locked ? '<b>Set by Total Strokes.</b> ' : '<b>Projected.</b> ') + h(msg) + '</div>';
  }
  function fieldAvg(r) {
    var done = r.players.filter(function (x) { return r.complete[x]; });
    return done.length ? (done.reduce(function (s, x) { return s + r.gross[x]; }, 0) / done.length).toFixed(1) : '–';
  }
  function tile(v, l, sub) { return '<div class="tile"><div class="l">' + h(l) + '</div><div class="v num">' + h(v) + '</div><div class="small muted">' + h(sub) + '</div></div>'; }

  // ---------- BOARD
  function viewBoard() {
    var modes = [['players', 'Players'], ['teams', 'Teams'], ['skins', 'Skins'], ['trip', 'Trip']];
    var out = '<div class="row between wrap"><div class="seg" role="group">' + modes.map(function (m) {
      return '<button data-a="board" data-m="' + m[0] + '" aria-pressed="' + (ui.board === m[0]) + '">' + m[1] + '</button>';
    }).join('') + '</div></div>';
    var r = R.days[ui.day];
    if (ui.board !== 'trip' && r.courseError) return out + '<div class="card"><div class="banner"><b>Scorecard not ready.</b> ' + h(r.courseError) + '</div></div>';
    if (ui.board === 'teams') return out + boardTeams(r);
    if (ui.board === 'skins') return out + boardSkins(r);
    if (ui.board === 'trip') return out + boardTrip();
    return out + boardPlayers(r);
  }
  function dayHead(r, extra) {
    var d = S.days[r.idx];
    return '<div class="row between" style="margin-bottom:8px"><div><div class="eyebrow">' + h(d.label || ('Day ' + (r.idx + 1))) + ' · ' + h(fmtDate(d.date)) + '</div><h3>' + h(r.course ? r.course.name : 'Course TBD') + '</h3></div>' + (extra || statusPill(r)) + '</div>';
  }
  function boardPlayers(r) {
    var list = r.players.slice();
    var key = function (x) { return r.complete[x] ? r.gross[x] : null; };
    list.sort(function (a, b) {
      var ka = key(a), kb = key(b);
      if (ka != null && kb != null) return ka - kb || short(a).localeCompare(short(b));
      if (ka != null) return -1; if (kb != null) return 1;
      return (r.thru[b] || 0) - (r.thru[a] || 0) || short(a).localeCompare(short(b));
    });
    var ranks = rankLabels(list, key);
    if (!list.length) return '<div class="card">' + dayHead(r) + '<div class="empty">No groups set for this day yet.</div></div>';
    return '<div class="card">' + dayHead(r) +
      '<div class="tbl-wrap"><table class="board"><thead><tr><th></th><th class="l">Player</th><th>Thru</th><th>Score</th><th>Skins hcp</th></tr></thead><tbody>' +
      list.map(function (x, i) {
        var hc = r.hcp[x];
        var bird = (r.birdies[x] || 0) + (r.eagles[x] || 0);
        return '<tr class="tap' + (x === me ? ' me' : '') + '" data-a="card" data-d="' + r.idx + '" data-p="' + x + '"><td class="pos-col">' + ranks[i] + '</td>' +
          '<td class="nm">' + h(short(x)) + (r.medalists.indexOf(x) >= 0 && r.status === 'final' ? ' <span class="pill gold">Medalist</span>' : '') + (bird ? ' <span class="under small">' + bird + '●</span>' : '') + '</td>' +
          '<td class="num muted">' + (r.thru[x] === 18 ? 'F' : (r.thru[x] || '–')) + '</td>' +
          '<td class="big num">' + (r.gross[x] != null ? r.gross[x] : '–') + '</td><td class="num muted">' + (hc ? hc.value : '') + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="small muted" style="margin-top:8px">Lowest score on top. Tap a player to see his card. ● = birdies and eagles. Handicaps only count for skins.</div></div>';
  }
  function boardTeams(r) {
    if (!r.teams.length) return '<div class="card">' + dayHead(r) + '<div class="empty">No teams set for this day yet.</div></div>';
    var sorted = r.teams.slice().sort(function (a, b) { return b.soFar - a.soFar; });
    return '<div class="card">' + dayHead(r) + sorted.map(function (t) {
      var segHtml = function (game) {
        return '<div class="segs">' + r.segments.filter(function (s) { return s.game === game; }).map(function (s) {
          var w = s.winners.indexOf(t.id) >= 0;
          return '<div class="segbox' + (w ? (s.winners.length > 1 ? ' win tie' : ' win') : '') + '"><span>' + h(s.label.replace('Holes ', '')) + (w && s.winners.length > 1 ? ' (tie)' : '') + '</span><b class="num">' + s.teamPts[t.id] + '</b></div>';
        }).join('') + '</div>';
      };
      var maxH = r.teams.map(function (x) { return x.holes; });
      return '<div class="team"><div class="row between"><div><h3>' + h(t.name || 'Team') + ' <span class="muted small" style="text-transform:none;letter-spacing:0">' + h(t.time || '') + '</span></h3>' +
        '<div class="members">' + t.members.map(function (m) { return h(short(m)); }).join(' · ') + '</div></div>' +
        '<div style="text-align:right"><div class="eyebrow">Points</div><div class="num" style="font-family:var(--display);font-weight:700;font-size:26px;line-height:1">' + t.soFar + '</div>' + (t.thru && t.thru < 18 ? '<div class="small muted">thru ' + t.thru + '</div>' : '') + '</div></div>' +
        '<div class="eyebrow" style="margin-top:8px">Sides</div>' + segHtml('sides') +
        '<div class="eyebrow" style="margin-top:8px">6-6-6</div>' + segHtml('six') +
        '<div class="holestrip">' + t.holes.map(function (v, i) {
          var best = maxH.every(function (hs) { return hs[i] == null || v == null || v >= hs[i]; });
          return '<span class="' + (v != null && best ? 'hot' : '') + '" title="Hole ' + (i + 1) + '">' + (v == null ? '·' : v) + '</span>';
        }).join('') + '</div></div>';
    }).join('') +
      '<div class="small muted" style="margin-top:6px">Each hole: best 3 of 4 scores count (eagle 8, birdie 5, par 3, bogey 2, double 1, worse 0), plus 1 if all four make par or better. Straight scores, no handicaps. Highlighted holes are where the team matched or beat every other team.</div></div>';
  }
  function boardSkins(r) {
    var won = r.skins.filter(function (s) { return s.winner; }).length;
    var pot = dayCount(r.idx) * (+S.stakes.skins || 0);
    return '<div class="card">' + dayHead(r) +
      '<div class="small muted" style="margin-bottom:10px">Net skins across the whole field. A tie means nobody wins the hole. ' + (won ? won + ' skin' + (won > 1 ? 's' : '') + ' won so far · $' + pot + ' pot' + (r.status === 'final' ? ' · ' + money(pot * 100 / won) + ' each' : '') : 'No skins won yet.') + '</div>' +
      '<div class="skins">' + r.skins.map(function (s) {
        var par = r.course.par[s.hole - 1];
        var who = !s.resolved ? '<span class="muted">–</span>' : s.winner ? '<b>' + h(short(s.winner)) + '</b>' : '<span class="muted">Tie ×' + s.tied + '</span>';
        var sub = s.resolved ? 'net ' + s.low : 'par ' + par;
        return '<div class="skin' + (s.winner ? ' won' : '') + '"><span class="h num">' + s.hole + '</span><span class="sk"><span class="who">' + who + '</span><span class="sub">' + sub + '</span></span></div>';
      }).join('') + '</div></div>';
  }
  function boardTrip() {
    var list = tripStandings();
    if (!list.length) return '<div class="card empty">No finished rounds yet.</div>';
    var maxR = R.totals[list[0]].rounds;
    var ranks = rankLabels(list, function (x) { return R.totals[x].rounds === maxR ? R.totals[x].gross : null; });
    return '<div class="card"><div class="eyebrow">Whole trip · lowest total on top</div><h3 style="margin-bottom:8px">Total strokes</h3><div class="tbl-wrap"><table class="board"><thead><tr><th></th><th class="l">Player</th><th>Total</th>' +
      S.days.map(function (d, i) { return '<th>D' + (i + 1) + '</th>'; }).join('') + '<th>Avg</th></tr></thead><tbody>' +
      list.map(function (x, i) {
        var t = R.totals[x];
        var sep = i > 0 && i % 4 === 0 ? ' style="border-top:2px solid var(--ink)"' : '';
        return '<tr class="tap' + (x === me ? ' me' : '') + '" data-a="player" data-p="' + x + '"' + sep + '><td class="pos-col">' + ranks[i] + '</td><td class="nm l">' + h(short(x)) + '</td>' +
          '<td class="big num">' + t.gross + (t.rounds < maxR ? '<div class="small muted">' + t.rounds + ' rd' + (t.rounds === 1 ? '' : 's') + '</div>' : '') + '</td>' +
          t.scores.map(function (s, di) { return '<td class="num' + (s != null && s === R.days[di].lowGross ? ' under' : '') + '">' + (s == null ? '–' : s) + '</td>'; }).join('') +
          '<td class="num muted">' + t.avg.toFixed(1) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  // ---------- MONEY
  function viewMoney() {
    var out = '<div class="seg" role="group"><button data-a="money" data-m="day" aria-pressed="' + (ui.money === 'day') + '">This day</button><button data-a="money" data-m="trip" aria-pressed="' + (ui.money === 'trip') + '">Whole trip</button></div>';
    return out + (ui.money === 'trip' ? moneyTrip() : moneyDay(R.days[ui.day]));
  }
  function moneyDay(r) {
    var n = r.players.length;
    if (!r.pay) {
      var done = r.players.filter(function (x) { return r.complete[x]; }).length;
      return '<div class="card">' + dayHead(r) + '<div class="empty">Money posts once all ' + n + ' cards are in. ' + done + ' of ' + n + ' entered.<br><span class="small">Buy-in is $' + buyinPerDay() + ' a man, so $' + (buyinPerDay() * n) + ' goes out today.</span></div></div>';
    }
    var potHtml = ['sbe', 'sides', 'skins', 'six'].map(function (k) {
      var p = r.pots[k];
      var what = k === 'skins' ? 'skin' : 'unit';
      return '<div class="pot"><div class="l">' + h(p.label) + '</div><div class="v num">' + money(p.pool) + '</div><div class="s">' +
        (p.refund ? 'Nobody won it. Everyone gets $' + p.stake + ' back.' : units(p.units) + ' ' + what + (p.units === 1 ? '' : 's') + ' · ' + money(p.perUnit) + ' per ' + what) + '</div></div>';
    }).join('');
    var paid = r.players.reduce(function (s, x) { return s + r.pay[x].won; }, 0);
    var pool = r.players.reduce(function (s, x) { return s + r.pay[x].buyin; }, 0);
    var list = r.players.slice().sort(function (a, b) { return r.pay[b].net - r.pay[a].net || short(a).localeCompare(short(b)); });
    return '<div class="card">' + dayHead(r) + '<div class="pots">' + potHtml + '</div>' +
      '<div class="recon">' + (paid === pool ? '✓ Paid out ' + money(paid) + ' of ' + money(pool) + '. Every dollar is accounted for.' : '<span class="neg">Paid ' + money(paid) + ' of ' + money(pool) + '</span>') + '</div></div>' +
      (admin.on ? paidBar(r) : '') + '<div class="card"><div class="tbl-wrap"><table class="board"><thead><tr><th class="l stick">' + (admin.on ? 'Paid · ' : '') + 'Player</th><th>+/−</th><th>Won</th><th>S/B/E</th><th>Sides</th><th>Skins</th><th>6-6-6</th></tr></thead><tbody>' +
      list.map(function (x) {
        var p = r.pay[x];
        var cell = function (c, u) { return '<td class="num">' + (c ? money(c) : '<span class="muted">–</span>') + (u ? '<div class="small muted">' + u + '</div>' : '') + '</td>'; };
        var paid = admin.on && isPaid(r.idx, x);
        return '<tr class="tap' + (x === me ? ' me' : '') + (paid ? ' settled' : '') + '" data-a="card" data-d="' + r.idx + '" data-p="' + x + '"><td class="nm l stick">' +
          (admin.on ? '<button class="paybox" data-a="paid" data-d="' + r.idx + '" data-p="' + x + '" role="checkbox" aria-checked="' + paid + '" aria-label="' + h(short(x)) + ' settled">' + (paid ? '✓' : '') + '</button>' : '') + h(short(x)) + '</td>' +
          '<td class="big num ' + sgnClass(p.net) + '">' + signed(p.net) + '</td><td class="num">' + money(p.won) + '</td>' +
          cell(p.sbe, r.sbeUnits[x] ? units(r.sbeUnits[x]) + ' u' : '') + cell(p.sides, r.sidesUnits[x] ? units(r.sidesUnits[x]) : '') + cell(p.skins, r.skinsWon[x] ? r.skinsWon[x] + ' skin' + (r.skinsWon[x] > 1 ? 's' : '') : '') + cell(p.six, r.sixUnits[x] ? units(r.sixUnits[x]) : '') + '</tr>';
      }).join('') + '</tbody><tfoot><tr><td class="stick">Total</td><td class="num">' + signed(paid - pool) + '</td><td class="num">' + money(paid) + '</td><td class="num">' + money(sumK(r, 'sbe')) + '</td><td class="num">' + money(sumK(r, 'sides')) + '</td><td class="num">' + money(sumK(r, 'skins')) + '</td><td class="num">' + money(sumK(r, 'six')) + '</td></tr></tfoot></table></div>' +
      '<div class="small muted" style="margin-top:8px">Won = what you collect. +/− = won minus your $' + buyinPerDay() + ' buy-in. S/B/E units: 1 per Sandy, birdie or eagle' + ((+S.stakes.eagleUnits || 1) !== 1 ? ' (eagles count ' + S.stakes.eagleUnits + ')' : '') + '. Ties on sides and 6-6-6 split evenly.</div></div>';
  }
  function isPaid(di, pid) { return !!((S.days[di].paid || {})[pid]); }
  function paidBar(r) {
    var n = r.players.filter(function (x) { return isPaid(r.idx, x); }).length;
    var owed = r.players.filter(function (x) { return !isPaid(r.idx, x) && r.pay[x].won > 0; }).reduce(function (s, x) { return s + r.pay[x].won; }, 0);
    return '<div class="admin-bar"><div class="st"><b>' + n + ' of ' + r.players.length + ' settled.</b> ' + (owed ? money(owed) + ' still to hand out.' : (n === r.players.length ? 'All square.' : 'Nothing left to hand out.')) +
      '<div class="small muted">Only you see the checkboxes. Publish to save them.</div></div>' + (n ? '<button class="btn sm" data-a="paid-clear" data-d="' + r.idx + '">Clear</button>' : '') + '</div>';
  }
  function sumK(r, k) { return r.players.reduce(function (s, x) { return s + r.pay[x][k]; }, 0); }
  function moneyTrip() {
    var paidDays = R.days.filter(function (r) { return r.pay; }).length;
    var list = S.players.filter(function (p) { return R.totals[p.id].daysPaid; }).map(function (p) { return p.id; });
    if (!list.length) return '<div class="card empty">No days are settled yet. Money posts when a day\'s cards are all in.</div>';
    list.sort(function (a, b) { return R.totals[b].moneyNet - R.totals[a].moneyNet; });
    var net = list.reduce(function (s, x) { return s + R.totals[x].moneyNet; }, 0);
    return '<div class="card"><div class="eyebrow">' + paidDays + ' of ' + S.days.length + ' days settled</div><h3 style="margin-bottom:8px">Trip money</h3><div class="tbl-wrap"><table class="board"><thead><tr><th class="l stick">Player</th>' +
      S.days.map(function (d, i) { return '<th>D' + (i + 1) + '</th>'; }).join('') + '<th>Won</th><th>+/−</th></tr></thead><tbody>' +
      list.map(function (x) {
        var t = R.totals[x];
        return '<tr class="tap' + (x === me ? ' me' : '') + '" data-a="player" data-p="' + x + '"><td class="nm l stick">' + h(short(x)) + '</td>' +
          R.days.map(function (r) { var p = r.pay && r.pay[x]; return '<td class="num ' + (p ? sgnClass(p.net) : 'muted') + '">' + (p ? signed(p.net).replace('.00', '') : '–') + '</td>'; }).join('') +
          '<td class="num">' + money(t.won) + '</td><td class="big num ' + sgnClass(t.moneyNet) + '">' + signed(t.moneyNet) + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="recon">' + (net === 0 ? '✓ Winners and losers balance to $0.00' : '<span class="neg">Off by ' + money(net) + '</span>') + '</div></div>';
  }

  // ---------- PLAYERS
  function viewPlayers() {
    var seg = '<div class="seg" role="group"><button data-a="roster" data-m="roster" aria-pressed="' + (ui.roster !== 'hof') + '">This trip</button><button data-a="roster" data-m="hof" aria-pressed="' + (ui.roster === 'hof') + '">Hall of Fame</button></div>';
    if (ui.roster === 'hof') return seg + viewHistory();
    if (!S.days.length) return seg + '<div class="card empty">The trip isn\'t set up yet.</div>';
    var r = R.days[ui.day];
    var list = S.players.slice().sort(function (a, b) { return a.tier - b.tier || a.name.localeCompare(b.name); });
    return seg + '<div class="card"><div class="eyebrow">' + S.players.length + ' players</div><h3 style="margin-bottom:8px">Roster</h3><div class="tbl-wrap"><table class="board"><thead><tr><th class="l">Tier</th><th class="l">Player</th><th>Hcp ' + h('D' + (ui.day + 1)) + '</th><th>Rounds</th><th>Avg</th><th>Money</th></tr></thead><tbody>' +
      list.map(function (p) {
        var t = R.totals[p.id], hc = r.hcp[p.id] || (r.carryHcp || {})[p.id];
        return '<tr class="tap' + (p.id === me ? ' me' : '') + '" data-a="player" data-p="' + p.id + '"><td><span class="tier">' + p.tier + '</span></td><td class="nm l" style="max-width:220px">' + h(p.name) + '</td>' +
          '<td class="num">' + (hc ? hc.value : '–') + '</td><td class="num">' + t.rounds + '</td><td class="big num">' + (t.avg ? t.avg.toFixed(1) : '–') + '</td><td class="num ' + sgnClass(t.moneyNet) + '">' + (t.daysPaid ? signed(t.moneyNet) : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  // ---------- SNAKE
  function cobra(size) {
    return '<span class="cobra" role="img" aria-label="The Snake" style="width:' + size + 'px;height:' + size + 'px"></span>';
  }
  function viewSnake() {
    var r = R.days[ui.day], d = S.days[ui.day];
    var hero;
    if (!r.snake) hero = '<div class="muted">The scorecard for this day isn\'t set up yet.</div>';
    else if (r.snake.ids.length) {
      hero = '<div class="eyebrow">' + h(d.label || ('Day ' + (ui.day + 1))) + (r.snake.resolved ? ' · The Snake' : ' · Holding the Snake right now') + '</div>' +
        '<div class="snake-name">' + h(r.snake.ids.map(short).join(' & ')) + '</div>' +
        '<p>' + (r.snake.resolved ? '3-putted hole ' + r.snake.hole + '. ' + (r.snake.ids.length > 1 ? 'They each buy' : 'He buys') + ' a round of drinks.' : 'Last 3-putt so far was on hole ' + r.snake.hole + '. It moves to anyone who 3-putts a later hole.') + '</p>';
    } else hero = '<div class="eyebrow">' + h(d.label || ('Day ' + (ui.day + 1))) + '</div><div class="snake-name">' + (r.snake.resolved ? 'No Snake' : 'Still loose') + '</div><div>' + (r.snake.resolved ? 'Nobody eligible 3-putted.' : 'No eligible 3-putts yet.') + '</div>';
    var hist = R.days.map(function (x, i) {
      if (!x.snake || (!x.snake.ids.length && x.status === 'upcoming')) return '';
      return '<div class="res"><dt>' + h(S.days[i].label || ('Day ' + (i + 1))) + '<span class="small" style="display:block;letter-spacing:0;text-transform:none;font-weight:400;margin-top:2px">' + h(x.course ? x.course.name : '') + '</span></dt><dd>' + (x.snake.ids.length ? h(x.snake.ids.map(short).join(', ')) : '<span class="muted">None</span>') + '<span class="small">' + (x.snake.hole ? '3-putt on ' + x.snake.hole : '') + (x.snake.resolved ? '' : (x.snake.hole ? ' · ' : '') + 'still live') + '</span></dd></div>';
    }).join('');
    var exempt = {}; R.days.forEach(function (x) { if (x.snake && x.snake.resolved) x.snake.ids.forEach(function (id) { exempt[id] = 1; }); });
    var eligible = S.players.filter(function (p) { return !exempt[p.id]; });
    return '<section class="snake-hero">' + cobra(112) + '<div>' + hero + '</div></section>' +
      '<div class="card"><div class="card-head"><h3>Still eligible</h3><span class="pill">' + eligible.length + ' of ' + S.players.length + '</span></div><div class="elig">' + (eligible.length ? eligible.map(function (p) { return '<span>' + h(short(p.id)) + '</span>'; }).join('') : '<span class="muted">Everyone has had it.</span>') + '</div></div>' +
      '<div class="card"><h3 style="margin-bottom:6px">Snake log</h3>' + (hist ? '<dl class="results" style="margin-top:4px">' + hist + '</dl>' : '<div class="empty">No Snakes yet.</div>') + '</div>';
  }

  // ---------- HISTORY
  function viewHistory() {
    var rows = (S.hof || []).map(function (x) {
      var ys = Object.keys(x.avg).sort();
      var vals = ys.map(function (y) { return x.avg[y]; });
      var avg = vals.reduce(function (a, b) { return a + b; }, 0) / (vals.length || 1);
      var bestY = ys.reduce(function (b, y) { return b == null || x.avg[y] < x.avg[b] ? y : b; }, null);
      return { x: x, ys: ys, vals: vals, avg: avg, bestY: bestY };
    }).filter(function (o) { return o.ys.length; }).sort(function (a, b) { return a.avg - b.avg; });
    var allYears = {}; rows.forEach(function (o) { o.ys.forEach(function (y) { allYears[y] = 1; }); });
    var yk = Object.keys(allYears).sort();
    var ranks = rankLabels(rows, function (o) { return Math.round(o.avg * 10); });
    var onTrip = {}; S.players.forEach(function (p) { var hf = hofFor(p.name); if (hf) onTrip[hf.name] = p.id; });
    return '<div class="card"><div class="eyebrow">' + (yk.length ? yk[0] + '–' + yk[yk.length - 1] : '') + ' · ' + yk.length + ' trips</div><h2>Hall of Fame</h2>' +
      '<div class="small muted" style="margin:4px 0 10px">Career scoring average on the trip, one average per year. Players on this year\'s trip are highlighted.</div>' +
      '<div class="tbl-wrap"><table class="board"><thead><tr><th></th><th class="l">Player</th><th>Trips</th><th>Best</th><th class="l">By year</th><th>Avg</th></tr></thead><tbody>' +
      rows.map(function (o, i) {
        var mn = 70, mx = 112;
        var spark = '<div class="spark" aria-hidden="true">' + yk.map(function (y) {
          var v = o.x.avg[y];
          return v == null ? '<i style="height:2px;opacity:.15"></i>' : '<i style="height:' + Math.max(3, Math.round((mx - Math.min(mx, v)) / (mx - mn) * 28)) + 'px"></i>';
        }).join('') + '</div>';
        var pid = onTrip[o.x.name];
        return '<tr class="' + (pid ? 'tap' : '') + (pid && pid === me ? ' me' : '') + '"' + (pid ? ' data-a="player" data-p="' + pid + '"' : '') + '><td class="pos-col">' + ranks[i] + '</td><td class="nm l">' + h(o.x.name) + (pid ? ' <span class="pill final" style="font-size:10.5px">' + h(S.trip.name ? 'This trip' : 'Now') + '</span>' : '') + '</td>' +
          '<td class="num">' + o.ys.length + '</td><td class="num">' + o.x.avg[o.bestY] + '<div class="small muted">' + o.bestY + '</div></td><td class="l">' + spark + '</td><td class="big num">' + o.avg.toFixed(1) + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="small muted" style="margin-top:8px">Taller bar = lower average. Every year a man played counts toward his average.</div></div>';
  }

  // ---------- SHEETS
  function sheet() {
    if (!ui.sheet) return '';
    var s = ui.sheet, inner = '';
    if (s.type === 'me') {
      inner = '<div class="row between"><h3>Who are you?</h3><button class="close" data-a="close" aria-label="Close">×</button></div><div class="muted small">This phone will show your tee time, handicap and money first.</div>' +
        '<div class="chips">' + S.players.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (p) {
          return '<button class="chip" data-a="setme" data-p="' + p.id + '" aria-pressed="' + (p.id === me) + '">' + h(p.name) + '</button>';
        }).join('') + '</div>' + (me ? '<button class="linkish" data-a="setme" data-p="">Clear my name</button>' : '');
    } else if (s.type === 'card') inner = cardSheet(s.d, s.p);
    else if (s.type === 'player') inner = playerSheet(s.p);
    else if (s.type === 'login') inner = pinSheet();
    else if (s.type === 'confirm') {
      inner = '<div class="row between"><h3>' + h(s.title) + '</h3><button class="close" data-a="close" aria-label="Close">×</button></div><div class="confirm"><div>' + h(s.msg) + '</div><div class="row wrap"><button class="btn danger" data-a="confirm-yes">' + h(s.yes) + '</button><button class="btn" data-a="close">Cancel</button></div></div>';
    }
    return '<div class="scrim" data-a="scrim"><div class="sheet' + (s.type === 'card' || s.type === 'player' ? ' full' : '') + '" role="dialog" aria-modal="true"><div class="grab"></div>' + inner + '</div></div>';
  }
  function cardSheet(di, pid) {
    var r = R.days[di], d = S.days[di];
    if (!r || !P[pid] || r.courseError || !r.netScores[pid]) return '<button class="close" data-a="close">×</button><div class="empty">No card for this day.</div>';
    var sc = d.scores[pid] || [], par = r.course.par, st = r.strokes[pid], pts = r.points[pid];
    var skinHoles = {}; r.skins.forEach(function (k) { if (k.winner === pid) skinHoles[k.hole] = 1; });
    function half(a, b, lab) {
      var cells = '<div class="hd first">Hole</div>';
      for (var i = a; i < b; i++) cells += '<div class="hd first">' + (i + 1) + '</div>';
      cells += '<div class="hd first">' + lab + '</div>';
      cells += '<div class="hd">Par</div>'; var ps = 0;
      for (i = a; i < b; i++) { cells += '<div class="muted">' + par[i] + '</div>'; ps += par[i]; }
      cells += '<div class="muted">' + ps + '</div>';
      cells += '<div class="hd">Score</div>'; var ss = 0, all = true;
      for (i = a; i < b; i++) { var v = sc[i]; if (v == null) all = false; else ss += v; cells += '<div><span class="sc ' + scClass(v, par[i]) + '">' + (v == null ? '' : v) + dots(st[i]) + '</span></div>'; }
      cells += '<div><b>' + (all ? ss : '') + '</b></div>';
      cells += '<div class="hd">Pts</div>'; var pp = 0;
      for (i = a; i < b; i++) { cells += '<div class="small muted">' + (pts[i] == null ? '' : pts[i]) + '</div>'; pp += pts[i] || 0; }
      cells += '<div class="small">' + pp + '</div>';
      cells += '<div class="hd">Sandy</div>';
      for (i = a; i < b; i++) cells += '<div class="sandy-mark">' + ((r.sandyHoles[pid] || []).indexOf(i) >= 0 ? 'S' : '') + '</div>';
      cells += '<div></div>';
      cells += '<div class="hd">3-putt</div>';
      for (i = a; i < b; i++) cells += '<div class="snake-mark">' + ((r.snake && r.snake.putts[pid] || []).indexOf(i) >= 0 ? '3P' : '') + '</div>';
      cells += '<div></div>';
      cells += '<div class="hd">Skin</div>';
      for (i = a; i < b; i++) cells += '<div class="skin-mark">' + (skinHoles[i + 1] ? '$' : '') + '</div>';
      cells += '<div></div>';
      return '<div class="tbl-wrap"><div class="card-grid" style="min-width:340px">' + cells + '</div></div>';
    }
    // Phone: one tall list, hole by hole, with Out / In / Total rows.
    function vertical() {
      var tp = (r.snake && r.snake.putts[pid]) || [];
      var rows = '', tot = { p: 0, s: 0, pt: 0, all: true }, part;
      function sub(lab, x) {
        return '<tr class="subtot"><td>' + lab + '</td><td>' + x.p + '</td><td><b>' + (x.all ? x.s : '–') + '</b></td><td>' + x.pt + '</td><td></td></tr>';
      }
      [[0, 9, 'Out'], [9, 18, 'In']].forEach(function (seg) {
        part = { p: 0, s: 0, pt: 0, all: true };
        for (var i = seg[0]; i < seg[1]; i++) {
          var v = sc[i];
          part.p += par[i]; part.pt += pts[i] || 0; if (v == null) part.all = false; else part.s += v;
          var marks = (skinHoles[i + 1] ? '<span class="pill gold">Skin</span>' : '') + ((r.sandyHoles[pid] || []).indexOf(i) >= 0 ? '<span class="pill sandy">Sandy</span>' : '') + (tp.indexOf(i) >= 0 ? '<span class="pill snake">3-putt</span>' : '') + (st[i] ? '<span class="strk">' + (st[i] > 1 ? '••' : '•') + '</span>' : '');
          rows += '<tr><td class="hole">' + (i + 1) + '</td><td class="muted">' + par[i] + '</td><td><span class="sc ' + scClass(v, par[i]) + '">' + (v == null ? '' : v) + '</span></td><td class="muted">' + (pts[i] == null ? '' : pts[i]) + '</td><td class="marks">' + marks + '</td></tr>';
        }
        rows += sub(seg[2], part);
        tot.p += part.p; tot.s += part.s; tot.pt += part.pt; tot.all = tot.all && part.all;
      });
      rows += sub('Total', tot).replace('class="subtot"', 'class="subtot grand"');
      return '<table class="vcard"><thead><tr><th>Hole</th><th>Par</th><th>Score</th><th>Pts</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    var hc = r.hcp[pid];
    return '<div class="sheet-head"><div><div class="eyebrow">' + h(d.label || '') + ' · ' + h(r.course.name) + '</div><h3>' + h(nameOf(pid)) + '</h3></div><button class="close" data-a="close" aria-label="Close">×</button></div>' +
      '<div class="tiles n4">' + tile(r.gross[pid] != null ? r.gross[pid] : 'thru ' + r.thru[pid], 'Score', '') + tile(hc ? hc.value : '–', 'Skins hcp', hc ? { tier: 'Day 1 tier', reset: 'From medalist', carry: 'Carried over', override: 'Set by scorer' }[hc.source] : '') +
      tile((r.birdies[pid] || 0) + (r.eagles[pid] ? ' + ' + r.eagles[pid] : ''), r.eagles[pid] ? 'Birdies + eagles' : 'Birdies', '') + tile(r.sandys[pid] || 0, 'Sandys', '') + '</div>' +
      '<div class="card-h">' + half(0, 9, 'Out') + half(9, 18, 'In') + '</div>' +
      '<div class="card-v">' + vertical() + '</div>' +
      '<div class="small muted">Circle = birdie, double circle = eagle, square = bogey, double square = double or worse. Dots = skins strokes on that hole. Pts = team points (no handicap).</div>' +
      (r.pay ? '<div class="row between"><span>Money this day</span><b class="' + sgnClass(r.pay[pid].net) + '">' + signed(r.pay[pid].net) + '</b></div>' : '');
  }
  function playerSheet(pid) {
    var p = P[pid]; if (!p) return '';
    var t = R.totals[pid], hf = hofFor(p.name);
    var rows = R.days.map(function (r, i) {
      if (r.players.indexOf(pid) < 0) return '';
      var d = S.days[i];
      return '<tr class="tap" data-a="card" data-d="' + i + '" data-p="' + pid + '"><td class="l">' + h(d.label || ('Day ' + (i + 1))) + '<div class="small muted">' + h(r.course ? r.course.name : '') + '</div></td><td class="num">' + (r.hcp[pid] ? r.hcp[pid].value : '–') + '</td><td class="big num">' + (r.gross[pid] != null ? r.gross[pid] : (r.thru[pid] ? 'thru ' + r.thru[pid] : '–')) + '</td><td class="num ' + (r.pay ? sgnClass(r.pay[pid].net) : 'muted') + '">' + (r.pay ? signed(r.pay[pid].net) : '–') + '</td></tr>';
    }).join('');
    var hist = hf ? Object.keys(hf.avg).sort().map(function (y) { return '<span class="pill">' + y + ' · <b>' + hf.avg[y] + '</b></span>'; }).join(' ') : '';
    return '<div class="sheet-head"><div><div class="eyebrow">Tier ' + p.tier + '</div><h3>' + h(p.name) + '</h3></div><button class="close" data-a="close" aria-label="Close">×</button></div>' +
      '<div class="tiles n4">' + tile(t.avg ? t.avg.toFixed(1) : '–', 'Trip average', t.rounds + ' round' + (t.rounds === 1 ? '' : 's')) + tile(t.low != null ? t.low : '–', 'Low round', '') +
      tile(t.birdies + t.eagles, 'Birdies & eagles', t.sandys + ' Sandys') + tile(t.daysPaid ? signed(t.moneyNet) : '–', 'Money', t.skins + ' skins') + '</div>' +
      '<div class="tbl-wrap"><table class="board"><thead><tr><th class="l">Day</th><th>Skins hcp</th><th>Score</th><th>Money</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (hist ? '<div><div class="eyebrow" style="margin-bottom:6px">Past trips</div><div class="row wrap" style="gap:6px">' + hist + '</div></div>' : '');
  }

  // ---------- ADMIN
  function currentGroup() {
    var r = R.days[ui.day]; if (!r) return null;
    var g = r.groups[ui.group]; if (!g) { ui.group = 0; g = r.groups[0]; }
    return g && g.playerIds.filter(function (x) { return x && P[x]; }).length ? g : null;
  }
  function adminBar() {
    var st;
    if (admin.publishing) st = 'Publishing…';
    else if (admin.dirty) st = '<b>Unpublished changes.</b> Only this phone has them.';
    else st = 'Everyone sees the latest version.';
    if (net.ok === false) st += '<div class="small muted">No connection right now. Keep entering. Publish when you have signal.</div>';
    var remote = admin.remote ? '<div class="banner"><b>A newer version was saved</b> from another device' + (admin.remote.savedAt ? ' at ' + h(new Date(admin.remote.savedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) : '') + '. Pick one:' +
      '<div class="row wrap" style="margin-top:8px"><button class="btn sm" data-a="remote-load">Use the saved version (drop my edits)</button><button class="btn sm danger" data-a="remote-force">Publish mine over it</button></div></div>' : '';
    return '<div class="admin-bar"><div class="st">' + st + '<div class="small"><button class="linkish" data-a="logout">Log out</button></div></div>' +
      '<button class="btn primary" data-a="publish"' + (!admin.dirty || admin.publishing ? ' disabled' : '') + '>Publish</button></div>' + remote;
  }
  function viewAdmin() {
    var out = adminBar() + '<div class="seg"><button data-a="asub" data-m="scores" aria-pressed="' + (ui.admin === 'scores') + '">Enter scores</button><button data-a="asub" data-m="setup" aria-pressed="' + (ui.admin === 'setup') + '">Setup</button></div>';
    return out + (ui.admin === 'setup' ? viewSetup() : viewEntry());
  }
  function viewEntry() {
    var di = ui.day, d = S.days[di], r = R.days[di];
    if (!d) return '<div class="card empty">Add a day in Setup first.</div>';
    if (r.courseError) return '<div class="card"><div class="banner"><b>Fix the scorecard first.</b> ' + h(r.courseError) + ' Go to Setup → Courses.</div></div>';
    if (!r.groups.length) return '<div class="card empty">Set the groups for this day in Setup first.</div>';
    var chips = (r.auto && !r.auto.locked && r.status === 'upcoming' ? '<div class="banner"><b>Heads up.</b> These groups are still a projection. They lock once every earlier day is final.</div>' : '') + '<div class="chips">' + r.groups.map(function (g, gi) {
      var ids = g.playerIds.filter(function (x) { return x && P[x]; });
      var done = ids.filter(function (x) { return r.thru[x] === 18; }).length;
      return '<button class="chip" data-a="grp" data-i="' + gi + '" aria-pressed="' + (gi === ui.group) + '">' + h(g.time || g.name || 'Group ' + (gi + 1)) + ' <span class="muted">' + done + '/' + ids.length + '</span></button>';
    }).join('') + '</div>';
    var g = currentGroup();
    if (!g) return chips + '<div class="card empty">This group has no players.</div>';
    var ids = g.playerIds.filter(function (x) { return x && P[x]; });
    if (ui.cur.p >= ids.length) ui.cur = { p: 0, h: 0 };
    var par = r.course.par;
    var cards = ids.map(function (pid, pi) {
      var sc = d.scores[pid] || [];
      var row = function (a, b, lab) {
        var s = '<div class="lab left">' + (a === 0 ? 'Out' : 'In') + '</div>';
        for (var i = a; i < b; i++) s += '<div class="lab">' + (i + 1) + '<br><span style="font-weight:500">' + par[i] + '</span></div>';
        s += '<div class="lab">' + lab + '</div><div></div>';
        var tot = 0, all = true;
        for (i = a; i < b; i++) {
          var v = sc[i]; if (v == null) all = false; else tot += v;
          var act = ui.cur.p === pi && ui.cur.h === i;
          s += '<button class="cell ' + scClass(v, par[i]) + (act ? ' active' : '') + '" data-a="cell" data-p="' + pi + '" data-h="' + i + '" aria-label="' + h(short(pid)) + ' hole ' + (i + 1) + '">' + (v == null ? '' : v) + (r.strokes[pid][i] ? '<span class="k">' + (r.strokes[pid][i] > 1 ? '••' : '•') + '</span>' : '') + (hasTP(d, pid, i) ? '<span class="tp">3P</span>' : '') + (hasSandy(d, pid, i) || (r.sandyHoles[pid] || []).indexOf(i) >= 0 ? '<span class="sd">S</span>' : '') + '</button>';
        }
        s += '<div class="tot num">' + (all ? tot : '') + '</div>';
        return s;
      };
      var sandy = r.sandys[pid] || 0;
      return '<div class="entry"><div class="who"><b>' + h(nameOf(pid)) + ' <span class="muted small">skins hcp ' + r.hcp[pid].value + '</span></b>' +
        '<span class="small muted">Sandys: <b class="num">' + sandy + '</b></span></div>' +
        '<div class="egrid">' + row(0, 9, '') + row(9, 18, '') + '</div>' +
        '<div class="row between small" style="margin-top:6px"><span class="muted">Thru ' + r.thru[pid] + '</span><b class="num">' + (r.gross[pid] != null ? 'Total ' + r.gross[pid] : '') + '</b></div></div>';
    }).join('');
    return chips + '<div class="small muted">Read each card left to right. Tap a number and it moves to the next hole. For a Sandy or 3-putt, tap that button first, then the score. Tap any box to fix it. Dots show skins strokes.</div>' + cards;
  }
  function keypad() {
    var r = R.days[ui.day], g = currentGroup(); if (!g) return '';
    var ids = g.playerIds.filter(function (x) { return x && P[x]; });
    var pid = ids[ui.cur.p], hh = ui.cur.h, par = r.course.par[hh];
    var btn = function (n) { return '<button data-a="key" data-v="' + n + '" class="' + (n === par ? 'par' : '') + '">' + n + '</button>'; };
    var keys = ui.ten ? [10, 11, 12, 13, 14, 15].map(btn).join('') + '<button class="fn" data-a="ten">1–9</button><button class="fn" data-a="prev">‹ Back</button><button></button><button></button><button class="fn" data-a="clear">Clear</button><button class="fn" data-a="next">Next ›</button>'
      : [1, 2, 3, 4, 5, 6, 7, 8, 9].map(btn).join('') + '<button class="fn" data-a="ten">10+</button><button class="fn" data-a="clear">Clear</button><button class="fn" data-a="next">Next ›</button>';
    var k = r.strokes[pid] ? r.strokes[pid][hh] : 0;
    return '<div class="keypad"><div class="keypad-in"><div class="kp-status"><span><b>' + h(short(pid)) + '</b> · Hole ' + (hh + 1) + ' · Par ' + par + ' · SI ' + r.course.si[hh] + (k ? ' · ' + k + ' skins stroke' + (k > 1 ? 's' : '') : '') + '</span><span class="marks-btns"><button class="tp-btn sandy" data-a="sandyhole" aria-pressed="' + hasSandy(S.days[ui.day], pid, hh) + '">Sandy</button><button class="tp-btn" data-a="tp" aria-pressed="' + hasTP(S.days[ui.day], pid, hh) + '">3-putt</button></span></div><div class="kp">' + keys + '</div></div></div>';
  }
  function hasTP(d, pid, hole) { return ((d.threePutts || {})[pid] || []).indexOf(hole) >= 0; }
  function hasSandy(d, pid, hole) { return ((d.sandyHoles || {})[pid] || []).indexOf(hole) >= 0; }
  // Toggle a per-hole mark (3-putt or Sandy) on the current cell. Does not move the cursor.
  function toggleMark(key) {
    var d = S.days[ui.day], g = currentGroup(); if (!g) return;
    var pid = g.playerIds.filter(function (x) { return x && P[x]; })[ui.cur.p];
    d[key] = d[key] || {};
    if (key === 'sandyHoles' && d.sandys) delete d.sandys[pid];
    var arr = (d[key][pid] || []).slice(), k = arr.indexOf(ui.cur.h);
    if (k >= 0) arr.splice(k, 1); else arr.push(ui.cur.h);
    if (arr.length) d[key][pid] = arr; else if (key === 'sandyHoles') d[key][pid] = []; else delete d[key][pid];
    markDirty(); render();
  }
  function enterScore(v) {
    var d = S.days[ui.day], g = currentGroup(); if (!g) return;
    var ids = g.playerIds.filter(function (x) { return x && P[x]; });
    var pid = ids[ui.cur.p];
    var arr = d.scores[pid] = (d.scores[pid] || []).slice();
    while (arr.length < 18) arr.push(null);
    arr[ui.cur.h] = v;
    ui.ten = false;
    markDirty();
    if (v != null) advance(ids.length);
    else render();
  }
  function advance(n, back) {
    if (back) { if (ui.cur.h > 0) ui.cur.h--; else if (ui.cur.p > 0) { ui.cur.p--; ui.cur.h = 17; } }
    else if (ui.cur.h < 17) ui.cur.h++;
    else if (ui.cur.p < n - 1) { ui.cur.p++; ui.cur.h = 0; }
    else { toast('Group done. Publish when ready.'); }
    ui._scrollCell = true;
    render();
  }

  // ---------- SETUP
  function sec(key, title, sub, body) {
    return '<details class="sec" data-sec="' + key + '"' + (ui.open[key] ? ' open' : '') + '><summary><div><h3>' + h(title) + '</h3>' + (sub ? '<div class="small muted">' + sub + '</div>' : '') + '</div></summary><div class="body">' + body + '</div></details>';
  }
  function inp(id, path, val, opts) {
    opts = opts || {};
    return '<input class="inp" id="' + id + '" data-f="' + path + '"' + (opts.num ? ' data-num="' + opts.num + '" inputmode="' + (opts.num === 'int' ? 'numeric' : 'decimal') + '"' : '') + ' type="' + (opts.type || 'text') + '" value="' + h(val == null ? '' : val) + '"' + (opts.ph ? ' placeholder="' + h(opts.ph) + '"' : '') + '>';
  }
  function field(label, html) { return '<label class="f">' + h(label) + html + '</label>'; }
  function autoSetup(d, di, r) {
    var slots = (d.teeSlots || []).map(function (t, k) {
      return '<div class="row">' + inp('ts' + di + '-' + k, 'days.' + di + '.teeSlots.' + k, t, { ph: 'Tee time, e.g. 8:00' }) + '<button class="btn sm danger" data-a="del-slot" data-d="' + di + '" data-i="' + k + '">Remove</button></div>';
    }).join('');
    var need = Math.ceil(r.players.length / 4), have = (d.teeSlots || []).filter(function (t) { return t; }).length;
    return '<div class="eyebrow">Tee times</div><div class="small muted">Enter them in any order. The earliest goes to the four lowest trip totals, the next to the next four, and so on.</div>' + slots +
      (have < need ? '<div class="err">Add ' + (need - have) + ' more tee time' + (need - have > 1 ? 's' : '') + ' so every foursome has one.</div>' : '') +
      '<button class="btn sm" data-a="add-slot" data-d="' + di + '">Add tee time</button>' +
      '<div class="eyebrow" style="margin-top:6px">' + (r.auto && r.auto.locked ? 'Foursomes' : 'Projected foursomes') + '</div>' +
      r.groups.map(function (g) { return '<div class="small"><b>' + h(g.time || 'No time') + '</b> · ' + g.playerIds.map(function (x) { return h(short(x)); }).join(', ') + '</div>'; }).join('');
  }
  function viewSetup() {
    var out = '';
    // trip
    out += sec('trip', 'Trip', h(S.trip.name), '<div class="form">' + field('Trip name', inp('t-name', 'trip.name', S.trip.name)) + field('Place / lodging', inp('t-place', 'trip.place', S.trip.place)) + '</div>');
    // stakes
    var bi = buyinPerDay();
    out += sec('stakes', 'Games & stakes', '$' + bi + ' a man per day', '<div class="form">' +
      field('Sandys/Birdies/Eagles $', inp('s-sbe', 'stakes.sbe', S.stakes.sbe, { num: 'money' })) + field('Sides $', inp('s-sides', 'stakes.sides', S.stakes.sides, { num: 'money' })) +
      field('Skins $', inp('s-skins', 'stakes.skins', S.stakes.skins, { num: 'money' })) + field('6-6-6 $', inp('s-six', 'stakes.six', S.stakes.six, { num: 'money' })) +
      field('Units per eagle', inp('s-eu', 'stakes.eagleUnits', S.stakes.eagleUnits, { num: 'int' })) + '</div>' +
      '<div class="small muted">With ' + S.players.length + ' players that\'s $' + (bi * S.players.length) + ' a day. Each pot is split by points won. If nobody wins a pot, everyone gets his money back.</div>');
    // tier hcp
    out += sec('tiers', 'Day 1 handicaps', 'Set by tier. From Day 2 on, handicaps reset from the previous day\'s medalist.', '<div class="form">' + [1, 2, 3, 4].map(function (t) {
      return field(t + '-men', inp('tier-' + t, 'tierHcp.' + t, (S.tierHcp || {})[t], { num: 'int' }));
    }).join('') + '</div>');
    // players
    var tierCounts = [0, 0, 0, 0, 0]; S.players.forEach(function (p) { tierCounts[p.tier] = (tierCounts[p.tier] || 0) + 1; });
    var tierWarn = S.players.length % 4 === 0 && [1, 2, 3, 4].some(function (t) { return tierCounts[t] !== S.players.length / 4; });
    out += sec('players', 'Players', S.players.length + ' players · tiers ' + [1, 2, 3, 4].map(function (t) { return tierCounts[t] || 0; }).join('/'),
      S.players.map(function (p, i) {
        return '<div class="prow"><input class="inp" id="pn-' + p.id + '" data-f="players.' + i + '.name" value="' + h(p.name) + '" aria-label="Player name"><input class="inp" id="pk-' + p.id + '" data-f="players.' + i + '.nick" value="' + h(p.nick || '') + '" placeholder="Nickname" aria-label="Nickname shown in the app">' +
          '<select class="inp" id="pt-' + p.id + '" data-f="players.' + i + '.tier" data-num="int" aria-label="Tier">' + [1, 2, 3, 4].map(function (t) { return '<option value="' + t + '"' + (p.tier === t ? ' selected' : '') + '>' + t + '-man</option>'; }).join('') + '</select>' +
          '<button class="btn sm danger" data-a="del-player" data-p="' + p.id + '" aria-label="Remove ' + h(p.name) + '">Remove</button></div>';
      }).join('') + (tierWarn ? '<div class="err">Each tier should have ' + (S.players.length / 4) + ' players so every group gets one of each.</div>' : '') +
      '<div class="row"><input class="inp" id="new-player" placeholder="New player name"><button class="btn" data-a="add-player">Add</button></div>');
    // courses
    out += sec('courses', 'Courses', S.courses.length + ' course' + (S.courses.length === 1 ? '' : 's'), S.courses.map(function (c, ci) {
      var prob = Engine.courseProblem(c);
      var grid = function (key, a, b) {
        var s = '<div class="lab left">' + (key === 'par' ? 'Par' : 'SI') + '</div>';
        for (var i = a; i < b; i++) s += '<input id="c' + ci + key + i + '" data-f="courses.' + ci + '.' + key + '.' + i + '" data-num="int" inputmode="numeric" value="' + h(c[key][i] == null ? '' : c[key][i]) + '" aria-label="' + (key === 'par' ? 'Par' : 'Stroke index') + ' hole ' + (i + 1) + '">';
        return s;
      };
      var head = function (a, b) { var s = '<div class="lab left">Hole</div>'; for (var i = a; i < b; i++) s += '<div class="lab">' + (i + 1) + '</div>'; return s; };
      var total = c.par.reduce(function (a, b) { return a + (+b || 0); }, 0);
      var used = S.days.some(function (d) { return d.courseId === c.id; });
      return '<div class="card flat stack"><div class="row between"><div style="flex:1">' + field('Course name', inp('cn' + ci, 'courses.' + ci + '.name', c.name)) + '</div>' +
        (used ? '' : '<button class="btn sm danger" data-a="del-course" data-i="' + ci + '">Remove</button>') + '</div>' +
        '<div class="hole-inputs">' + head(0, 9) + grid('par', 0, 9) + grid('si', 0, 9) + '</div><div class="hole-inputs">' + head(9, 18) + grid('par', 9, 18) + grid('si', 9, 18) + '</div>' +
        '<div class="row between"><span class="small muted">Par ' + total + '. SI = stroke index from the card (1 = hardest hole).</span>' + (prob ? '<span class="err">' + h(prob) + '</span>' : '<span class="okc">Card is valid</span>') + '</div></div>';
    }).join('') + '<button class="btn" data-a="add-course">Add course</button>');
    // days
    out += sec('days', 'Days, groups & tee times', S.days.length + ' days', S.days.map(function (d, di) {
      var r = R.days[di];
      var assigned = {}, dupes = [];
      d.groups.forEach(function (g) { g.playerIds.forEach(function (x) { if (!x) return; if (assigned[x]) dupes.push(x); assigned[x] = 1; }); });
      var missing = S.players.filter(function (p) { return !assigned[p.id]; });
      var hasScores = Object.keys(d.scores).some(function (k) { return (d.scores[k] || []).some(function (v) { return v != null; }); });
      var groups = d.groups.map(function (g, gi) {
        return '<div class="grow"><div class="stack" style="gap:6px">' + (d.autoByTotal ? '' : inp('gt' + di + '-' + gi, 'days.' + di + '.groups.' + gi + '.time', g.time, { ph: 'Tee time' })) + inp('gn' + di + '-' + gi, 'days.' + di + '.groups.' + gi + '.name', g.name, { ph: d.autoByTotal ? 'Team name' : 'Group name' }) +
          '<button class="btn sm danger" data-a="del-group" data-d="' + di + '" data-i="' + gi + '">Remove ' + (d.autoByTotal ? 'team' : 'group') + '</button></div><div class="ps">' +
          [0, 1, 2, 3].map(function (k) {
            var cur = g.playerIds[k] || '';
            return '<select class="inp" id="gp' + di + '-' + gi + '-' + k + '" data-f="days.' + di + '.groups.' + gi + '.playerIds.' + k + '" aria-label="Player ' + (k + 1) + '"><option value="">— empty —</option>' +
              S.players.slice().sort(function (a, b) { return a.tier - b.tier || a.name.localeCompare(b.name); }).map(function (p) { return '<option value="' + p.id + '"' + (p.id === cur ? ' selected' : '') + '>' + p.tier + ' · ' + h(p.name) + (assigned[p.id] && p.id !== cur ? ' (placed)' : '') + '</option>'; }).join('') + '</select>';
          }).join('') + '</div></div>';
      }).join('');
      var ovs = r.players.map(function (pid) {
        var ov = d.hcpOverride[pid];
        var auto = r.hcp[pid];
        return '<label class="f">' + h(short(pid)) + '<input class="inp" id="ov' + di + '-' + pid + '" data-ov="' + di + '" data-p="' + pid + '" inputmode="numeric" placeholder="Auto: ' + (auto && auto.source !== 'override' ? auto.value : '') + '" value="' + (typeof ov === 'number' ? ov : '') + '"></label>';
      }).join('');
      return '<div class="card flat stack"><div class="row between"><h3>' + h(d.label || ('Day ' + (di + 1))) + '</h3><button class="btn sm danger" data-a="del-day" data-i="' + di + '">Remove day</button></div>' +
        '<div class="form">' + field('Label', inp('dl' + di, 'days.' + di + '.label', d.label)) + field('Date', inp('dd' + di, 'days.' + di + '.date', d.date, { type: 'date' })) +
        field('Course', '<select class="inp" id="dc' + di + '" data-f="days.' + di + '.courseId"><option value="">Pick a course</option>' + S.courses.map(function (c) { return '<option value="' + c.id + '"' + (c.id === d.courseId ? ' selected' : '') + '>' + h(c.name) + '</option>'; }).join('') + '</select>') +
        field('Notes (shown to everyone)', inp('dn' + di, 'days.' + di + '.notes', d.notes, { ph: 'e.g. Carts at 7:30, bring cash' })) + '</div>' +
        '<label class="row small" style="gap:8px;font-weight:600"><input type="checkbox" id="auto' + di + '" data-auto="' + di + '"' + (d.autoByTotal ? ' checked' : '') + '> Tee off by trip total (lowest four first, updates every day). Teams stay as set below.</label>' +
        (d.autoByTotal ? autoSetup(d, di, r) : '') +
        '<div class="row between wrap" style="margin-top:6px"><span class="eyebrow">' + (d.autoByTotal ? 'Teams for sides &amp; 6-6-6' : 'Groups (each group is a team)') + '</span><span class="row" style="gap:6px"><button class="btn sm" data-a="draw" data-d="' + di + '">Draw teams by tier</button><button class="btn sm" data-a="add-group" data-d="' + di + '">Add ' + (d.autoByTotal ? 'team' : 'group') + '</button></span></div>' +
        (hasScores ? '<div class="small muted">Scores are already in for this day. Changing teams changes the team results.</div>' : '') +
        groups +
        (dupes.length ? '<div class="err">In two groups: ' + dupes.map(function (x) { return h(short(x)); }).join(', ') + '</div>' : '') +
        (missing.length ? '<div class="small muted">Not in a group: ' + missing.map(function (p) { return h(short(p.id)); }).join(', ') + '</div>' : '<div class="okc">Everyone is placed.</div>') +
        (r.players.length ? '<details><summary class="small" style="cursor:pointer;font-weight:600">Override handicaps for this day</summary><div class="form" style="margin-top:8px">' + ovs + '</div><div class="small muted" style="margin-top:6px">Leave blank to use the automatic handicap.</div></details>' : '') +
        '</div>';
    }).join('') + '<button class="btn" data-a="add-day">Add day</button>');
    // data
    var year = ui.hofYear || ((S.days[0] && S.days[0].date) ? S.days[0].date.slice(0, 4) : String(new Date().getFullYear()));
    out += sec('data', 'Trip data', 'Start fresh, back up, restore, Hall of Fame',
      '<div class="stack"><div><b>Start a new trip</b><div class="small muted">Clears every score, Sandy, 3-putt and handicap override. Keeps players, courses, groups and the Hall of Fame. Removes the demo banner.</div></div><button class="btn danger" data-a="ask-new">Start new trip…</button></div>' +
      '<div class="stack"><div><b>Backup</b><div class="small muted">Copies all trip data as text. Paste it into a note or email so you have a copy.</div></div><button class="btn" data-a="copy-backup">Copy backup</button></div>' +
      '<div class="stack"><div><b>Restore from backup</b><div class="small muted">Paste backup text, then Restore. This replaces everything on this device until you publish.</div></div><textarea class="inp" id="import-box" placeholder="Paste backup here">' + h(ui.importText) + '</textarea><button class="btn" data-a="import">Restore</button></div>' +
      '<div class="stack"><div><b>Add this trip to the Hall of Fame</b><div class="small muted">Saves each player\'s scoring average under the year below. Running it again for the same year replaces that year.</div></div><div class="row"><input class="inp" id="hof-year" inputmode="numeric" value="' + h(year) + '" style="max-width:110px" aria-label="Year"><button class="btn" data-a="hof-add">Add to Hall of Fame</button></div></div>');
    return out;
  }

  // ---------- mutations
  function markDirty() {
    admin.dirty = true;
    if (!LS.set(DRAFT_KEY, { baseRev: baseRev, state: S })) admin.hasDraftStore = false;
  }
  function setPath(obj, path, val) {
    var parts = path.split('.'), o = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = parts[i];
      if (o[k] == null) o[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      o = o[k];
    }
    o[parts[parts.length - 1]] = val;
  }
  function parseNum(v, kind) {
    if (v === '' || v == null) return null;
    var n = Number(v); if (!isFinite(n)) return null;
    if (kind === 'int') return Math.round(n);
    return Math.round(n * 100) / 100;
  }
  function drawTeams(di) {
    var d = S.days[di];
    var tiers = [1, 2, 3, 4].map(function (t) { return S.players.filter(function (p) { return p.tier === t; }).map(function (p) { return p.id; }); });
    tiers.forEach(function (a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } });
    var n = Math.max(1, Math.ceil(S.players.length / 4));
    var groups = [];
    for (var g = 0; g < n; g++) {
      var old = d.groups[g] || {};
      groups.push({ id: old.id || 'g' + rid(), name: old.name || (d.autoByTotal ? 'Team ' : 'Group ') + (g + 1), time: d.autoByTotal ? '' : (old.time || ''), playerIds: [] });
    }
    var left = [];
    tiers.forEach(function (a) { a.forEach(function (pid, i) { if (i < n) groups[i].playerIds.push(pid); else left.push(pid); }); });
    left.forEach(function (pid) { var tgt = groups.find(function (x) { return x.playerIds.length < 4; }); if (tgt) tgt.playerIds.push(pid); });
    d.groups = groups;
  }
  function doConfirm(action) {
    if (action.kind === 'logout') { ui.sheet = null; logout(); return; }
    if (action.kind === 'newtrip') {
      S.days.forEach(function (d) { d.scores = {}; d.sandys = {}; d.sandyHoles = {}; d.threePutts = {}; d.hcpOverride = {}; d.paid = {}; });
      S.demo = false; toast('Scores cleared. Publish to make it official.');
    } else if (action.kind === 'del-player') {
      var pid = action.id;
      S.players = S.players.filter(function (p) { return p.id !== pid; });
      S.days.forEach(function (d) {
        d.groups.forEach(function (g) { g.playerIds = g.playerIds.map(function (x) { return x === pid ? '' : x; }); });
        delete d.scores[pid]; delete d.sandys[pid]; delete (d.sandyHoles || {})[pid]; delete (d.threePutts || {})[pid]; delete d.hcpOverride[pid];
      });
      if (me === pid) { me = null; LS.del(ME_KEY); }
    } else if (action.kind === 'del-day') {
      S.days.splice(action.i, 1); ui.day = Math.max(0, Math.min(ui.day, S.days.length - 1));
    } else if (action.kind === 'import') {
      S = action.state; S.rev = baseRev; ui.importText = ''; ui.day = null; toast('Backup loaded. Publish to share it.');
    }
    markDirty(); ui.sheet = null; render();
  }
  function validState(x) {
    return x && typeof x === 'object' && Array.isArray(x.players) && Array.isArray(x.courses) && Array.isArray(x.days) && x.stakes && x.trip;
  }

  // ---------- server sync
  function api(method, path, body, withPin) {
    var headers = { 'Content-Type': 'application/json' };
    if (withPin && pin) headers['x-scorer-pin'] = pin;
    return fetch(API + path, { method: method, headers: headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); });
  }
  // Pull the latest saved trip. Viewers take it; the scorer keeps unpublished edits and is told if the server moved on.
  function pull() {
    return api('GET', '/state').then(function (x) {
      if (x.status !== 200) { net.ok = false; render(); return; }
      net.ok = true;
      var st = x.j.state;
      net.serverOlder = !!(st && String(st.savedAt || '') < SEED_AT);
      if (net.serverOlder) st = null;
      if (st && validState(st)) {
        LS.set(CACHE_KEY, { state: st });
        if (admin.dirty) admin.remote = st.rev !== baseRev ? st : null;
        else if (st.rev !== S.rev) { S = st; baseRev = st.rev; }
        else baseRev = st.rev;
      }
      render();
    }, function () { net.ok = false; render(); });
  }
  function publish(force) {
    if (!pin || admin.publishing) return;
    admin.publishing = true; render();
    api('PUT', '/state', { baseRev: baseRev, state: S, force: !!force || !!net.serverOlder }, true).then(function (x) {
      admin.publishing = false;
      if (x.status === 200 && x.j.state) {
        S = x.j.state; baseRev = S.rev; admin.dirty = false; admin.remote = null; net.ok = true; net.serverOlder = false;
        LS.del(DRAFT_KEY); LS.set(CACHE_KEY, { state: S });
        toast('Published. Everyone sees it within 30 seconds.');
        return;
      }
      if (x.status === 409 && x.j.state) { admin.remote = x.j.state; render(); toast('A newer version was saved from another device.'); return; }
      if (x.status === 401) { logout(); toast(x.j.error || 'PIN not accepted. Log in again.'); return; }
      render(); toast(x.j.error || 'Save failed. Your edits are safe on this phone.');
    }, function () {
      admin.publishing = false; net.ok = false; render();
      toast('No signal. Your edits are safe on this phone. Publish again when you have service.');
    });
  }
  // Logging out keeps any unpublished edits on this phone; they come back at the next login.
  function logout() {
    pin = null; LS.del(PIN_KEY); admin.on = false;
    if (ui.tab === 'admin') ui.tab = 'today';
    if (admin.dirty) { S = (LS.get(CACHE_KEY) || {}).state || S; admin.dirty = false; admin.remote = null; baseRev = S.rev; }
    render();
  }
  function pinSheet() {
    var dots = '';
    for (var i = 0; i < Math.max(5, ui.pinEntry.length); i++) dots += '<span class="' + (i < ui.pinEntry.length ? 'on' : '') + '"></span>';
    var keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (n) { return '<button data-a="pinkey" data-v="' + n + '">' + n + '</button>'; }).join('') +
      '<button class="fn" data-a="pinback" aria-label="Delete">⌫</button><button data-a="pinkey" data-v="0">0</button><button class="fn go" data-a="pingo"' + (ui.pinEntry.length < 4 || ui.pinBusy ? ' disabled' : '') + '>' + (ui.pinBusy ? '…' : 'Log in') + '</button>';
    return '<div class="sheet-head"><div><div class="eyebrow">Scorer</div><h3>Enter PIN</h3></div><button class="close" data-a="close" aria-label="Close">×</button></div>' +
      '<div class="pin-dots" aria-label="' + ui.pinEntry.length + ' digits entered">' + dots + '</div>' +
      (ui.pinErr ? '<div class="err" style="text-align:center">' + h(ui.pinErr) + '</div>' : '<div class="small muted" style="text-align:center">Only the scorer can enter and publish scores.</div>') +
      '<div class="kp pin-kp">' + keys + '</div>';
  }
  function tryLogin() {
    if (ui.pinBusy || ui.pinEntry.length < 4) return;
    ui.pinBusy = true; ui.pinErr = ''; render();
    var entered = ui.pinEntry;
    api('POST', '/login', { pin: entered }).then(function (x) {
      ui.pinBusy = false;
      if (x.status === 200) {
        pin = entered; LS.set(PIN_KEY, pin); admin.on = true; ui.pinEntry = ''; ui.sheet = null; ui.tab = 'admin';
        var d = LS.get(DRAFT_KEY);
        if (d && validState(d.state)) { S = d.state; baseRev = d.baseRev; admin.dirty = true; pull(); }
        render(); toast('Logged in as scorer.');
      } else { ui.pinEntry = ''; ui.pinErr = x.j.error || 'That PIN didn\'t work.'; render(); }
    }, function () { ui.pinBusy = false; ui.pinErr = 'No connection. Try again when you have signal.'; render(); });
  }

  // ---------- events
  var H = {
    tab: function (t) { ui.tab = t.dataset.t; ui.sheet = null; try { history.replaceState(null, '', '#' + ui.tab); } catch (e) { } window.scrollTo(0, 0); render(); },
    day: function (t) { ui.day = +t.dataset.i; ui.group = 0; ui.cur = { p: 0, h: 0 }; render(); },
    me: function () { ui.sheet = { type: 'me' }; render(); },
    setme: function (t) { me = t.dataset.p || null; if (me) LS.set(ME_KEY, me); else LS.del(ME_KEY); ui.sheet = null; render(); },
    close: function () { ui.sheet = null; render(); },
    scrim: function (t, e) { if (e.target === t) { ui.sheet = null; render(); } },
    board: function (t) { ui.board = t.dataset.m; render(); },
    sortnet: function (t) { ui.sortNet = t.dataset.v === '1'; render(); },
    money: function (t) { ui.money = t.dataset.m; render(); },
    roster: function (t) { ui.roster = t.dataset.m; render(); },
    card: function (t) { ui.sheet = { type: 'card', d: +t.dataset.d, p: t.dataset.p }; render(); },
    player: function (t) { ui.sheet = { type: 'player', p: t.dataset.p }; render(); },
    asub: function (t) { ui.admin = t.dataset.m; render(); },
    grp: function (t) { ui.group = +t.dataset.i; ui.cur = { p: 0, h: 0 }; ui.ten = false; render(); },
    cell: function (t) { ui.cur = { p: +t.dataset.p, h: +t.dataset.h }; ui.ten = false; render(); },
    key: function (t) { enterScore(+t.dataset.v); },
    clear: function () { enterScore(null); },
    tp: function () { toggleMark('threePutts'); },
    sandyhole: function () { toggleMark('sandyHoles'); },
    ten: function () { ui.ten = !ui.ten; render(); },
    next: function () { var g = currentGroup(); if (g) advance(g.playerIds.filter(function (x) { return x && P[x]; }).length); },
    prev: function () { ui.ten = false; advance(0, true); },
    publish: function () { publish(0); },
    paid: function (t) {
      var d = S.days[+t.dataset.d]; d.paid = d.paid || {};
      if (d.paid[t.dataset.p]) delete d.paid[t.dataset.p]; else d.paid[t.dataset.p] = true;
      markDirty(); render();
    },
    'paid-clear': function (t) { S.days[+t.dataset.d].paid = {}; markDirty(); render(); },
    'remote-load': function () { S = admin.remote; baseRev = S.rev; admin.remote = null; admin.dirty = false; LS.del(DRAFT_KEY); ui.day = null; render(); toast('Loaded the saved version.'); },
    'remote-force': function () { publish(true); },
    login: function () { ui.sheet = { type: 'login' }; ui.pinEntry = ''; ui.pinErr = ''; render(); },
    logout: function () {
      if (admin.dirty) { ui.sheet = { type: 'confirm', title: 'Log out with unpublished edits?', msg: 'Your edits stay saved on this phone and come back when you log in again. Nobody else sees them until you publish.', yes: 'Log out', action: { kind: 'logout' } }; render(); }
      else logout();
    },
    pinkey: function (t) { if (ui.pinEntry.length < 8) { ui.pinEntry += t.dataset.v; ui.pinErr = ''; render(); } },
    pinback: function () { ui.pinEntry = ui.pinEntry.slice(0, -1); render(); },
    pingo: function () { tryLogin(); },
    'add-player': function () {
      var el = document.getElementById('new-player'); var n = el && el.value.trim();
      if (!n) { toast('Type a name first.'); return; }
      S.players.push({ id: 'p' + rid(), name: n, tier: 4 }); markDirty(); render();
    },
    'del-player': function (t) {
      var pid = t.dataset.p;
      var has = S.days.some(function (d) { return (d.scores[pid] || []).some(function (v) { return v != null; }); });
      ui.sheet = { type: 'confirm', title: 'Remove ' + nameOf(pid) + '?', msg: has ? 'He has scores entered. Removing him deletes them and changes that day\'s money.' : 'He will be taken out of every group.', yes: 'Remove player', action: { kind: 'del-player', id: pid } };
      render();
    },
    'add-course': function () {
      S.courses.push({ id: 'c' + rid(), name: 'New course', par: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], si: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null] });
      ui.open.courses = true; markDirty(); render();
    },
    'del-course': function (t) { S.courses.splice(+t.dataset.i, 1); markDirty(); render(); },
    'add-day': function () {
      var last = S.days[S.days.length - 1], date = '';
      if (last && last.date) { var dt = new Date(last.date + 'T12:00:00'); dt.setDate(dt.getDate() + 1); date = dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()); }
      S.days.push({ id: 'd' + rid(), label: 'Day ' + (S.days.length + 1), date: date, courseId: '', notes: '', groups: [], scores: {}, sandys: {}, hcpOverride: {} });
      ui.open.days = true; markDirty(); render();
    },
    'del-day': function (t) { var i = +t.dataset.i; ui.sheet = { type: 'confirm', title: 'Remove ' + (S.days[i].label || 'this day') + '?', msg: 'This deletes its groups and every score entered for it.', yes: 'Remove day', action: { kind: 'del-day', i: i } }; render(); },
    'add-group': function (t) { var d = S.days[+t.dataset.d]; d.groups.push({ id: 'g' + rid(), name: (d.autoByTotal ? 'Team ' : 'Group ') + (d.groups.length + 1), time: '', playerIds: ['', '', '', ''] }); markDirty(); render(); },
    'add-slot': function (t) { var d = S.days[+t.dataset.d]; d.teeSlots = (d.teeSlots || []).concat(['']); markDirty(); render(); },
    'del-slot': function (t) { var d = S.days[+t.dataset.d]; d.teeSlots.splice(+t.dataset.i, 1); markDirty(); render(); },
    'del-group': function (t) { S.days[+t.dataset.d].groups.splice(+t.dataset.i, 1); markDirty(); render(); },
    draw: function (t) { drawTeams(+t.dataset.d); markDirty(); toast('Teams drawn. One man from each tier per group.'); },
    'ask-new': function () { ui.sheet = { type: 'confirm', title: 'Start a new trip?', msg: 'Every score, Sandy and handicap override gets cleared. Players, courses, groups and the Hall of Fame stay. Nothing changes for anyone else until you publish.', yes: 'Clear scores', action: { kind: 'newtrip' } }; render(); },
    'confirm-yes': function () { var a = ui.sheet && ui.sheet.action; if (a) doConfirm(a); },
    'copy-backup': function () {
      var txt = JSON.stringify(S);
      var done = function () { toast('Backup copied. Paste it somewhere safe.'); };
      var fallback = function () { ui.importText = txt; ui.open.data = true; render(); var b = document.getElementById('import-box'); if (b) { b.focus(); b.select(); } toast('Copy the selected text in the box.'); };
      try { navigator.clipboard.writeText(txt).then(done, fallback); } catch (e) { fallback(); }
    },
    import: function () {
      var el = document.getElementById('import-box'); var txt = el ? el.value.trim() : '';
      var st; try { st = JSON.parse(txt); } catch (e) { toast('That text isn\'t a valid backup.'); return; }
      if (!validState(st)) { toast('That backup is missing players, courses or days.'); return; }
      ui.sheet = { type: 'confirm', title: 'Restore this backup?', msg: 'It replaces the trip on this device (' + st.players.length + ' players, ' + st.days.length + ' days). Nothing changes for anyone else until you publish.', yes: 'Restore', action: { kind: 'import', state: st } };
      render();
    },
    'hof-add': function () {
      var y = (document.getElementById('hof-year') || {}).value; y = String(y || '').trim();
      if (!/^\d{4}$/.test(y)) { toast('Enter a 4-digit year.'); return; }
      var n = 0; S.hof = S.hof || [];
      S.players.forEach(function (p) {
        var t = R.totals[p.id]; if (!t.rounds) return;
        var entry = hofFor(p.name);
        if (!entry) { entry = { name: p.name, avg: {} }; S.hof.push(entry); }
        entry.avg[y] = Math.round(t.avg * 10) / 10; n++;
      });
      ui.hofYear = y; markDirty(); toast(n ? n + ' averages saved for ' + y + '.' : 'No finished rounds to save yet.');
    }
  };

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-a]'); if (!t) return;
    var fn = H[t.dataset.a];
    if (fn) { if (t.tagName === 'BUTTON') e.preventDefault(); fn(t, e); }
  });
  document.addEventListener('toggle', function (e) {
    var d = e.target; if (d && d.dataset && d.dataset.sec) ui.open[d.dataset.sec] = d.open;
  }, true);
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'hof-year') { ui.hofYear = t.value; return; }
    if (t.id === 'import-box' || t.id === 'new-player') { if (t.id === 'import-box') ui.importText = t.value; return; }
    if (t.dataset.auto != null) {
      var ad = S.days[+t.dataset.auto];
      ad.autoByTotal = t.checked;
      if (t.checked) {
        var need = Math.max(1, Math.ceil(Engine.dayPlayers(ad).length / 4) || Math.ceil(S.players.length / 4));
        ad.teeSlots = ad.groups.map(function (g) { return g.time || ''; }).filter(function (x) { return x; });
        while (ad.teeSlots.length < need) ad.teeSlots.push('');
        ad.groups.forEach(function (g, k) { if (!g.name || /^group\s*\d+$/i.test(g.name)) g.name = 'Team ' + (k + 1); g.time = ''; });
      } else {
        var slots = (ad.teeSlots || []).slice().sort(function (x, y) { return Engine.timeValue(x) - Engine.timeValue(y); });
        ad.groups.forEach(function (g, k) { if (/^team\s*\d+$/i.test(g.name || '')) g.name = 'Group ' + (k + 1); g.time = slots[k] || ''; });
      }
      markDirty(); scheduleRender(); return;
    }
    if (t.dataset.ov != null) {
      var d = S.days[+t.dataset.ov], v = parseNum(t.value, 'int');
      if (v == null || v < 0) delete d.hcpOverride[t.dataset.p]; else d.hcpOverride[t.dataset.p] = v;
      markDirty(); scheduleRender(); return;
    }
    var path = t.dataset.f; if (!path) return;
    var val = t.dataset.num ? parseNum(t.value, t.dataset.num) : t.value;
    if (t.dataset.num && val != null && val < 0) val = 0;
    if (/^days\.\d+\.groups\.\d+\.playerIds\.\d$/.test(path)) {
      var ps = path.split('.'); var g = S.days[+ps[1]].groups[+ps[3]];
      while (g.playerIds.length < 4) g.playerIds.push('');
    }
    setPath(S, path, val);
    markDirty(); scheduleRender();
  });
  document.addEventListener('keydown', function (e) {
    if (ui.tab !== 'admin' || ui.admin !== 'scores' || ui.sheet || !admin.on) return;
    var tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (/^[1-9]$/.test(e.key)) { e.preventDefault(); enterScore(+e.key); }
    else if (e.key === '0') { e.preventDefault(); enterScore(10); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); enterScore(null); }
    else if (e.key === 'ArrowRight' || e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); H.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); H.prev(); }
    else if (e.key === 'Escape' && ui.sheet) { ui.sheet = null; render(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && ui.sheet) { ui.sheet = null; render(); return; }
    if (ui.sheet && ui.sheet.type === 'login') {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); H.pinkey({ dataset: { v: e.key } }); }
      else if (e.key === 'Backspace') { e.preventDefault(); H.pinback(); }
      else if (e.key === 'Enter') { e.preventDefault(); tryLogin(); }
    }
  });

  // ---------- boot
  render();
  pull();
  setInterval(function () { if (!document.hidden) pull(); }, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pull(); });
  window.addEventListener('online', pull);
})();
