// Kør med: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../planner.js");

const session = (start, end, minutes, date = "2026-10-12", extra = {}) =>
  ({ start_page: start, end_page: end, minutes, studied_at: date + "T15:00:00Z", kid_id: "k", ...extra });

test("normal uge: hverdage fuld læsetid, weekend fri", () => {
  // 2026-10-16 er en fredag, 2026-10-17 en lørdag.
  assert.equal(P.dayType("2026-10-16", []), "full");
  assert.equal(P.dayType("2026-10-17", []), "none");
});

test("læsefart uden målinger bruger standardværdien", () => {
  assert.deepEqual(P.pace([]), { minPerPage: 2, samples: 0, measured: false });
});

test("læsefart er samlet tid delt med samlede sider", () => {
  const p = P.pace([session(1, 10, 20), session(11, 20, 10)]);
  assert.equal(p.minPerPage, 1.5);
  assert.equal(p.samples, 2);
});

test("læsefart bruger kun de seneste læsninger", () => {
  const old = Array.from({ length: 10 }, (_, i) => session(1, 10, 50, `2026-09-${10 + i}`));
  const recent = Array.from({ length: 8 }, (_, i) => session(1, 10, 10, `2026-10-0${1 + i}`));
  assert.equal(P.pace([...old, ...recent]).minPerPage, 1);
});

test("ugyldige læsninger tæller ikke med", () => {
  const p = P.pace([session(10, 9, 20), session(1, 5, 0), session(1, 10, 20)]);
  assert.equal(p.samples, 1);
});

test("tekstens egen frist går forud for fagets, men aldrig senere", () => {
  const subject = { deadline: "2026-12-18" };
  assert.equal(P.deadlineFor({ deadline: "2026-10-23" }, subject), "2026-10-23");
  assert.equal(P.deadlineFor({ deadline: null }, subject), "2026-12-18");
  assert.equal(P.deadlineFor({ deadline: "2027-01-10" }, subject), "2026-12-18");
});

test("resten af bogen fordeles jævnt frem til fristen", () => {
  const book = { id: "b", from_page: 1, to_page: 120, current_page: 44, deadline: "2026-10-23" };
  const plan = P.planBook(book, { minPerPage: 2, today: "2026-10-14" });
  assert.equal(plan.status, "ok");
  assert.equal(plan.remaining, 76);
  assert.equal(plan.days.length, 8);
  assert.equal(plan.days[0].fromPage, 45);
  assert.equal(plan.days.at(-1).toPage, 120);
  assert.equal(plan.days.reduce((s, d) => s + (d.toPage - d.fromPage + 1), 0), 76);
});

test("har barnet læst i dag, starter planen i morgen", () => {
  const book = { id: "b", from_page: 1, to_page: 10, current_page: 0, deadline: "2026-10-16" };
  const plan = P.planBook(book, { minPerPage: 1, today: "2026-10-14", readToday: true });
  assert.equal(plan.days[0].date, "2026-10-15");
});

test("overskredet frist lægger resten i dag og markeres som for sent", () => {
  const book = { id: "b", from_page: 1, to_page: 10, current_page: 4, deadline: "2026-10-01" };
  const plan = P.planBook(book, { minPerPage: 2, today: "2026-10-14" });
  assert.equal(plan.status, "late");
  assert.equal(plan.days.length, 1);
  const [d] = plan.days;
  assert.deepEqual([d.date, d.fromPage, d.toPage, d.minutes], ["2026-10-14", 5, 10, 12]);
});

test("en færdig bog har ingen plan", () => {
  const plan = P.planBook({ from_page: 1, to_page: 10, current_page: 10 }, { minPerPage: 2, today: "2026-10-14" });
  assert.equal(plan.status, "done");
});

test("planen bliver mere realistisk når barnet læser langsommere end gættet", () => {
  const kid = { id: "k", settings: { fullHours: 0.5 } };
  const curricula = [{ id: "c", deadline: "2026-12-18" }];
  const books = [{ id: "b", kid_id: "k", curriculum_id: "c", from_page: 1, to_page: 120, current_page: 44, deadline: "2026-10-23" }];
  const before = P.planKid({ kid, curricula, books, sessions: [], today: "2026-10-14" });
  const slow = [session(30, 44, 60, "2026-10-13", { book_id: "b" })];
  const after = P.planKid({ kid, curricula, books, sessions: slow, today: "2026-10-14" });
  assert.ok(after.today.minutes > before.today.minutes);
  assert.equal(before.atRisk, false);
  assert.equal(after.atRisk, true);
});

// ---------- Læsetid ----------

const rule = (kind, fields) => ({ id: kind, kid_id: "k", kind, updated_at: "2026-10-01T00:00:00Z", ...fields });

