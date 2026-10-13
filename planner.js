// Studieplan – planlægning.
// Rene funktioner uden DOM og database, så de kan testes med `node --test`.
//
// Grundidé: hver tekst hører til et fag eller projekt med en frist, hvor alt
// skal være læst. En tekst kan have sin egen, tidligere frist. Teksten består
// af et eller flere sideintervaller (fx s. 112-148 og 211-310).
// Hver dag er en fuld, halv eller fri læsedag. Læsefarten (minutter pr. side)
// måles ud fra de seneste læsninger. Teksten med tidligste frist læses først,
// og hver dag fyldes op til 90 % af læsetiden. Tidskontrollen holder øje med,
// om læsetiden rækker til alt, der skal læses, plus 10 % buffer.

(function (root) {
  const DEFAULT_MIN_PER_PAGE = 2;   // gæt indtil man har læst et par gange
  const PACE_WINDOW = 8;            // antal seneste læsninger der tæller med
  const WEIGHT = { full: 1, half: 0.5, none: 0 };
  // Normal uge (0 = søndag): hverdage fuld læsetid, weekend fri.
  const DEFAULT_WEEK = ["none", "full", "full", "full", "full", "full", "none"];
  const DEFAULTS = { fullHours: 4, halfHours: 2, studyFrom: "09:00", freeFrom: "17:00" };

  // ---------- Datoer (lokale datoer som "YYYY-MM-DD") ----------

  function toDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function toIso(date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  }

  function addDays(iso, n) {
    const d = toDate(iso);
    d.setDate(d.getDate() + n);
    return toIso(d);
  }

  function weekday(iso) {
    return toDate(iso).getDay();
  }

  // ---------- Profilens indstillinger ----------

  function settingsOf(kid) {
    const s = { ...DEFAULTS, ...(kid?.settings || {}) };
    if (!Array.isArray(s.week) || s.week.length !== 7) {
      // Ældre profiler havde en liste over læsedage i stedet for en normal uge.
      s.week = Array.isArray(s.studyDays)
        ? DEFAULT_WEEK.map((_, i) => (s.studyDays.includes(i) ? "full" : "none"))
        : [...DEFAULT_WEEK];
    }
    return s;
  }

  function capacityMinutes(type, settings) {
    if (type === "full") return Math.round(settings.fullHours * 60);
    if (type === "half") return Math.round(settings.halfHours * 60);
    return 0;
  }

  // ---------- Læsetid: fuld, halv eller ingen ----------

  function ruleMatches(r, date) {
    if (r.kind === "day") return r.from_date === date;
    if (r.kind === "period") return !!r.from_date && !!r.to_date && r.from_date <= date && date <= r.to_date;
    if (r.kind === "weekday") {
      return r.weekday === weekday(date) && (!r.from_date || r.from_date <= date) && (!r.to_date || date <= r.to_date);
    }
    return false;
  }

  // En enkelt dag går forud for en periode, som går forud for en fast ugedag,
  // som går forud for den normale uge. Er to regler lige stærke, vinder den nyeste.
  function dayTypeInfo(date, rules = [], week = DEFAULT_WEEK, { skipDays = false } = {}) {
    const live = rules.filter((r) => !r.deleted && ruleMatches(r, date));
    const newest = (kind) =>
      live.filter((r) => r.kind === kind).sort((a, b) => ((a.updated_at ?? "") < (b.updated_at ?? "") ? 1 : -1))[0];
    const rule = (skipDays ? null : newest("day")) || newest("period") || newest("weekday");
    return { type: rule ? rule.day_type : week[weekday(date)], rule: rule || null };
  }

  function dayType(date, rules, week) {
    return dayTypeInfo(date, rules, week).type;
  }

  // ---------- Sideintervaller ----------

  // Sorterede, ikke-overlappende intervaller. Uden intervaller bruges fra/til side.
  function rangesOf(book) {
    const raw = Array.isArray(book.ranges) && book.ranges.length
      ? book.ranges
      : [{ from: book.from_page, to: book.to_page }];
    const list = raw
      .map((r) => ({ from: Number(r.from), to: Number(r.to) }))
      .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to >= r.from)
      .sort((a, b) => a.from - b.from);
    const merged = [];
    for (const r of list) {
      const last = merged[merged.length - 1];
      if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
      else merged.push({ ...r });
    }
    return merged;
  }

  function totalPages(book) {
    return rangesOf(book).reduce((n, r) => n + r.to - r.from + 1, 0);
  }

  // Antal sider i intervallerne til og med `page`.
  function pagesUpTo(book, page) {
    if (page == null) return 0;
    return rangesOf(book).reduce((n, r) => n + Math.max(0, Math.min(page, r.to) - r.from + 1), 0);
  }

  function pagesBetween(book, start, end) {
    return Math.max(0, pagesUpTo(book, end) - pagesUpTo(book, start - 1));
  }

  // Første side der mangler at blive læst (null når teksten er læst).
  function nextPage(book) {
    const after = book.current_page ?? -Infinity;
    for (const r of rangesOf(book)) {
      if (r.to > after) return Math.max(r.from, after + 1);
    }
    return null;
  }

  function remainingPages(book) {
    return totalPages(book) - pagesUpTo(book, book.current_page ?? null);
  }

  // Næste/forrige side inden for intervallerne (springer siderne imellem over).
  function stepPage(book, page, dir) {
    const rs = rangesOf(book);
    let p = page + dir;
    if (dir > 0) {
      for (const r of rs) if (p <= r.to) return Math.max(p, r.from);
      return rs.length ? rs[rs.length - 1].to : page;
    }
    for (let i = rs.length - 1; i >= 0; i--) if (p >= rs[i].from) return Math.min(p, rs[i].to);
    return rs.length ? rs[0].from - 1 : page;
  }

  // `n` sider fra og med `start`, som et eller flere stykker.
  function takePages(book, start, n) {
    const pieces = [];
    let left = n;
    for (const r of rangesOf(book)) {
      if (left <= 0) break;
      if (r.to < start) continue;
      const from = Math.max(r.from, start);
      const to = Math.min(r.to, from + left - 1);
      pieces.push({ from, to });
      left -= to - from + 1;
    }
    return pieces;
  }

  function piecesText(pieces) {
    return pieces.map((p) => (p.from === p.to ? `${p.from}` : `${p.from}-${p.to}`)).join(" og ");
  }

  // ---------- Læsefart ----------

  // Minutter pr. side ud fra de seneste læsninger: samlet tid / samlede sider,
  // så en enkelt dårlig dag ikke vælter planen.
  function pace(sessions, { window = PACE_WINDOW, fallback = DEFAULT_MIN_PER_PAGE } = {}) {
    const valid = sessions
      .filter((s) => !s.deleted && s.minutes > 0 && pagesRead(s) > 0)
      .sort((a, b) => (a.studied_at < b.studied_at ? 1 : -1))
      .slice(0, window);
    if (!valid.length) return { minPerPage: fallback, samples: 0, measured: false };
    const minutes = valid.reduce((sum, s) => sum + s.minutes, 0);
    const pages = valid.reduce((sum, s) => sum + pagesRead(s), 0);
    return { minPerPage: minutes / pages, samples: valid.length, measured: true };
  }

  // start_page er første side der blev læst, end_page den side man nåede til.
  // pages er antal læste sider inden for intervallerne (nyere læsninger).
  function pagesRead(s) {
    return s.pages ?? s.end_page - s.start_page + 1;
  }

  // ---------- Frister ----------

  // Tekstens egen frist, men aldrig senere end fagets.
  function deadlineFor(book, subject) {
    const own = book.deadline || null;
    const all = subject?.deadline || null;
    if (own && all) return own < all ? own : all;
    return own || all;
  }

  // ---------- Planen ----------

  const FILL = 0.9;          // dagene fyldes op til 90 % af læsetiden …
  const BUFFER = 0.1;        // … så der er 10 % luft til nye tekster og aflysninger
  const HORIZON_DAYS = 400;  // så langt frem planlægges der højst

  // Fordel alle tekster på læsedagene: teksten med tidligste frist læses først,
  // og hver dag fyldes op til 90 % af dens læsetid. En tekst kan derfor blive
  // læst færdig længe før fristen. Rækker 90 % ikke til at nå fristerne, bruges
  // hele læsetiden (bufferen) i stedet.
  // Tekster uden frist planlægges ikke. Er en frist allerede overskredet,
  // lægges resten af teksten i dag.
  function schedule({ books, paceOf, subjectOf, today, typeOf, settings, usedToday = 0 }) {
    const first = scheduleWith(FILL, { books, paceOf, subjectOf, today, typeOf, settings, usedToday });
    if (!first.plans.some((p) => p.status === "short")) return { ...first, usedBuffer: false };
    const full = scheduleWith(1, { books, paceOf, subjectOf, today, typeOf, settings, usedToday });
    return { ...full, usedBuffer: true };
  }

  function scheduleWith(fill, { books, paceOf, subjectOf, today, typeOf, settings, usedToday }) {
    const plans = {};
    const queue = [];
    for (const b of books) {
      const deadline = deadlineFor(b, subjectOf(b));
      const remaining = remainingPages(b);
      const mpp = paceOf(b);
      const plan = { bookId: b.id, deadline, remaining, minPerPage: mpp, totalMinutes: Math.ceil(remaining * mpp), days: [], status: "ok", finish: null };
      plans[b.id] = plan;
      if (remaining <= 0) plan.status = "done";
      else if (!deadline) plan.status = "no-deadline";
      else queue.push({ book: b, plan, left: remaining, page: nextPage(b), late: deadline < today });
    }
    queue.sort((x, y) => (x.plan.deadline < y.plan.deadline ? -1 : x.plan.deadline > y.plan.deadline ? 1 : 0)
      || ((x.book.created_at ?? "") < (y.book.created_at ?? "") ? -1 : 1));

    const place = (q, date, type, count) => {
      const item = day(q.book, date, type, q.page, count, q.plan.minPerPage);
      q.plan.days.push(item);
      q.left -= item.pages;
      q.page = item.pages ? stepPage(q.book, item.toPage, 1) : q.page;
      q.plan.finish = date;
    };

    // Overskredne frister: alt lægges i dag.
    for (const q of queue.filter((q) => q.late)) {
      q.plan.status = "late";
      place(q, today, typeOf(today), q.left);
    }

    const open = queue.filter((q) => !q.late);
    for (let i = 0, d = today; i < HORIZON_DAYS && open.some((q) => q.left > 0); i++, d = addDays(d, 1)) {
      const type = typeOf(d);
      let room = capacityMinutes(type, settings) * fill - (d === today ? usedToday : 0);
      for (const q of open) {
        if (room <= 0) break;
        if (q.left <= 0) continue;
        const count = Math.min(q.left, Math.floor(room / q.plan.minPerPage + 1e-9));
        if (count <= 0) continue;
        place(q, d, type, count);
        room -= count * q.plan.minPerPage;
      }
    }
    for (const q of open) {
      if (q.left > 0 || q.plan.finish > q.plan.deadline) q.plan.status = "short";
    }
    return { plans: books.map((b) => plans[b.id]) };
  }

  function day(book, date, type, start, count, minPerPage) {
    const pieces = takePages(book, start, count);
    const pages = pieces.reduce((n, p) => n + p.to - p.from + 1, 0);
    return {
      date, dayType: type, pieces, pages,
      fromPage: pieces[0]?.from ?? start, toPage: pieces[pieces.length - 1]?.to ?? start,
      minutes: Math.max(1, Math.round(pages * minPerPage)),
    };
  }

  // Tidskontrol: rækker læsetiden i kalenderen til alt det, der skal læses,
  // plus 10 % buffer? Det tjekkes frist for frist, så tekster med en tidlig
  // frist ikke skjules af god plads længere ude.
  //   ok    = læsetid ≥ behov + 10 %
  //   tight = læsetid ≥ behov, men bufferen er spist
  //   short = læsetid < behov
  function timeCheck(plans, { today, typeOf, settings, usedToday = 0 }) {
    const open = plans.filter((p) => p.remaining > 0 && p.deadline);
    const lateNeed = open.filter((p) => p.deadline < today).reduce((n, p) => n + remainingMinutes(p), 0);
    const deadlines = [...new Set(open.map((p) => p.deadline).filter((d) => d >= today))].sort();
    const checks = [];
    let cap = -usedToday;
    let d = today;
    for (const deadline of deadlines) {
      for (; d <= deadline; d = addDays(d, 1)) cap += capacityMinutes(typeOf(d), settings);
      const need = lateNeed + open.filter((p) => p.deadline <= deadline).reduce((n, p) => n + remainingMinutes(p), 0);
      const buffer = Math.round(need * BUFFER);
      const capacity = Math.max(0, cap);
      const status = capacity < need ? "short" : capacity < need + buffer ? "tight" : "ok";
      checks.push({ deadline, need, buffer, capacity, status, spare: capacity - need - buffer });
    }
    if (lateNeed && !checks.length) {
      checks.push({ deadline: today, need: lateNeed, buffer: 0, capacity: 0, status: "short", spare: -lateNeed });
    }
    const rank = { ok: 0, tight: 1, short: 2 };
    const worst = checks.reduce((w, c) => (!w || rank[c.status] > rank[w.status] || (rank[c.status] === rank[w.status] && c.spare < w.spare) ? c : w), null);
    return { status: lateNeed ? "short" : worst?.status ?? "ok", worst, checks };
  }

  function remainingMinutes(plan) {
    return Math.ceil(plan.remaining * plan.minPerPage);
  }

  // ---------- Plan for en profil ----------

  // Samler alle tekster til en dagsplan med tidskontrol.
  function planKid({ kid, curricula, books, sessions, rules = [], today }) {
    const settings = settingsOf(kid);
    const myRules = rules.filter((r) => r.kid_id === kid.id && !r.deleted);
    const memo = {};
    const typeOf = (d) => (memo[d] ??= dayType(d, myRules, settings.week));
    const kidSessions = sessions.filter((s) => s.kid_id === kid.id && !s.deleted);
    const p = pace(kidSessions);
    const byId = Object.fromEntries(curricula.filter((c) => !c.deleted).map((c) => [c.id, c]));
    const usedToday = kidSessions
      .filter((s) => s.studied_at && toIso(new Date(s.studied_at)) === today)
      .reduce((n, s) => n + (s.minutes || 0), 0);
    const myBooks = books.filter((b) => b.kid_id === kid.id && !b.deleted);

    const { plans, usedBuffer } = schedule({
      books: myBooks,
      paceOf: (b) => bookPace(b, kidSessions, p),
      subjectOf: (b) => byId[b.curriculum_id],
      today, typeOf, settings, usedToday,
    });

    // I hver dag står teksterne i den rækkefølge, de skal læses: tidligste frist først.
    const ordered = [...plans].sort((a, b) => ((a.deadline ?? "9999") < (b.deadline ?? "9999") ? -1 : (a.deadline ?? "9999") > (b.deadline ?? "9999") ? 1 : 0));
    const calendar = {};
    for (const plan of ordered) {
      for (const d of plan.days) {
        (calendar[d.date] ??= { date: d.date, minutes: 0, items: [] });
        calendar[d.date].minutes += d.minutes;
        calendar[d.date].items.push({ bookId: plan.bookId, ...d });
      }
    }
    const days = Object.values(calendar).sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const d of days) {
      d.dayType = typeOf(d.date);
      d.capacity = capacityMinutes(d.dayType, settings);
      d.used = d.date === today ? usedToday : 0;
      d.tooMuch = d.minutes + d.used > d.capacity;
    }

    const check = timeCheck(plans, { today, typeOf, settings, usedToday });
    const atRisk = check.status === "short";
    const todayEntry = calendar[today] ?? { date: today, minutes: 0, items: [] };
    todayEntry.dayType = typeOf(today);
    todayEntry.capacity = capacityMinutes(todayEntry.dayType, settings);
    todayEntry.used = usedToday;
    return { pace: p, plans, days, today: todayEntry, atRisk, check, usedBuffer, usedToday, typeOf, settings };
  }

  // Status for et fag: done, none (ingen frist), eller tidskontrollens status
  // ved fagets frister (ok, tight, short).
  function subjectStatus(subjectId, books, kidPlan) {
    const mine = books.filter((b) => b.curriculum_id === subjectId && !b.deleted);
    const plans = kidPlan.plans.filter((p) => mine.some((b) => b.id === p.bookId));
    const total = mine.reduce((n, b) => n + totalPages(b), 0);
    const read = mine.reduce((n, b) => n + pagesUpTo(b, b.current_page ?? null), 0);
    const open = plans.filter((p) => p.status !== "done");
    let status = "ok";
    let check = null;
    if (mine.length && !open.length) status = "done";
    else if (!open.some((p) => p.deadline)) status = "none";
    else if (open.some((p) => p.status === "late")) status = "short";
    else {
      const rank = { ok: 0, tight: 1, short: 2 };
      for (const c of kidPlan.check.checks) {
        if (!open.some((p) => p.deadline === c.deadline)) continue;
        if (!check || rank[c.status] > rank[check.status]) check = c;
      }
      status = check?.status ?? "ok";
    }
    const finish = open.reduce((f, p) => (p.finish && (!f || p.finish > f) ? p.finish : f), null);
    return { total, read, status, check, finish, books: mine };
  }

  // Har man læst nok i netop denne tekst, bruges tekstens egen fart
  // (en roman læses hurtigere end en fagbog). Ellers den samlede fart.
  function bookPace(book, sessions, overall) {
    const own = pace(sessions.filter((s) => s.book_id === book.id));
    return own.samples >= 3 ? own.minPerPage : overall.minPerPage;
  }

  const api = {
    DEFAULT_MIN_PER_PAGE, DEFAULT_WEEK, WEIGHT,
    toIso, addDays, weekday, settingsOf, capacityMinutes,
    ruleMatches, dayType, dayTypeInfo,
    rangesOf, totalPages, pagesUpTo, pagesBetween, nextPage, remainingPages, stepPage, takePages, piecesText,
    pace, pagesRead, deadlineFor, schedule, timeCheck, planKid, subjectStatus, FILL, BUFFER,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof window !== "undefined" ? window : globalThis);
