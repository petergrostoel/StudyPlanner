// Kør med: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../planner.js");

// Planlæg én profil. Standard: fuld dag 1 t (54 min fyldes), halv dag 30 min (27 fyldes),
// og en målt fart på 1 min pr. side.
const ONE_MIN = [{ kid_id: "k", book_id: "x", start_page: 1, end_page: 100, minutes: 100, studied_at: "2026-10-01T10:00:00Z" }];
const plan = ({ books, rules = [], sessions = ONE_MIN, today = "2026-10-14", settings = { fullHours: 1, halfHours: 0.5 }, curricula = [] }) =>
  P.planKid({ kid: { id: "k", settings }, curricula, books: books.map((b) => ({ kid_id: "k", ...b })), sessions, rules, today });

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


test("læsefart bruger antal læste sider, når det er gemt", () => {
  const p = P.pace([session(140, 215, 28, "2026-10-12", { pages: 14 })]);
  assert.equal(p.minPerPage, 2);
});

// ---------- Planen: tidligste frist først, dagene fyldes til 90 % ----------

test("dagene fyldes op til 90 % i stedet for at sprede teksten", () => {
  // 1 min pr. side, fuld dag 60 min -> 54 sider pr. dag. Fristen er langt ude.
  const p = plan({ books: [{ id: "b", from_page: 1, to_page: 100, deadline: "2026-12-18" }] });
  const days = p.plans[0].days;
  assert.deepEqual(days.map((d) => [d.date, d.pages]), [["2026-10-14", 54], ["2026-10-15", 46]]);
  assert.equal(p.plans[0].finish, "2026-10-15");
  assert.equal(p.plans[0].status, "ok");
});

test("teksten med tidligste frist læses først", () => {
  const books = [
    { id: "late", from_page: 1, to_page: 54, deadline: "2026-12-01", created_at: "1" },
    { id: "soon", from_page: 1, to_page: 60, deadline: "2026-10-20", created_at: "2" },
  ];
  const p = plan({ books });
  assert.deepEqual(p.today.items.map((i) => [i.bookId, i.pages]), [["soon", 54]]);
  const thu = p.days.find((d) => d.date === "2026-10-15");
  assert.deepEqual(thu.items.map((i) => [i.bookId, i.pages]), [["soon", 6], ["late", 48]]);
});

test("halve dage fyldes halvt, fri dage springes over", () => {
  // Ons 14. halv (27 min), tor 15. fuld (54), fre 16. fuld, lør-søn fri.
  const rules = [rule("day", { from_date: "2026-10-14", day_type: "half" })];
  const p = plan({ books: [{ id: "b", from_page: 1, to_page: 200, deadline: "2026-12-18" }], rules });
  assert.deepEqual(p.plans[0].days.slice(0, 4).map((d) => [d.date, d.pages]),
    [["2026-10-14", 27], ["2026-10-15", 54], ["2026-10-16", 54], ["2026-10-19", 54]]);
});

test("læsning i dag trækkes fra dagens læsetid", () => {
  const sessions = [session(1, 20, 40, "2026-10-14", { book_id: "b", studied_at: "2026-10-14T09:00:00" })];
  const p = plan({ books: [{ id: "b", from_page: 1, to_page: 100, current_page: 20, deadline: "2026-12-18" }], sessions });
  // 54 - 40 = 14 minutter tilbage i dag; farten er 2 min pr. side -> 7 sider.
  assert.equal(p.today.items[0].pages, 7);
});

test("planen springer siderne mellem intervallerne over", () => {
  const book = { id: "b", from_page: 1, to_page: 30, ranges: [{ from: 1, to: 10 }, { from: 21, to: 30 }], deadline: "2026-10-20" };
  const p = plan({ books: [{ ...book, current_page: 5 }] });
  assert.deepEqual(p.today.items[0].pieces, [{ from: 6, to: 10 }, { from: 21, to: 30 }]);
  assert.equal(P.piecesText(p.today.items[0].pieces), "6-10 og 21-30");
});

test("bufferen bruges, når 90 % ikke rækker til fristen", () => {
  // Ons-tor: 2 fulde dage = 120 min. 115 sider kan ikke nås med 2 x 54, men med 2 x 60.
  const p = plan({ books: [{ id: "b", from_page: 1, to_page: 115, deadline: "2026-10-15" }] });
  assert.equal(p.usedBuffer, true);
  assert.equal(p.plans[0].status, "ok");
  assert.equal(p.check.status, "tight");
});

test("overskredet frist lægger resten i dag", () => {
  const p = plan({ books: [{ id: "b", from_page: 1, to_page: 10, current_page: 4, deadline: "2026-10-01" }] });
  assert.equal(p.plans[0].status, "late");
  assert.deepEqual([p.today.items[0].fromPage, p.today.items[0].toPage], [5, 10]);
  assert.equal(p.check.status, "short");
});

test("en færdig tekst har ingen plan", () => {
  const p = plan({ books: [{ id: "b", from_page: 1, to_page: 10, current_page: 10, deadline: "2026-12-01" }] });
  assert.equal(p.plans[0].status, "done");
});

// ---------- Tidskontrol ----------

test("tidskontrol: god plads, tæt på og ikke nok tid", () => {
  // Ons 14. - fre 16.: 3 fulde dage = 180 min læsetid.
  const check = (pages) => plan({ books: [{ id: "b", from_page: 1, to_page: pages, deadline: "2026-10-16" }] }).check;
  assert.equal(check(160).status, "ok");      // 160 + 16 = 176 <= 180
  assert.equal(check(170).status, "tight");   // 170 <= 180 < 187
  assert.equal(check(190).status, "short");   // 190 > 180
  const c = check(170).worst;
  assert.deepEqual([c.deadline, c.need, c.buffer, c.capacity], ["2026-10-16", 170, 17, 180]);
});

test("tidskontrollen tjekker frist for frist", () => {
  // Rigeligt tid til januar, men for lidt til fredag.
  const books = [
    { id: "a", from_page: 1, to_page: 200, deadline: "2026-10-16" },
    { id: "b", from_page: 1, to_page: 50, deadline: "2027-01-10" },
  ];
  const p = plan({ books });
  assert.equal(p.check.status, "short");
  assert.equal(p.check.worst.deadline, "2026-10-16");
  assert.equal(p.plans.find((x) => x.bookId === "a").status, "short");
});

test("en aflyst dag kan gøre planen stram", () => {
  const books = [{ id: "b", from_page: 1, to_page: 150, deadline: "2026-10-16" }];
  assert.equal(plan({ books }).check.status, "ok");
  const rules = [rule("day", { from_date: "2026-10-15", day_type: "none" })];
  assert.equal(plan({ books, rules }).check.status, "short");
});

test("fagets status følger tidskontrollen ved fagets frister", () => {
  const curricula = [{ id: "s1", deadline: "2026-10-16" }, { id: "s2", deadline: "2027-01-10" }];
  const books = [
    { id: "a", kid_id: "k", curriculum_id: "s1", from_page: 1, to_page: 170 },
    { id: "b", kid_id: "k", curriculum_id: "s2", from_page: 1, to_page: 50 },
  ];
  const p = plan({ books, curricula });
  assert.equal(P.subjectStatus("s1", books, p).status, "tight");
  assert.equal(P.subjectStatus("s2", books, p).status, "ok");
});
