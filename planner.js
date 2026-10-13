// Studieplan – planlægning.
// Rene funktioner uden DOM og database, så de kan testes med `node --test`.
//
// Grundidé: hver bog har et sidetal og en frist (egen eller pensummets samlede).
// Barnets læsefart (minutter pr. side) måles ud fra de seneste læsninger.
// Resten af bogen fordeles jævnt på de læsedage, der er tilbage til fristen.

(function (root) {
  const DEFAULT_MIN_PER_PAGE = 2;   // gæt indtil barnet har læst et par gange
  const PACE_WINDOW = 8;            // antal seneste læsninger der tæller med
  const DEFAULT_STUDY_DAYS = [1, 2, 3, 4, 5]; // man-fre (0 = søndag)

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

  // Læsedage fra og med `from` til og med `to`.
  function studyDaysBetween(from, to, studyDays = DEFAULT_STUDY_DAYS, skip = []) {
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (studyDays.includes(toDate(d).getDay()) && !skip.includes(d)) days.push(d);
    }
    return days;
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
  function pagesRead(s) {
    return s.end_page - s.start_page + 1;
  }

  // ---------- Plan for én bog ----------

  function deadlineFor(book, curriculum) {
    return book.deadline || curriculum?.deadline || null;
  }

  // Første side der mangler at blive læst.
  function nextPage(book) {
    return Math.max(book.from_page, (book.current_page ?? book.from_page - 1) + 1);
  }

  function remainingPages(book) {
    return Math.max(0, book.to_page - nextPage(book) + 1);
  }

  // Fordel resten af bogen på læsedagene frem til fristen.
  // `today` tæller med, medmindre barnet allerede har læst i bogen i dag.
  function planBook(book, { curriculum, minPerPage, today, studyDays, skipDays = [], readToday = false }) {
    const deadline = deadlineFor(book, curriculum);
    const remaining = remainingPages(book);
    const base = { bookId: book.id, deadline, remaining, totalMinutes: Math.ceil(remaining * minPerPage) };
    if (remaining === 0) return { ...base, status: "done", days: [] };
    if (!deadline) return { ...base, status: "no-deadline", days: [] };

    const start = readToday ? addDays(today, 1) : today;
    const dates = studyDaysBetween(start, deadline, studyDays, skipDays);
    if (!dates.length) {
      // Fristen er overskredet eller i dag uden læsetid: alt lægges i dag.
      return { ...base, status: "late", days: [day(today, nextPage(book), book.to_page, minPerPage)] };
    }

    const days = [];
    let page = nextPage(book);
    for (let i = 0; i < dates.length && page <= book.to_page; i++) {
      // Jævn fordeling af det der er tilbage på de resterende dage.
      const left = book.to_page - page + 1;
      const count = Math.ceil(left / (dates.length - i));
      days.push(day(dates[i], page, page + count - 1, minPerPage));
      page += count;
    }
    return { ...base, status: "ok", days };
  }

  function day(date, fromPage, toPage, minPerPage) {
    return { date, fromPage, toPage, minutes: Math.max(1, Math.round((toPage - fromPage + 1) * minPerPage)) };
  }

  // ---------- Plan for et barn ----------

  // Samler alle bøger til en dagsplan og markerer dage, der er for tunge.
  function planKid({ kid, curricula, books, sessions, today }) {
    const settings = { maxMinutesPerDay: 120, studyDays: DEFAULT_STUDY_DAYS, ...(kid.settings || {}) };
    const kidSessions = sessions.filter((s) => s.kid_id === kid.id && !s.deleted);
    const p = pace(kidSessions);
    const byId = Object.fromEntries(curricula.map((c) => [c.id, c]));

    const plans = books
      .filter((b) => b.kid_id === kid.id && !b.deleted)
      .map((b) => planBook(b, {
        curriculum: byId[b.curriculum_id],
        minPerPage: bookPace(b, kidSessions, p),
        today,
        studyDays: settings.studyDays,
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
    for (const d of days) d.tooMuch = d.minutes > settings.maxMinutesPerDay;

    const atRisk = plans.filter((pl) => pl.status === "late").length > 0 || days.some((d) => d.tooMuch);
    return { pace: p, plans, days, today: calendar[today] ?? { date: today, minutes: 0, items: [] }, atRisk };
  }

  // Har barnet læst nok i netop denne bog, bruges bogens egen fart
  // (en roman læses hurtigere end en fagbog). Ellers barnets samlede fart.
  function bookPace(book, sessions, overall) {
    const own = pace(sessions.filter((s) => s.book_id === book.id));
    return own.samples >= 3 ? own.minPerPage : overall.minPerPage;
  }

  const api = {
    DEFAULT_MIN_PER_PAGE, toIso, addDays, studyDaysBetween, pace, pagesRead,
    deadlineFor, nextPage, remainingPages, planBook, planKid,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof window !== "undefined" ? window : globalThis);
