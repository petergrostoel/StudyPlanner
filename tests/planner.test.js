// Kør med: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../planner.js");

const session = (start, end, minutes, date = "2026-10-12", extra = {}) =>
  ({ start_page: start, end_page: end, minutes, studied_at: date + "T15:00:00Z", kid_id: "k", ...extra });

test("læsedage springer weekenden over", () => {
  // 2026-10-13 er en tirsdag, 2026-10-23 en fredag.
  assert.deepEqual(P.studyDaysBetween("2026-10-16", "2026-10-19"), ["2026-10-16", "2026-10-19"]);
  assert.equal(P.studyDaysBetween("2026-10-13", "2026-10-23").length, 9);
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

test("bogens egen frist går forud for pensummets", () => {
  const curriculum = { deadline: "2026-12-18" };
  assert.equal(P.deadlineFor({ deadline: "2026-10-23" }, curriculum), "2026-10-23");
  assert.equal(P.deadlineFor({ deadline: null }, curriculum), "2026-12-18");
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
  assert.deepEqual(plan.days, [{ date: "2026-10-14", fromPage: 5, toPage: 10, minutes: 12 }]);
});

test("en færdig bog har ingen plan", () => {
  const plan = P.planBook({ from_page: 1, to_page: 10, current_page: 10 }, { minPerPage: 2, today: "2026-10-14" });
  assert.equal(plan.status, "done");
});

test("planen bliver mere realistisk når barnet læser langsommere end gættet", () => {
  const kid = { id: "k", settings: { maxMinutesPerDay: 30 } };
  const curricula = [{ id: "c", deadline: "2026-12-18" }];
  const books = [{ id: "b", kid_id: "k", curriculum_id: "c", from_page: 1, to_page: 120, current_page: 44, deadline: "2026-10-23" }];
  const before = P.planKid({ kid, curricula, books, sessions: [], today: "2026-10-14" });
  const slow = [session(30, 44, 60, "2026-10-13", { book_id: "b" })];
  const after = P.planKid({ kid, curricula, books, sessions: slow, today: "2026-10-14" });
  assert.ok(after.today.minutes > before.today.minutes);
  assert.equal(before.atRisk, false);
  assert.equal(after.atRisk, true);
});