test("regler: enkelt dag går forud for periode, som går forud for fast ugedag", () => {
  const rules = [
    rule("weekday", { weekday: 4, day_type: "half", from_date: "2026-09-01", to_date: "2026-12-18" }), // torsdage
    rule("period", { from_date: "2026-10-29", to_date: "2026-11-01", day_type: "none" }),
    rule("day", { from_date: "2026-10-22", day_type: "full" }),
  ];
  assert.equal(P.dayType("2026-10-15", rules), "half");   // torsdag
  assert.equal(P.dayType("2026-10-22", rules), "full");   // torsdag med undtagelse
  assert.equal(P.dayType("2026-10-29", rules), "none");   // torsdag i ferien
  assert.equal(P.dayType("2026-12-24", rules), "full");   // torsdag efter reglens periode
  assert.equal(P.dayType("2026-10-30", rules), "none");   // fredag i ferien
});

test("profilen bestemmer hvor lang en fuld og en halv dag er", () => {
  const s = P.settingsOf({ settings: { fullHours: 5, halfHours: 1.5 } });
  assert.equal(P.capacityMinutes("full", s), 300);
  assert.equal(P.capacityMinutes("half", s), 90);
  assert.equal(P.capacityMinutes("none", s), 0);
  assert.equal(P.capacityMinutes("full", P.settingsOf({})), 240);
});

test("ældre profiler med læsedage får en normal uge", () => {
  const s = P.settingsOf({ settings: { studyDays: [0, 1, 2, 3, 4, 5, 6] } });
  assert.deepEqual(s.week, ["full", "full", "full", "full", "full", "full", "full"]);
});

test("halve dage får halvt så mange sider som fulde", () => {
  // Ons 14. fuld, tor 15. halv, fre 16. fuld.
  const typeOf = (d) => ({ "2026-10-15": "half" }[d] ?? P.DEFAULT_WEEK[P.weekday(d)]);
  const book = { id: "b", from_page: 1, to_page: 50, deadline: "2026-10-16" };
  const plan = P.planBook(book, { minPerPage: 2, today: "2026-10-14", typeOf });
  assert.deepEqual(plan.days.map((d) => [d.date, d.pages]), [["2026-10-14", 20], ["2026-10-15", 10], ["2026-10-16", 20]]);
});

test("fri dage får ingen læsning", () => {
  const book = { id: "b", from_page: 1, to_page: 30, deadline: "2026-10-19" };
  const plan = P.planBook(book, { minPerPage: 1, today: "2026-10-16" });
  assert.deepEqual(plan.days.map((d) => d.date), ["2026-10-16", "2026-10-19"]);
});

test("for meget læsning på en halv dag gør planen stram", () => {
  const kid = { id: "k", settings: { fullHours: 4, halfHours: 0.25 } };
  const books = [{ id: "b", kid_id: "k", from_page: 1, to_page: 40, deadline: "2026-10-15" }];
  const rules = [rule("day", { from_date: "2026-10-15", day_type: "half" })];
  // Ons 14. er fuld, tor 15. halv: 27 + 13 sider à 2 min. 26 min > 15 min på den halve dag.
  const plan = P.planKid({ kid, curricula: [], books, sessions: [], rules, today: "2026-10-14" });
  const thu = plan.days.find((d) => d.date === "2026-10-15");
  assert.equal(thu.dayType, "half");
  assert.equal(thu.tooMuch, true);
  assert.equal(plan.atRisk, true);
});

// ---------- Sideintervaller ----------

test("flere sideintervaller: kun siderne i intervallerne tæller", () => {
  const book = { from_page: 112, to_page: 310, ranges: [{ from: 211, to: 310 }, { from: 112, to: 148 }] };
  assert.deepEqual(P.rangesOf(book), [{ from: 112, to: 148 }, { from: 211, to: 310 }]);
  assert.equal(P.totalPages(book), 137);
  assert.equal(P.nextPage(book), 112);
  assert.equal(P.nextPage({ ...book, current_page: 148 }), 211);
  assert.equal(P.remainingPages({ ...book, current_page: 148 }), 100);
  assert.equal(P.pagesBetween(book, 140, 215), 14);
  assert.equal(P.stepPage(book, 148, 1), 211);
  assert.equal(P.stepPage(book, 211, -1), 148);
});

test("planen springer siderne mellem intervallerne over", () => {
  const book = { id: "b", from_page: 1, to_page: 30, ranges: [{ from: 1, to: 10 }, { from: 21, to: 30 }], deadline: "2026-10-15" };
  const plan = P.planBook(book, { minPerPage: 1, today: "2026-10-14" });
  assert.equal(plan.days.length, 2);
  assert.deepEqual(plan.days[0].pieces, [{ from: 1, to: 10 }]);
  assert.deepEqual(plan.days[1].pieces, [{ from: 21, to: 30 }]);
  const odd = P.planBook({ ...book, current_page: 5 }, { minPerPage: 1, today: "2026-10-15" });
  assert.deepEqual(odd.days[0].pieces, [{ from: 6, to: 10 }, { from: 21, to: 30 }]);
  assert.equal(odd.days[0].minutes, 15);
  assert.equal(P.piecesText(odd.days[0].pieces), "6-10 og 21-30");
});

test("læsefart bruger antal læste sider, når det er gemt", () => {
  const p = P.pace([session(140, 215, 28, "2026-10-12", { pages: 14 })]);
  assert.equal(p.minPerPage, 2);
});
