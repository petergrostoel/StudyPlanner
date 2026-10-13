// Studieplan – planlægning.
// Rene funktioner uden DOM og database, så de kan testes med `node --test`.
//
// Grundidé: hver tekst hører til et fag eller projekt med en frist, hvor alt
// skal være læst. En tekst kan have sin egen, tidligere frist. Teksten består
// af et eller flere sideintervaller (fx s. 112-148 og 211-310).
// Hver dag er en fuld, halv eller fri læsedag. Læsefarten (minutter pr. side)
// måles ud fra de seneste læsninger, og resten af hver tekst fordeles på
// læsedagene frem til fristen: en fuld dag tæller 1, en halv dag 0,5.

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

  // ---------- Plan for én tekst ----------

  // Fordel resten af teksten på læsedagene frem til fristen, vægtet efter
  // dagstypen. `today` tæller med, medmindre der allerede er læst i teksten i dag.
  // typeOf(date) giver "full", "half" eller "none" (standard: hverdage fuld).
  function planBook(book, { curriculum, minPerPage, today, typeOf, readToday = false }) {
    typeOf ??= (d) => DEFAULT_WEEK[weekday(d)];
    const deadline = deadlineFor(book, curriculum);
    const remaining = remainingPages(book);
    const base = { bookId: book.id, deadline, remaining, totalMinutes: Math.ceil(remaining * minPerPage) };
    if (remaining <= 0) return { ...base, status: "done", days: [] };
    if (!deadline) return { ...base, status: "no-deadline", days: [] };

    const start = readToday ? addDays(today, 1) : today;
    const dates = [];
    for (let d = start; d <= deadline; d = addDays(d, 1)) {
      const type = typeOf(d);
      if (WEIGHT[type] > 0) dates.push({ date: d, type, weight: WEIGHT[type] });
    }
    if (!dates.length) {
      // Fristen er overskredet, eller der er ingen læsetid tilbage: alt lægges i dag.
      return { ...base, status: "late", days: [day(book, today, typeOf(today), nextPage(book), remaining, minPerPage)] };
    }

    const sum = dates.reduce((n, d) => n + d.weight, 0);
    const days = [];
    let page = nextPage(book);
    let done = 0;
    let acc = 0;
    for (const d of dates) {
      acc += d.weight;
      const target = Math.round((remaining * acc) / sum);
      const count = target - done;
      if (count <= 0) continue;
      const item = day(book, d.date, d.type, page, count, minPerPage);
      days.push(item);
      done = target;
      page = stepPage(book, item.toPage, 1);
    }
    return { ...base, status: "ok", days };
  }

  function day(book, date, type, start, count, minPerPage) {
    const pieces = takePages(book, start, count);
    const pages = pieces.reduce((n, p) => n + p.to - p.from + 1, 0);
    return {
      date, dayType: type, pieces, pages,
      fromPage: pieces[0].from, toPage: pieces[pieces.length - 1].to,
      minutes: Math.max(1, Math.round(pages * minPerPage)),
    };
  }

  // ---------- Plan for en profil ----------

  // Samler alle tekster til en dagsplan og markerer dage, hvor der er planlagt
  // mere, end dagstypen giver tid til.
  function planKid({ kid, curricula, books, sessions, rules = [], today }) {
    const settings = settingsOf(kid);
    const myRules = rules.filter((r) => r.kid_id === kid.id && !r.deleted);
    const memo = {};
    const typeOf = (d) => (memo[d] ??= dayType(d, myRules, settings.week));
    const kidSessions = sessions.filter((s) => s.kid_id === kid.id && !s.deleted);
    const p = pace(kidSessions);
    const byId = Object.fromEntries(curricula.filter((c) => !c.deleted).map((c) => [c.id, c]));

    const plans = books
      .filter((b) => b.kid_id === kid.id && !b.deleted)
      .map((b) => planBook(b, {
        curriculum: byId[b.curriculum_id],
        minPerPage: bookPace(b, kidSessions, p),
        today,
        typeOf,
        readToday: kidSessions.some((s) => s.book_id === b.id && s.studied_at && toIso(new Date(s.studied_at)) === today),
      }));

    const calendar = {};
    for (const plan of plans) {
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
      d.tooMuch = d.minutes > d.capacity;
    }

    const atRisk = plans.some((pl) => pl.status === "late") || days.some((d) => d.tooMuch);
    const todayEntry = calendar[today] ?? { date: today, minutes: 0, items: [] };
    todayEntry.dayType = typeOf(today);
    todayEntry.capacity = capacityMinutes(todayEntry.dayType, settings);
    return { pace: p, plans, days, today: todayEntry, atRisk, typeOf, settings };
  }

  // Status for et fag: done, late (fristen er nået), tight (nogle dage er for
  // tunge) eller ok.
  function subjectStatus(subjectId, books, kidPlan) {
    const mine = books.filter((b) => b.curriculum_id === subjectId && !b.deleted);
    const plans = kidPlan.plans.filter((p) => mine.some((b) => b.id === p.bookId));
    const total = mine.reduce((n, b) => n + totalPages(b), 0);
    const read = mine.reduce((n, b) => n + pagesUpTo(b, b.current_page ?? null), 0);
    const heavy = new Set(kidPlan.days.filter((d) => d.tooMuch).map((d) => d.date));
    let status = "ok";
    if (mine.length && plans.every((p) => p.status === "done")) status = "done";
    else if (plans.some((p) => p.status === "late")) status = "late";
    else if (plans.some((p) => p.days.some((d) => heavy.has(d.date)))) status = "tight";
    return { total, read, status, books: mine };
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
    pace, pagesRead, deadlineFor, planBook, planKid, subjectStatus,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof window !== "undefined" ? window : globalThis);
