// Studieplan – læseplan for studerende.
// Hver bruger logger ind med sin egen konto, og planen er kun brugerens egen.
// Data ligger i en offline database på enheden (store.js) og synkroniseres med
// Supabase. Planen udregnes i planner.js ud fra teksternes sider, fagenes og
// teksternes frister, læsetiden (fulde, halve og fri dage) og den målte læsefart.

const KID_KEY = "studieplan.kid.v1";   // hvilken profil der sidst brugte enheden
const COLORS = ["#C2410C", "#6D28D9", "#2F55D4", "#1F7A52", "#B4235A"];
const SUBJECT_COLORS = ["#FF3B7F", "#25F4EE", "#FFB547", "#8B7CFF", "#3DDC97"];
const DAY_NAMES = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
const LONG_DAY_NAMES = ["Søndag", "Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag"];
const DAY_LETTERS = ["S", "M", "T", "O", "T", "F", "L"];
const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const LONG_MONTHS = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];
const TYPES = {
  full: { label: "Fuld læsetid", short: "Fuld" },
  half: { label: "Halv læsetid", short: "Halv" },
  none: { label: "Ingen læsetid", short: "Ingen" },
};
const NEXT_TYPE = { full: "half", half: "none", none: "full" };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const { supabaseUrl, supabaseKey } = window.STUDY_PLANNER_CONFIG;
const db = supabase.createClient(supabaseUrl, supabaseKey);

let user = null;
let timer = null; // { bookId, startedAt, elapsed }
let synced = false; // første synkronisering er gået igennem (eller har fejlet)

const today = () => Planner.toIso(new Date());

// ============================================================
// Synkronisering
// ============================================================

function setSync(state, text) {
  const el = $("#sync-status");
  el.className = "sync " + state;
  el.textContent = text;
}

async function sync() {
  if (!user) return;
  if (!navigator.onLine) return setSync("pending", Store.pendingCount() ? "Offline · gemt på enheden" : "Offline");
  setSync("pending", "Gemmer…");
  try {
    await Store.sync(db);
    setSync("ok", "");
  } catch (err) {
    console.error("Synkronisering fejlede", err);
    setSync("error", "Ikke gemt online endnu");
  }
}

window.addEventListener("online", sync);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sync();
});
setInterval(() => {
  if (Store.pendingCount()) sync();
}, 30000);

async function save(table, row) {
  const saved = await Store.put(table, row);
  sync();
  return saved;
}

async function removeRow(table, id) {
  await Store.remove(table, id);
  sync();
}

// ============================================================
// Data-hjælpere
// ============================================================

const kids = () => Store.all("kids").sort((a, b) => (a.created_at ?? a.id) < (b.created_at ?? b.id) ? -1 : 1);
const booksOf = (kidId) => Store.all("books", (b) => b.kid_id === kidId).sort((a, b) => (a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1);
const rulesOf = (kidId) => Store.all("day_rules", (r) => r.kid_id === kidId);
// Fag og projekter (tabellen hedder curricula), sorteret efter frist.
const subjectsOf = (kidId) => Store.all("curricula", (c) => c.kid_id === kidId)
  .sort((a, b) => (a.deadline ?? "9999") < (b.deadline ?? "9999") ? -1 : 1);
const subjectOf = (book) => (book?.curriculum_id ? Store.get("curricula", book.curriculum_id) : null);
const settingsOf = (kid) => Planner.settingsOf(kid);

function planFor(kid) {
  return planWith(kid);
}

// Planen, som den ville se ud med andre tekster, læsninger eller regler
// (bruges til at vise konsekvensen, før noget gemmes).
function planWith(kid, { books, sessions, rules, day } = {}) {
  return Planner.planKid({
    kid,
    curricula: Store.all("curricula"),
    books: books ?? Store.all("books"),
    sessions: sessions ?? Store.all("sessions"),
    rules: rules ?? Store.all("day_rules"),
    today: day ?? today(),
  });
}

// ---------- Tidskontrol: grøn, gul eller rød ----------

const CHECK = {
  ok: { label: "God plads", cls: "s-ok" },
  tight: { label: "Tæt på", cls: "s-tight" },
  short: { label: "Ikke nok tid", cls: "s-short" },
};

function checkText(check) {
  const w = check.worst;
  if (!w) return "ingen frister at holde øje med";
  if (check.status === "ok") return `${formatHours(w.spare)} luft før ${shortDate(w.deadline)}`;
  if (check.status === "tight") return `find ${formatHours(w.need + w.buffer - w.capacity)} ekstra før ${shortDate(w.deadline)}`;
  return `mangler ${formatHours(Math.max(1, w.need - w.capacity))} før ${shortDate(w.deadline)}`;
}

function statusPill(kid, check) {
  const c = CHECK[check.status];
  return `<a class="status ${c.cls}" href="#/kid/${kid.id}/time"><span class="sdot"></span><span class="grow"><strong>${c.label}</strong> · ${checkText(check)}</span><span class="small">Læsetid ›</span></a>`;
}

// To bjælker: behov + buffer mod læsetiden i kalenderen frem til fristen.
function checkCard(check) {
  const w = check.worst;
  const c = CHECK[check.status];
  if (!w) return `<div class="checkcard ${c.cls}"><div class="row"><span class="sdot"></span><strong class="grow">${c.label}</strong></div><span class="small">Ingen frister at holde øje med.</span></div>`;
  const max = Math.max(w.capacity, w.need + w.buffer) * 1.05 || 1;
  const pct = (m) => `${Math.max(0, Math.round((m / max) * 100))}%`;
  const text = {
    ok: `Der er tid nok, også med 10 % buffer til nye tekster og aflysninger.`,
    tight: `Du når det, men bufferen er spist. Find ${formatHours(w.need + w.buffer - w.capacity)} ekstra læsetid, så der er luft.`,
    short: `Læsetiden rækker ikke. Du mangler ${formatHours(Math.max(1, w.need - w.capacity))} plus buffer. Gør fri dage til halve eller halve til fulde.`,
  }[check.status];
  return `<div class="checkcard ${c.cls}">
    <div class="row"><span class="sdot"></span><strong class="grow">${c.label}</strong><span class="small muted">frem til ${shortDate(w.deadline)}</span></div>
    <div class="cbar"><span style="width:${pct(w.need)}" class="need"></span><span style="left:${pct(w.need)};width:${pct(w.buffer)}" class="buf"></span></div>
    <div class="cbar"><span style="width:${pct(w.capacity)}" class="cap"></span></div>
    <div class="row small muted" style="justify-content:space-between"><span>Behov ${formatHours(w.need)} + buffer ${formatHours(w.buffer)}</span><span>Læsetid ${formatHours(w.capacity)}</span></div>
    <span class="small">${text}</span>
  </div>`;
}

// Fast farve pr. fag (egen farve, ellers ud fra id'et, så den er ens på alle enheder).
function hashColor(id, list) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}
const subjectColor = (s) => s?.color || (s ? hashColor(s.id, SUBJECT_COLORS) : "#71717A");
const bookColor = (b) => (subjectOf(b) ? subjectColor(subjectOf(b)) : hashColor(b.id, SUBJECT_COLORS));

function shortTitle(title) {
  return escapeHtml(title.replace(/[,(:].*$/, "").slice(0, 5));
}

// ============================================================
// Navigation
// ============================================================

function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { name: parts[0] || "", id: parts[1], sub: parts[2], extra: parts[3] };
}

function go(hash) {
  location.hash = hash;
}

window.addEventListener("hashchange", render);
Store.onChange(() => {
  // Undgå at tegne siden om midt i en indtastning.
  if (!$("#sheet").open) render();
});

const ICONS = {
  today: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  week: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  books: '<path d="M4 19V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h8M8 11h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  flame: '<path d="M12 22c4 0 7-2.7 7-7 0-3.5-2.5-6-4-8-.5 2-1.5 3-3 3 0-3-1-5.5-3-8-1 4-4 6.5-4 11 0 5 3 9 7 9z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};

function icon(name, width = 2) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

// Bundmenu som i Instagram/TikTok: kun ikoner, startknap i midten og profil til sidst.
function renderTabbar(kid, current) {
  const nav = $("#tabbar");
  if (!kid) {
    nav.hidden = true;
    return;
  }
  nav.hidden = false;
  const tab = (key, label, inner, active = current === key) =>
    `<a href="#/kid/${kid.id}/${key}" aria-label="${label}" ${active ? 'aria-current="page"' : ""}>${inner}</a>`;
  const onBooks = current === "books" || current === "subject";
  nav.innerHTML =
    tab("today", "I dag", icon("today", current === "today" ? 2.6 : 2)) +
    tab("week", "Ugen", icon("week", current === "week" || current === "time" ? 2.6 : 2), current === "week" || current === "time") +
    tab("focus", "Start læsning", `<span class="create"><span>${icon("plus", 3)}</span></span>`) +
    tab("books", "Pensum", icon("books", onBooks ? 2.6 : 2), onBooks) +
    tab("me", "Profil", avatar(kid, 30, "me" + (current === "me" ? " on" : "")));
}

function render() {
  if (!user) return;
  const r = route();
  const app = $("#app");
  if (r.name === "kid") {
    const kid = Store.get("kids", r.id);
    if (!kid) return go("#/");
    try {
      localStorage.setItem(KID_KEY, kid.id);
    } catch {}
    const view = r.sub || "today";
    renderTabbar(kid, view);
    if (view === "week") app.innerHTML = weekView(kid);
    else if (view === "focus") app.innerHTML = focusView(kid, r.extra);
    else if (view === "books") app.innerHTML = booksView(kid);
    else if (view === "subject") app.innerHTML = subjectView(kid, r.extra);
    else if (view === "time") app.innerHTML = timeView(kid, r.extra);
    else if (view === "me") app.innerHTML = meView(kid);
    else app.innerHTML = todayView(kid);
    if (synced && view !== "focus") maybeCatchup(kid);
    return;
  }
  renderTabbar(null);
  const list = kids();
  if (list.length === 1) return go(`#/kid/${list[0].id}/today`);
  app.innerHTML = list.length ? pickerView(list) : welcomeView();
}

// ============================================================
// Visninger
// ============================================================

// Første gang: opret sin egen profil.
function welcomeView() {
  return `
    <div class="auth-card" style="margin:24px auto 12px">
      <div class="logo">${icon("books")}</div>
      <h1 style="font-size:34px">studieplan</h1>
      <p class="muted">Læs pensum i dit eget tempo. Planen følger med.</p>
    </div>
    <form id="welcome-form" class="card stack">
      <label>Hvad hedder du?<input name="name" required autocomplete="given-name"></label>
      <label>Studie og semester (valgfrit)<input name="grade" placeholder="fx Erhvervsøkonomi, 3. semester"></label>
      <button class="primary">Kom i gang</button>
    </form>
    <div class="card row small" style="color:var(--soft)">${icon("lock")}<span>Din plan er kun din. Ingen andre kan se dit pensum, din læsning eller din fart.</span></div>`;
}

// Kun hvis kontoen har flere profiler (fra før hver fik sin egen konto).
function pickerView(list) {
  return `
    <div class="auth-card" style="margin:24px auto 12px">
      <div class="logo">${icon("books")}</div>
      <h1 style="font-size:34px">studieplan</h1>
    </div>
    ${list.map((k) => `<a class="card row" style="text-decoration:none" href="#/kid/${k.id}/today">
        <span class="ring">${avatar(k, 54)}</span>
        <div class="grow"><strong style="font-size:18px">Fortsæt som ${escapeHtml(k.name)}</strong></div>
        ${streakBadge(k)}
      </a>`).join("")}`;
}

function avatar(kid, size = 48, extra = "") {
  return `<span class="avatar ${extra}" style="background:${kid.color || COLORS[0]};width:${size}px;height:${size}px">${escapeHtml(kid.name.slice(0, 1).toUpperCase())}</span>`;
}

// Streak: antal dage i træk med mindst én læsning (i dag eller i går tæller som "i gang").
function streak(kid) {
  const days = new Set(Store.all("sessions", (s) => s.kid_id === kid.id).map((s) => localDay(s.studied_at)));
  let d = days.has(today()) ? today() : Planner.addDays(today(), -1);
  let n = 0;
  while (days.has(d)) {
    n++;
    d = Planner.addDays(d, -1);
  }
  return n;
}

function streakBadge(kid) {
  const n = streak(kid);
  return n ? `<span class="streak" aria-label="${n} dage i træk">${icon("flame", 2.2)}${n}</span>` : "";
}

// Det der allerede er læst i dag, vist som klarede punkter øverst i dagens plan.
function doneToday(kid) {
  const byBook = {};
  for (const s of Store.all("sessions", (x) => x.kid_id === kid.id && localDay(x.studied_at) === today())) {
    const d = (byBook[s.book_id] ??= { bookId: s.book_id, fromPage: s.start_page, toPage: s.end_page, minutes: 0, done: true });
    d.fromPage = Math.min(d.fromPage, s.start_page);
    d.toPage = Math.max(d.toPage, s.end_page);
    d.minutes += s.minutes;
  }
  return Object.values(byBook)
    .filter((d) => Store.get("books", d.bookId))
    .map((d) => ({ ...d, pieces: [{ from: d.fromPage, to: d.toPage }] }));
}

// Et punkt i dagens plan er klaret, når man har læst til planens sidste side.
function itemDone(item) {
  if (item.done) return true;
  const book = Store.get("books", item.bookId);
  return (book?.current_page ?? -1) >= item.toPage;
}

function typeSwatch(type) {
  return `<span class="tswatch t-${type}"></span>`;
}

function typeChip(type, extra = "") {
  return `<span class="tchip t-${type}">${TYPES[type].short}${extra ? " · " + escapeHtml(extra) : ""}</span>`;
}

function deadlineLabel(subject) {
  return subject?.kind === "projekt" ? "Aflevering" : "Eksamen";
}

function todayView(kid) {
  const s = settingsOf(kid);
  const plan = planFor(kid);
  const info = Planner.dayTypeInfo(today(), rulesOf(kid.id), s.week);
  const type = info.type;
  const items = [...doneToday(kid), ...plan.today.items];
  const done = items.filter(itemDone).length;
  const next = items.find((i) => !itemDone(i));
  const nextBook = next && Store.get("books", next.bookId);
  const nextSubject = subjectOf(nextBook);
  const plannedSubjects = new Set(plan.today.items.filter((i) => !itemDone(i)).map((i) => Store.get("books", i.bookId)?.curriculum_id));

  const stories = subjectsOf(kid.id)
    .filter((sub) => Planner.subjectStatus(sub.id, booksOf(kid.id), plan).status !== "done")
    .map((sub) => `
      <a class="story" href="#/kid/${kid.id}/subject/${sub.id}">
        <span class="ring ${plannedSubjects.has(sub.id) ? "" : "seen"}"><span class="avatar" style="color:${subjectColor(sub)}">${shortTitle(sub.title)}</span></span>
        <span>${escapeHtml(sub.title)}</span>
      </a>`).join("");

  const rows = items.map((i) => {
    const b = Store.get("books", i.bookId);
    const sub = subjectOf(b);
    const isDone = itemDone(i);
    return `<div class="card item" style="padding:10px 10px 10px 14px">
      <span class="swatch" style="background:${bookColor(b)}"></span>
      <a class="grow" style="text-decoration:none;color:inherit" href="#/kid/${kid.id}/focus/${b.id}">
        <strong style="${isDone ? "text-decoration:line-through;color:var(--muted)" : ""}">${escapeHtml(b.title)}</strong>
        <p class="muted small">s. ${Planner.piecesText(i.pieces)} · ${formatMinutes(i.minutes)}${sub ? " · " + escapeHtml(sub.title) : ""}</p>
      </a>
      <a class="check button" href="#/kid/${kid.id}/focus/${b.id}" aria-label="${isDone ? "Læst" : "Start"} ${escapeHtml(b.title)}" ${isDone ? 'aria-pressed="true"' : ""}>${isDone ? "✓" : icon("play")}</a>
    </div>`;
  });

  const ownDeadline = nextBook && Planner.deadlineFor(nextBook, nextSubject);
  const kicker = nextBook && [
    "Næste op",
    nextSubject ? nextSubject.title : null,
    ownDeadline && ownDeadline !== nextSubject?.deadline ? `egen frist ${shortDate(ownDeadline)}` : null,
  ].filter(Boolean).join(" · ");

  return `
    <div class="row"><span class="wordmark grow" style="font-size:26px;font-weight:800;letter-spacing:-.8px">studieplan</span>${streakBadge(kid)}</div>
    <a class="daytype t-${type}" href="#/kid/${kid.id}/time">
      ${typeSwatch(type)}
      <span class="grow">${TYPES[type].label} i dag${info.rule?.label ? " · " + escapeHtml(info.rule.label) : ""}</span>
      ${type !== "none" ? `<span class="muted">op til ${formatHours(plan.today.capacity)}</span>` : ""}
    </a>
    ${plan.check.worst ? statusPill(kid, plan.check) : ""}
    ${stories ? `<div class="stories">${stories}</div>` : ""}

    ${next ? `<div class="next"><div>
      <span class="kicker">${escapeHtml(kicker)}</span>
      <div><div class="title">${escapeHtml(nextBook.title)}</div>
        <p class="muted">s. ${Planner.piecesText(next.pieces)} · ca. ${formatMinutes(next.minutes)} med din fart</p>
        ${nextSubject?.deadline ? `<p class="small" style="color:#71717A">Hele ${escapeHtml(nextSubject.title)} læst senest ${deadlineLabel(nextSubject).toLowerCase()} ${shortDate(nextSubject.deadline)}</p>` : ""}</div>
      <a class="button dark" style="align-self:flex-start;padding:12px 22px" href="#/kid/${kid.id}/focus/${nextBook.id}">${icon("play")} Start</a>
      <button class="link muted-link" data-action="cancel-today" data-kid="${kid.id}">Jeg når ikke at læse i dag</button>
    </div></div>` : items.length ? `<div class="ok-box"><strong>Alt er læst i dag.</strong> Resten af dagen er din.</div>` : ""}


    <div class="row" style="justify-content:space-between"><span class="section-title">I dag</span>${items.length ? `<span class="muted small">${done} af ${items.length} klaret</span>` : ""}</div>
    ${rows.join("") || (type === "none"
      ? '<div class="fun">Ingen læsetid i dag. Nyd det.</div>'
      : booksOf(kid.id).length ? '<p class="muted">Ingen læsning planlagt i dag.</p>'
      : `<a class="button primary" href="#/kid/${kid.id}/books">Tilføj dit første fag</a>`)}
    ${type !== "none" && !next && plan.check.worst ? `<button class="link muted-link" data-action="cancel-today" data-kid="${kid.id}">Jeg når ikke at læse i dag</button>` : ""}
    ${type !== "none" ? `<div class="fun row">${icon("lock")}<span>Fri fra ${s.freeFrom}. Ingen læsning her.</span></div>` : ""}`;
}

function weekView(kid) {
  const plan = planFor(kid);
  const rules = rulesOf(kid.id);
  const s = settingsOf(kid);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = Planner.addDays(today(), i);
    const info = Planner.dayTypeInfo(d, rules, s.week);
    const entry = plan.days.find((x) => x.date === d) ?? { date: d, minutes: 0, items: [], used: d === today() ? plan.usedToday : 0 };
    days.push({ ...entry, type: info.type, rule: info.rule, capacity: Planner.capacityMinutes(info.type, s) });
  }
  const total = days.reduce((n, d) => n + d.minutes, 0);
  return `
    <div class="row"><h1 class="grow">Ugen</h1>
      <a class="button" href="#/kid/${kid.id}/time">${icon("clock", 2.2)} Læsetid</a></div>
    ${plan.check.worst ? statusPill(kid, plan.check) : ""}
    <div class="card"><strong>${formatMinutes(total)}</strong> læsning de næste 7 dage · læsefart ca. ${formatPace(plan.pace)}</div>
    ${legend()}
    ${days.map((d) => `
      <div class="row" style="margin-top:6px">
        ${typeSwatch(d.type)}
        <span class="section-label grow" style="margin:0">${longDate(d.date)}${d.date === today() ? " · i dag" : ""}</span>
        ${typeChip(d.type, d.rule?.label)}
      </div>
      ${d.capacity ? fillBar(d) : ""}
      ${d.items.length ? d.items.map((i) => {
        const b = Store.get("books", i.bookId);
        const sub = subjectOf(b);
        return `<div class="card item"><span class="swatch" style="background:${bookColor(b)}"></span>
          <div class="grow"><strong>${escapeHtml(b.title)}</strong><p class="muted small">s. ${Planner.piecesText(i.pieces)}${sub ? " · " + escapeHtml(sub.title) : ""}</p></div>
          <span class="muted small">${formatMinutes(i.minutes)}</span></div>`;
      }).join("") : `<div class="fun">${d.type === "none" ? "Fri" : "Intet planlagt"}</div>`}`).join("")}`;
}

// Hvor meget af dagens læsetid der er fyldt op. De sidste 10 % er buffer.
function fillBar(d) {
  const used = (d.used || 0) + d.minutes;
  const pct = Math.min(100, Math.round((used / d.capacity) * 100));
  return `<div class="fill"><div class="cbar"><span class="cap" style="width:${pct}%;background:${used > d.capacity ? "var(--red)" : "var(--grad)"}"></span><span class="buf" style="left:90%;width:10%"></span></div>
    <span class="small muted">Fyldt ${formatMinutes(used)} af ${formatHours(d.capacity)}${used > d.capacity ? " · mere end der er tid til" : used > d.capacity * Planner.FILL + 1 ? " · bufferen er i brug" : " · de sidste 10 % er buffer"}</span></div>`;
}

function legend() {
  return `<div class="legend">${["full", "half", "none"].map((t) => `<span>${typeSwatch(t)}${TYPES[t].short}</span>`).join("")}</div>`;
}

const STATUS = {
  ok: { text: "God plads", color: "var(--green)" },
  tight: { text: "Tæt på", color: "var(--amber)" },
  short: { text: "Ikke nok tid", color: "var(--red)" },
  done: { text: "Læst", color: "var(--green)" },
  none: { text: "Sæt en frist", color: "var(--muted)" },
};

function booksView(kid) {
  const books = booksOf(kid.id);
  const plan = planFor(kid);
  const subjects = subjectsOf(kid.id);
  const ids = new Set(subjects.map((s) => s.id));
  const loose = books.filter((b) => !ids.has(b.curriculum_id));
  const totalPages = books.reduce((n, b) => n + Planner.totalPages(b), 0);
  const readPages = books.reduce((n, b) => n + Planner.pagesUpTo(b, b.current_page ?? null), 0);
  return `
    <div class="row"><div class="grow"><span class="muted small">${escapeHtml(kid.name)}${kid.grade ? " · " + escapeHtml(kid.grade) : ""}</span><h1>Pensum</h1></div>
      <button class="icon-btn" data-action="new-subject" data-kid="${kid.id}" aria-label="Nyt fag eller projekt">${icon("plus", 3)}</button></div>
    <div class="grid-2">
      <div class="stat"><span class="muted small">Samlet</span><strong>${readPages} / ${totalPages}</strong><span class="muted small">sider læst</span></div>
      <div class="stat"><span class="muted small">Din læsefart</span><strong style="color:var(--cyan)">${formatNum(plan.pace.minPerPage)} min</strong>
        <span class="muted small">pr. side · ${plan.pace.measured ? `målt ${plan.pace.samples} ${plan.pace.samples === 1 ? "gang" : "gange"}` : "gæt, til der er målt"}</span></div>
    </div>
    ${plan.check.worst ? statusPill(kid, plan.check) : ""}
    <div class="row" style="justify-content:space-between"><span class="section-title">Fag og projekter</span><span class="muted small">status: tid mod behov + 10 %</span></div>
    ${subjects.map((sub) => {
      const st = Planner.subjectStatus(sub.id, books, plan);
      const pct = st.total ? Math.round((st.read / st.total) * 100) : 0;
      const status = STATUS[st.status];
      return `<a class="card stack" style="text-decoration:none" href="#/kid/${kid.id}/subject/${sub.id}">
        <div class="row">
          <span class="pring" style="background:conic-gradient(${subjectColor(sub)} ${pct * 3.6}deg, var(--line) 0)"><span>${pct}%</span></span>
          <div class="grow"><div class="row" style="gap:8px"><strong style="font-size:16px">${escapeHtml(sub.title)}</strong><span class="kind">${sub.kind === "projekt" ? "PROJEKT" : "FAG"}</span></div>
            <p class="muted small">${st.books.length} ${st.books.length === 1 ? "tekst" : "tekster"} · ${st.read} af ${st.total} sider</p></div>
        </div>
        <div class="row deadline-row"><span class="grow small">${sub.deadline ? `Alt læst senest: ${deadlineLabel(sub).toLowerCase()} ${shortDate(sub.deadline)}` : "Ingen frist endnu"}</span>
          <strong class="small" style="color:${status.color}">${status.text}</strong></div>
      </a>`;
    }).join("") || '<p class="muted">Opret dine fag og projekter med den frist, hvor alt skal være læst. Bagefter lægger du tekster ind under dem.</p>'}
    <button class="ghost wide" data-action="new-subject" data-kid="${kid.id}">+ Nyt fag eller projekt</button>
    ${loose.length ? `<span class="section-title">Uden fag</span>${loose.map((b) => bookCard(kid, b, plan)).join("")}` : ""}
    ${subjects.length ? `<button class="ghost wide" data-action="edit-book" data-kid="${kid.id}">+ Tilføj tekst</button>` : ""}`;
}

function bookCard(kid, b, plan) {
  const p = plan.plans.find((x) => x.bookId === b.id);
  const sub = subjectOf(b);
  const total = Planner.totalPages(b);
  const read = Planner.pagesUpTo(b, b.current_page ?? null);
  const pct = total ? Math.round((read / total) * 100) : 0;
  const own = b.deadline && (!sub?.deadline || b.deadline < sub.deadline);
  return `<button class="card stack" data-action="edit-book" data-kid="${kid.id}" data-id="${b.id}">
    <div class="row"><div class="grow"><strong>${escapeHtml(b.title)}</strong>
      <p class="muted small">${b.author ? escapeHtml(b.author) + " · " : ""}s. ${Planner.piecesText(Planner.rangesOf(b))}</p></div>
      <span class="badge ${own ? "own" : ""}">${own ? "Egen frist " + shortDate(b.deadline) : sub ? "Fagets frist" : b.deadline ? shortDate(b.deadline) : "Ingen frist"}</span></div>
    <div class="bar"><span style="width:${pct}%;background:${bookColor(b)}"></span></div>
    <span class="muted small">${bookStatus(b, p)}</span>
  </button>`;
}

function bookStatus(book, plan) {
  if (!plan) return "";
  if (plan.status === "done") return "Læst færdig";
  if (plan.status === "no-deadline") return "Sæt en frist for at få en plan";
  const at = book.current_page != null ? `Læst til s. ${book.current_page} · ` : "Ikke startet · ";
  if (plan.status === "late") return `${at}Fristen er nået: ${plan.remaining} sider mangler`;
  if (plan.status === "short") return `${at}${plan.remaining} sider tilbage · når det ikke til fristen med den læsetid, du har`;
  return `${at}${plan.remaining} sider tilbage · læst færdig ${shortDate(plan.finish)}`;
}

function subjectView(kid, subjectId) {
  const sub = Store.get("curricula", subjectId);
  if (!sub) return `<a href="#/kid/${kid.id}/books" class="muted">‹ Pensum</a><p class="muted">Faget findes ikke længere.</p>`;
  const plan = planFor(kid);
  const books = booksOf(kid.id);
  const st = Planner.subjectStatus(sub.id, books, plan);
  const pct = st.total ? Math.round((st.read / st.total) * 100) : 0;
  const perDay = st.status === "done" ? "alt er læst" : st.finish ? `læst færdig ${shortDate(st.finish)}` : "";
  return `
    <div class="row"><a href="#/kid/${kid.id}/books" class="icon-link" aria-label="Tilbage">${icon("back", 2.2)}</a>
      <strong class="grow" style="text-align:center">${sub.kind === "projekt" ? "Projekt" : "Fag"}</strong>
      <button class="button" data-action="edit-subject" data-kid="${kid.id}" data-id="${sub.id}">Ret</button></div>
    <div class="hero">
      <span class="small" style="font-weight:800;letter-spacing:.6px">${escapeHtml(sub.title.toUpperCase())} · ALT LÆST SENEST</span>
      <span class="hero-title">${sub.deadline ? `${deadlineLabel(sub)} ${longDate(sub.deadline).toLowerCase()}` : "Ingen frist endnu"}</span>
      <div class="bar" style="background:rgb(255 255 255 / .3)"><span style="width:${pct}%;background:#fff"></span></div>
      <div class="row small" style="justify-content:space-between;font-weight:600"><span>${st.read} af ${st.total} sider</span><span>${perDay}</span></div>
    </div>
    ${st.check ? statusPill(kid, { status: st.status, worst: st.check }) : ""}
    <div class="row" style="justify-content:space-between"><span class="section-title">Tekster</span>
      <button class="link" data-action="edit-book" data-kid="${kid.id}" data-subject="${sub.id}">+ Tilføj tekst</button></div>
    ${st.books.map((b) => bookCard(kid, b, plan)).join("") || '<p class="muted">Ingen tekster endnu.</p>'}
    <div class="card stack small"><span class="section-label" style="margin:0">Sådan hænger fristerne sammen</span>
      <span style="color:var(--soft)">Fagets frist gælder alle tekster. En tekst kan have sin egen, tidligere frist, f.eks. til en midtvejsprøve. Den kan aldrig ligge efter fagets frist.</span></div>`;
}

function timeView(kid, monthArg) {
  const s = settingsOf(kid);
  const rules = rulesOf(kid.id);
  const now = today();
  const month = /^\d{4}-\d{2}$/.test(monthArg ?? "") ? monthArg : now.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const first = `${month}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const offset = (Planner.weekday(first) + 6) % 7; // mandag først
  const shift = (n) => {
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  let full = 0, half = 0;
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push("<span></span>");
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const info = Planner.dayTypeInfo(date, rules, s.week);
    const past = date < now;
    if (!past && info.type === "full") full++;
    if (!past && info.type === "half") half++;
    const special = info.rule && info.rule.kind !== "weekday";
    cells.push(`<button class="cal-day t-${info.type}${date === now ? " is-today" : ""}" data-action="cycle-day" data-kid="${kid.id}" data-date="${date}" ${past ? "disabled" : ""}
      aria-label="${d}. ${LONG_MONTHS[m - 1]}: ${TYPES[info.type].label.toLowerCase()}${info.rule?.label ? ", " + escapeHtml(info.rule.label) : ""}">${d}${special ? '<span class="dot"></span>' : ""}</button>`);
  }
  const capacity = full * Planner.capacityMinutes("full", s) + half * Planner.capacityMinutes("half", s);

  const upcoming = rules
    .filter((r) => (r.kind === "day" ? r.from_date >= now : r.kind === "period" ? r.to_date >= now : !r.to_date || r.to_date >= now))
    .sort((a, b) => {
      const order = { weekday: 0, period: 1, day: 2 };
      return order[a.kind] - order[b.kind] || ((a.from_date ?? "") < (b.from_date ?? "") ? -1 : 1) || a.weekday - b.weekday;
    });

  const hourRow = (type, label, sub) => `
    <div class="row hours-row">
      ${typeSwatch(type)}
      <div class="grow"><strong>${label}</strong><p class="muted small">${sub}</p></div>
      <button class="round" data-action="hours" data-kid="${kid.id}" data-type="${type}" data-step="-0.5" aria-label="${label}: mindre tid">−</button>
      <output class="hours-out">${formatHours(Planner.capacityMinutes(type, s))}</output>
      <button class="round" data-action="hours" data-kid="${kid.id}" data-type="${type}" data-step="0.5" aria-label="${label}: mere tid">+</button>
    </div>`;

  return `
    <div class="row"><a href="#/kid/${kid.id}/week" class="icon-link" aria-label="Tilbage">${icon("back", 2.2)}</a><h1 class="grow">Læsetid</h1></div>

    ${checkCard(planFor(kid).check)}

    <div class="card stack" style="gap:4px">
      <div class="row" style="justify-content:space-between"><span class="kicker-pink">${escapeHtml(kid.name.toUpperCase())}S LÆSETID</span><span class="muted small">kun din profil</span></div>
      ${hourRow("full", "Fuld dag", "fri hverdag med god tid")}
      ${hourRow("half", "Halv dag", "dage med forelæsning eller arbejde")}
      <div class="row hours-row">${typeSwatch("none")}<strong class="grow">Ingen</strong><span class="muted">fri</span></div>
    </div>

    <div class="card stack">
      <div class="row" style="justify-content:space-between"><strong>Normal uge</strong><span class="muted small">tryk for at skifte</span></div>
      <div class="week-grid">${[1, 2, 3, 4, 5, 6, 0].map((dow) => `
        <button class="cal-day t-${s.week[dow]}" data-action="week-day" data-kid="${kid.id}" data-dow="${dow}" aria-label="${LONG_DAY_NAMES[dow]}: ${TYPES[s.week[dow]].label.toLowerCase()}">${DAY_LETTERS[dow]}</button>`).join("")}</div>
    </div>

    <div class="card stack">
      <div class="row">
        <a class="icon-link" href="#/kid/${kid.id}/time/${shift(-1)}" aria-label="Forrige måned">${icon("back", 2.2)}</a>
        <strong class="grow" style="text-align:center;font-size:17px">${LONG_MONTHS[m - 1][0].toUpperCase() + LONG_MONTHS[m - 1].slice(1)} ${y}</strong>
        <a class="icon-link" href="#/kid/${kid.id}/time/${shift(1)}" aria-label="Næste måned" style="transform:scaleX(-1)">${icon("back", 2.2)}</a>
      </div>
      <div class="cal-head">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<span>${DAY_LETTERS[d]}</span>`).join("")}</div>
      <div class="cal">${cells.join("")}</div>
      ${legend()}
      <span class="muted small">Tryk på en dag for at skifte mellem fuld, halv og ingen. Lyserød prik = undtagelse for netop den dag eller en periode. ${full || half ? `Tilbage i måneden: ${full} fulde og ${half} halve læsedage, i alt op til ${formatHours(capacity)}.` : ""}</span>
    </div>

    <div class="row" style="justify-content:space-between"><span class="section-title">Regler</span>
      <button class="link" data-action="new-rule" data-kid="${kid.id}">+ Tilføj</button></div>
    ${upcoming.map((r) => `
      <div class="card row" style="padding:12px 14px">
        <span class="rule-icon">${ruleIcon(r)}</span>
        <div class="grow"><strong>${escapeHtml(r.label || ruleKindName(r))}</strong><p class="muted small">${ruleText(r)}</p></div>
        ${typeChip(r.day_type)}
        <button class="round ghosty" data-action="delete-rule" data-kid="${kid.id}" data-id="${r.id}" aria-label="Slet reglen">${icon("trash")}</button>
      </div>`).join("") || '<p class="muted small">Ingen regler endnu. Tilføj f.eks. forelæsning hver tirsdag, arbejde hver torsdag eller en ferie.</p>'}`;
}

function ruleKindName(r) {
  return { weekday: "Fast ugedag", period: "Periode", day: "Enkelt dag" }[r.kind];
}

function ruleIcon(r) {
  if (r.kind === "weekday") return DAY_NAMES[r.weekday].toUpperCase();
  return `${Number(r.from_date.slice(8))}.`;
}

function ruleText(r) {
  if (r.kind === "weekday") {
    const span = r.from_date || r.to_date
      ? ` · ${r.from_date ? shortDate(r.from_date) : "nu"} - ${r.to_date ? shortDate(r.to_date) : "fremover"}`
      : " · hele tiden";
    return `Hver ${LONG_DAY_NAMES[r.weekday].toLowerCase()}${span}`;
  }
  if (r.kind === "period") return `Periode · ${shortDate(r.from_date)} - ${shortDate(r.to_date)}`;
  return `Enkelt dag · ${shortDate(r.from_date)}`;
}

function meView(kid) {
  const others = kids().length > 1;
  return `
    <div class="stack" style="align-items:center;text-align:center;margin-top:12px">
      <span class="ring">${avatar(kid, 86)}</span>
      <h1>${escapeHtml(kid.name)}</h1>
      ${kid.grade ? `<p class="muted">${escapeHtml(kid.grade)}</p>` : ""}
      ${streakBadge(kid)}
    </div>
    <button class="card row" data-action="edit-kid" data-id="${kid.id}"><strong class="grow">Ret profil</strong><span class="muted">›</span></button>
    <a class="card row" style="text-decoration:none" href="#/kid/${kid.id}/time"><strong class="grow">Læsetid</strong><span class="muted small">fuld ${formatHours(Planner.capacityMinutes("full", settingsOf(kid)))} · halv ${formatHours(Planner.capacityMinutes("half", settingsOf(kid)))}</span><span class="muted">›</span></a>
    ${others ? `<a class="card row" style="text-decoration:none" href="#/"><strong class="grow">Skift profil</strong><span class="muted">›</span></a>` : ""}
    <button class="card row" data-action="account"><strong class="grow">Konto</strong><span class="muted small">${escapeHtml(user?.email ?? "")}</span></button>
    <div class="card row small" style="color:var(--soft)">${icon("lock")}<span>Din plan er kun din. Ingen andre kan se dit pensum, din læsning eller din fart.</span></div>`;
}

function focusView(kid, bookId) {
  const plan = planFor(kid);
  const item = bookId ? plan.today.items.find((i) => i.bookId === bookId) : plan.today.items.find((i) => !itemDone(i));
  const book = Store.get("books", bookId || item?.bookId);
  if (!book) return `<h1>Fokus</h1><p class="muted">Intet at læse lige nu. Vælg en tekst under Pensum.</p>`;
  if (!timer || timer.bookId !== book.id) timer = { bookId: book.id, elapsed: 0, startedAt: null };
  const start = Planner.nextPage(book);
  const sub = subjectOf(book);
  return `
    <div class="focus">
      <div class="row">
        <span class="avatar" style="background:var(--surface-2);width:40px;height:40px;font-size:12px">${shortTitle(sub?.title ?? book.title)}</span>
        <div class="grow"><strong>${escapeHtml(book.title)}</strong>
          <p class="small" style="color:var(--soft)">${item ? `s. ${Planner.piecesText(item.pieces)}` : start != null ? `fra s. ${start}` : "læst færdig"}</p></div>
        <a href="#/kid/${kid.id}/today" aria-label="Luk" style="color:var(--ink);font-size:24px;text-decoration:none;padding:8px">✕</a>
      </div>
      <div class="stack" style="flex:1;justify-content:center;text-align:center">
        <span class="small" style="font-weight:800;letter-spacing:1px;color:var(--cyan)">FOKUS</span>
        <div class="timer" id="clock">${clockText()}</div>
        <span class="small" style="color:var(--soft)">Telefonen bliver liggende. Du klarer det.</span>
      </div>
      <button class="dark wide" data-action="timer-toggle" style="min-height:56px;font-size:18px">${timer.startedAt ? "Pause" : "Start"}</button>
      ${start != null ? `<button class="wide" data-action="log-session" data-kid="${kid.id}" data-id="${book.id}" style="min-height:56px;font-size:18px;background:none;border:1.5px solid #fff">Færdig, gem hvor langt jeg nåede</button>` : ""}
    </div>`;
}

// ============================================================
// Ark: formularer
// ============================================================

function openSheet(html) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").showModal();
}

function closeSheet() {
  $("#sheet").close();
  render();
}

$("#sheet").addEventListener("click", (e) => {
  if (e.target.id === "sheet" || e.target.dataset.action === "close") closeSheet();
});

function kidSheet(kid) {
  const s = settingsOf(kid);
  openSheet(`
    <h2>Profil</h2>
    <form id="kid-form" class="stack">
      <label>Navn<input name="name" required value="${escapeHtml(kid.name)}"></label>
      <div class="grid-2">
        <label>Studie/semester<input name="grade" value="${escapeHtml(kid.grade ?? "")}" placeholder="fx 3. semester"></label>
        <label>Farve<input name="color" type="color" value="${kid.color || COLORS[0]}"></label>
      </div>
      <div class="grid-2">
        <label>Læsning fra<input name="studyFrom" type="time" value="${s.studyFrom}"></label>
        <label>Fritid fra<input name="freeFrom" type="time" value="${s.freeFrom}"></label>
      </div>
      <p class="muted small">Hvor mange timer en fuld og en halv dag er, og hvilke dage du har fri, sætter du under Læsetid.</p>
      <div class="row"><button type="button" class="grow" data-action="close">Annullér</button><button class="primary grow">Gem</button></div>
    </form>`);
  $("#kid-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    await save("kids", {
      id: kid.id,
      name: f.name.value.trim(),
      grade: f.grade.value.trim() || null,
      color: f.color.value,
      settings: { ...(kid.settings || {}), studyFrom: f.studyFrom.value, freeFrom: f.freeFrom.value },
    });
    closeSheet();
  });
}

function subjectSheet(kid, subject) {
  const kind = subject?.kind ?? "fag";
  openSheet(`
    <h2>${subject ? "Ret " + (kind === "projekt" ? "projekt" : "fag") : "Nyt fag eller projekt"}</h2>
    <form id="subject-form" class="stack">
      <div class="seg" role="radiogroup" aria-label="Type">
        <label><input type="radio" name="kind" value="fag" ${kind === "fag" ? "checked" : ""}><span>Fag</span></label>
        <label><input type="radio" name="kind" value="projekt" ${kind === "projekt" ? "checked" : ""}><span>Projekt</span></label>
      </div>
      <label>Navn<input name="title" required value="${escapeHtml(subject?.title ?? "")}" placeholder="fx Mikroøkonomi"></label>
      <label><span id="deadline-label">${kind === "projekt" ? "Aflevering" : "Eksamen"}: alt skal være læst senest</span><input name="deadline" type="date" value="${subject?.deadline ?? ""}"></label>
      <label>Farve<input name="color" type="color" value="${subjectColor(subject ?? { id: crypto.randomUUID() })}"></label>
      <div class="row">
        ${subject ? '<button type="button" class="grow" data-action="delete-subject">Slet</button>' : '<button type="button" class="grow" data-action="close">Annullér</button>'}
        <button class="primary grow">Gem</button>
      </div>
    </form>`);
  const form = $("#subject-form");
  form.addEventListener("change", () => {
    $("#deadline-label").textContent = `${form.elements.kind.value === "projekt" ? "Aflevering" : "Eksamen"}: alt skal være læst senest`;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const saved = await save("curricula", {
      id: subject?.id, kid_id: kid.id, kind: f.kind.value, title: f.title.value.trim(),
      deadline: f.deadline.value || null, color: f.color.value,
    });
    $("#sheet").close();
    if (!subject) go(`#/kid/${kid.id}/subject/${saved.id}`);
    render();
  });
  form.addEventListener("click", async (e) => {
    if (e.target.dataset.action !== "delete-subject") return;
    if (!confirm(`Slet "${subject.title}"? Teksterne bliver liggende under "Uden fag".`)) return;
    await removeRow("curricula", subject.id);
    $("#sheet").close();
    go(`#/kid/${kid.id}/books`);
  });
}

// Slå bogen op ud fra ISBN: først Google Books, så Open Library.
async function lookupIsbn(raw) {
  const isbn = raw.replace(/[^0-9Xx]/g, "");
  if (isbn.length !== 10 && isbn.length !== 13) throw new Error("Et ISBN har 10 eller 13 cifre.");
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const v = res.ok && (await res.json()).items?.[0]?.volumeInfo;
    if (v?.title) return { title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title, author: (v.authors || []).join(", "), pages: v.pageCount || null };
  } catch {}
  try {
    const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const v = res.ok && (await res.json())[`ISBN:${isbn}`];
    if (v?.title) return { title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title, author: (v.authors || []).map((a) => a.name).join(", "), pages: v.number_of_pages || null };
  } catch {}
  return null;
}

function bookSheet(kid, book, presetSubject) {
  const subjects = subjectsOf(kid.id);
  const subjectId = book ? book.curriculum_id : presetSubject ?? (subjects.length === 1 ? subjects[0].id : "");
  let ranges = book ? Planner.rangesOf(book).map((r) => ({ ...r })) : [{ from: 1, to: "" }];
  const ownMode = !!book?.deadline;
  openSheet(`
    <h2>${book ? "Ret tekst" : "Ny tekst"}</h2>
    <form id="book-form" class="stack">
      <div class="row" style="align-items:flex-end">
        <label class="grow">ISBN (valgfrit)<input name="isbn" inputmode="numeric" value="${escapeHtml(book?.isbn ?? "")}" placeholder="978-…"></label>
        <button type="button" class="dark" data-action="isbn">Hent</button>
      </div>
      <p id="isbn-msg" class="muted small" hidden></p>
      <label>Titel<input name="title" required value="${escapeHtml(book?.title ?? "")}"></label>
      <label>Forfatter<input name="author" value="${escapeHtml(book?.author ?? "")}"></label>
      <label>Fag eller projekt<select name="subject">
        <option value="">Uden fag</option>
        ${subjects.map((s) => `<option value="${s.id}" ${s.id === subjectId ? "selected" : ""}>${escapeHtml(s.title)}${s.deadline ? " · frist " + shortDate(s.deadline) : ""}</option>`).join("")}
      </select></label>
      <div class="stack" style="gap:8px">
        <div class="row" style="justify-content:space-between"><span class="label">Sider der skal læses</span><span class="muted small" id="range-total"></span></div>
        <div id="ranges" class="stack" style="gap:8px"></div>
        <button type="button" class="ghost" data-action="add-range">+ Tilføj interval</button>
      </div>
      <div class="stack" style="gap:8px">
        <span class="label">Hvornår skal den være læst?</span>
        <div class="seg" role="radiogroup" aria-label="Frist">
          <label><input type="radio" name="mode" value="subject" ${ownMode ? "" : "checked"}><span>Fagets frist<small id="subject-deadline"></small></span></label>
          <label><input type="radio" name="mode" value="own" ${ownMode ? "checked" : ""}><span>Egen frist<small>f.eks. midtvejsprøve</small></span></label>
        </div>
        <label id="own-deadline" ${ownMode ? "" : "hidden"}>Egen frist<input name="deadline" type="date" value="${book?.deadline ?? ""}"></label>
      </div>
      ${book ? `<label>Læst til side (tom = ikke startet)<input name="current" type="number" inputmode="numeric" value="${book.current_page ?? ""}"></label>` : ""}
      <div id="book-preview" class="notice small"></div>
      <div class="row">
        ${book ? '<button type="button" class="grow" data-action="delete-book">Slet</button>' : '<button type="button" class="grow" data-action="close">Annullér</button>'}
        <button class="primary grow">Gem</button>
      </div>
    </form>`);
  const form = $("#book-form");
  const f = form.elements;

  const drawRanges = () => {
    $("#ranges").innerHTML = ranges.map((r, i) => `
      <div class="range-row">
        <span class="muted small">Fra s.</span><input data-i="${i}" data-k="from" type="number" inputmode="numeric" min="0" value="${r.from}" aria-label="Fra side">
        <span class="muted small">til s.</span><input data-i="${i}" data-k="to" type="number" inputmode="numeric" min="0" value="${r.to}" aria-label="Til side">
        ${ranges.length > 1 ? `<button type="button" class="round ghosty" data-action="remove-range" data-i="${i}" aria-label="Fjern interval">×</button>` : ""}
      </div>`).join("");
  };

  const draft = () => {
    const rs = ranges.map((r) => ({ from: Number(r.from), to: Number(r.to) })).filter((r) => r.to >= r.from && r.from >= 0 && r.to > 0);
    const clean = Planner.rangesOf({ ranges: rs });
    const own = f.mode.value === "own";
    return {
      ...book,
      id: book?.id ?? "ny",
      kid_id: kid.id,
      curriculum_id: f.subject.value || null,
      title: f.title.value.trim(),
      author: f.author.value.trim() || null,
      isbn: f.isbn.value.trim() || null,
      ranges: clean,
      from_page: clean.length ? clean[0].from : null,
      to_page: clean.length ? clean[clean.length - 1].to : null,
      deadline: own ? f.deadline.value || null : null,
      current_page: f.current ? (f.current.value === "" ? null : Number(f.current.value)) : book?.current_page ?? null,
    };
  };

  // Vis med det samme, hvad teksten betyder pr. dag med læsefarten og læsetiden.
  const preview = () => {
    const b = draft();
    const sub = Store.get("curricula", b.curriculum_id);
    $("#subject-deadline").textContent = sub?.deadline ? shortDate(sub.deadline) : "ingen sat";
    $("#own-deadline").hidden = f.mode.value !== "own";
    const el = $("#book-preview");
    const total = b.ranges.length ? Planner.totalPages(b) : 0;
    $("#range-total").textContent = total ? `${total} sider i alt` : "";
    if (!total) return (el.textContent = "Skriv første og sidste side.");
    // Planen med den nye eller rettede tekst sammen med alle de andre.
    const others = Store.all("books").filter((x) => x.id !== b.id);
    const kidPlan = planWith(kid, { books: [...others, b] });
    const plan = kidPlan.plans.find((x) => x.bookId === b.id);
    const later = b.deadline && sub?.deadline && b.deadline > sub.deadline ? ` Egen frist kan ikke ligge efter fagets, så ${shortDate(sub.deadline)} gælder.` : "";
    if (plan.status === "no-deadline") return (el.textContent = `${plan.remaining} sider er ca. ${formatMinutes(plan.totalMinutes)}. Vælg et fag med frist eller sæt en egen frist for at få en plan.`);
    if (plan.status === "done") return (el.textContent = "Teksten er læst færdig.");
    if (plan.status === "late") return (el.textContent = "Fristen er allerede nået." + later);
    const when = plan.status === "short"
      ? `<strong>Den kan ikke nås til ${shortDate(plan.deadline)}</strong> med den læsetid, du har.`
      : `Med dine andre tekster og din læsetid bliver den <strong>læst færdig ${shortDate(plan.finish)}</strong> (frist ${shortDate(plan.deadline)}).`;
    el.innerHTML = `${plan.remaining} sider med ${formatPace(kidPlan.pace)} er ca. <strong>${formatMinutes(plan.totalMinutes)}</strong>. ${when}${escapeHtml(later)}
      <span class="row" style="margin-top:6px;gap:8px"><span class="sdot ${CHECK[kidPlan.check.status].cls}"></span><span><strong>${CHECK[kidPlan.check.status].label}</strong> · ${checkText(kidPlan.check)}</span></span>`;
  };

  drawRanges();
  form.addEventListener("input", (e) => {
    const { i, k } = e.target.dataset;
    if (i != null) ranges[Number(i)][k] = e.target.value;
    preview();
  });
  form.addEventListener("change", preview);
  preview();

  form.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "add-range") {
      const last = ranges[ranges.length - 1];
      const from = Number(last?.to) ? Number(last.to) + 1 : "";
      ranges.push({ from, to: "" });
      drawRanges();
      $(`#ranges input[data-i="${ranges.length - 1}"][data-k="from"]`).focus();
      preview();
    } else if (action === "remove-range") {
      ranges.splice(Number(e.target.closest("[data-i]").dataset.i), 1);
      drawRanges();
      preview();
    } else if (action === "isbn") {
      const msg = $("#isbn-msg");
      msg.hidden = false;
      msg.textContent = "Henter…";
      try {
        const found = await lookupIsbn(f.isbn.value);
        if (!found) {
          msg.textContent = "Fandt ikke bogen. Skriv titel og sider selv.";
          return;
        }
        f.title.value = found.title;
        if (found.author) f.author.value = found.author;
        if (found.pages && ranges.length === 1 && !ranges[0].to) {
          ranges = [{ from: 1, to: found.pages }];
          drawRanges();
        }
        msg.textContent = `Fundet: ${found.title}${found.pages ? ` · ${found.pages} sider i alt` : ""}. Ret siderne, så de passer til dit pensum.`;
        preview();
      } catch (err) {
        msg.textContent = err.message === "Failed to fetch" ? "Ingen forbindelse. Skriv titel og sider selv." : err.message;
      }
    } else if (action === "delete-book") {
      if (!confirm(`Slet "${book.title}"?`)) return;
      await removeRow("books", book.id);
      closeSheet();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = draft();
    if (!b.ranges.length) return alert("Skriv mindst ét interval med første og sidste side.");
    if (b.id === "ny") delete b.id;
    await save("books", b);
    closeSheet();
  });
}

function ruleSheet(kid) {
  openSheet(`
    <h2>Ny regel</h2>
    <form id="rule-form" class="stack">
      <div class="seg three" role="radiogroup" aria-label="Slags regel">
        <label><input type="radio" name="kind" value="weekday" checked><span>Fast ugedag</span></label>
        <label><input type="radio" name="kind" value="period"><span>Periode</span></label>
        <label><input type="radio" name="kind" value="day"><span>Enkelt dag</span></label>
      </div>
      <p id="rule-help" class="muted small"></p>
      <label>Hvad<input name="label" placeholder="fx Forelæsning" required></label>
      <div data-for="weekday" class="stack">
        <label>Ugedag<select name="weekday">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<option value="${d}">${LONG_DAY_NAMES[d]}</option>`).join("")}</select></label>
        <div class="grid-2"><label>Fra (valgfrit)<input name="wfrom" type="date"></label><label>Til (valgfrit)<input name="wto" type="date"></label></div>
      </div>
      <div data-for="period" class="grid-2" hidden><label>Fra<input name="pfrom" type="date"></label><label>Til<input name="pto" type="date"></label></div>
      <div data-for="day" hidden><label>Dato<input name="date" type="date"></label></div>
      <span class="label">Læsetid</span>
      <div class="seg three" role="radiogroup" aria-label="Læsetid">
        ${["full", "half", "none"].map((t) => `<label><input type="radio" name="type" value="${t}" ${t === "half" ? "checked" : ""}><span>${TYPES[t].short}</span></label>`).join("")}
      </div>
      <div class="row"><button type="button" class="grow" data-action="close">Annullér</button><button class="primary grow">Gem regel</button></div>
    </form>`);
  const form = $("#rule-form");
  const f = form.elements;
  const help = {
    weekday: "Gentages hver uge, f.eks. arbejde hver torsdag. Sæt datoer, hvis det kun gælder i en periode.",
    period: "Alle dage fra den ene dato til den anden, f.eks. en ferie.",
    day: "Én bestemt dag, f.eks. en ekstravagt eller en dag der skal holdes fri.",
  };
  const show = () => {
    const kind = f.kind.value;
    $$("[data-for]", form).forEach((el) => (el.hidden = el.dataset.for !== kind));
    $("#rule-help").textContent = help[kind];
  };
  form.addEventListener("change", show);
  show();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const kind = f.kind.value;
    const row = { kid_id: kid.id, kind, day_type: f.type.value, label: f.label.value.trim() || null, weekday: null, from_date: null, to_date: null };
    if (kind === "weekday") {
      Object.assign(row, { weekday: Number(f.weekday.value), from_date: f.wfrom.value || null, to_date: f.wto.value || null });
      if (row.from_date && row.to_date && row.to_date < row.from_date) return alert("Slutdatoen skal være efter startdatoen.");
    } else if (kind === "period") {
      if (!f.pfrom.value || !f.pto.value) return alert("Vælg både fra og til.");
      if (f.pto.value < f.pfrom.value) return alert("Slutdatoen skal være efter startdatoen.");
      Object.assign(row, { from_date: f.pfrom.value, to_date: f.pto.value });
    } else {
      if (!f.date.value) return alert("Vælg en dato.");
      row.from_date = f.date.value;
    }
    await save("day_rules", row);
    closeSheet();
  });
}

// Efter læsning: hvilken side nåede du til, og hvor længe læste du?
function logSheet(kid, book) {
  const start = Planner.nextPage(book);
  if (start == null) return;
  const kidPlan = planFor(kid);
  const item = kidPlan.today.items.find((i) => i.bookId === book.id);
  const none = Planner.stepPage(book, start, -1); // intet læst
  const last = Planner.rangesOf(book).at(-1).to;
  let reached = item?.toPage ?? Planner.takePages(book, start, 10).at(-1).to;
  let minutes = Math.max(1, Math.round(currentElapsed() / 60000)) || item?.minutes || 15;
  const before = kidPlan.pace;
  const sub = subjectOf(book);

  openSheet(`
    <h2>Nice! Hvor langt nåede du?</h2>
    <p class="muted small">${escapeHtml(book.title)}${sub ? " · " + escapeHtml(sub.title) : ""} · startede på s. ${start}</p>
    <div class="card stack">
      <div class="row"><strong class="grow">Jeg nåede til side</strong>
        <div class="stepper"><button type="button" data-step="-1" aria-label="En side færre">−</button><input id="reached" type="number" inputmode="numeric" aria-label="Side"><button type="button" data-step="1" aria-label="En side mere">+</button></div></div>
      <label>Jeg læste i (minutter)<input id="minutes" type="number" inputmode="numeric" min="1" max="600"></label>
    </div>
    <div id="log-result"></div>
    <div class="row"><button type="button" class="grow" data-action="close">Annullér</button><button class="primary grow" id="log-save">Gem</button></div>`);

  // En side mellem to intervaller rykkes tilbage til slutningen af det forrige.
  const snap = (page) => {
    if (!Number.isFinite(page)) return reached;
    let best = none;
    for (const r of Planner.rangesOf(book)) if (page >= r.from) best = Math.min(page, r.to);
    return Math.max(none, Math.min(last, best));
  };

  const show = () => {
    $("#reached").value = reached;
    $("#minutes").value = minutes;
    const pages = Planner.pagesBetween(book, start, reached);
    const session = { kid_id: kid.id, book_id: book.id, start_page: start, end_page: reached, pages, minutes, studied_at: new Date().toISOString() };
    const afterPlan = planWith(kid, {
      sessions: [...Store.all("sessions"), session],
      books: Store.all("books").map((x) => (x.id === book.id ? { ...x, current_page: reached } : x)),
    });
    const after = afterPlan.pace;
    const plan = afterPlan.plans.find((x) => x.bookId === book.id);
    const tight = afterPlan.check.status !== "ok";
    const deadline = plan.deadline;
    const ownEarlier = deadline && sub?.deadline && deadline < sub.deadline;
    const where = deadline ? (ownEarlier ? `din egen frist ${shortDate(deadline)}` : `${sub ? deadlineLabel(sub).toLowerCase() : "fristen"} ${shortDate(deadline)}`) : "";
    const next = Planner.nextPage({ ...book, current_page: reached });
    $("#log-result").innerHTML = pages < 1 ? '<p class="notice">Vælg den side, du nåede til.</p>' : `
      <div class="card stack">
        <span class="section-label">Din læsefart</span>
        <span>I dag: <strong>${pages} sider på ${minutes} min</strong>, ca. ${formatNum(minutes / pages)} min pr. side.</span>
        <span>Ny gennemsnitsfart: <strong>${formatPace(after)}</strong>${before.measured ? ` (før ${formatPace(before)})` : ""}.</span>
      </div>
      <div class="${tight ? "warn-box" : "ok-box"} stack" style="margin-top:10px">
        ${plan.status === "done" ? "<strong>Teksten er læst færdig!</strong>"
          : plan.status === "no-deadline" ? `Der mangler ${plan.remaining} sider. Sæt en frist for at få en plan.`
          : plan.status === "short" || plan.status === "late"
            ? `<span>Resten (${plan.remaining} sider fra s. ${next}) <strong>kan ikke nås til ${where}</strong> med den læsetid, du har.</span>
               <span>Gør fri dage til halve eller halve til fulde under Læsetid.</span>`
            : `<span>Resten (${plan.remaining} sider fra s. ${next}) bliver <strong>læst færdig ${shortDate(plan.finish)}</strong>, før ${where}.</span>
               <span><strong>${CHECK[afterPlan.check.status].label}</strong> · ${checkText(afterPlan.check)}.${ownEarlier && !tight ? ` ${escapeHtml(sub.title)} skal være læst til ${deadlineLabel(sub).toLowerCase()} ${shortDate(sub.deadline)}.` : ""}</span>`}
      </div>`;
  };
  show();
  $("#sheet-body").addEventListener("click", (e) => {
    const step = Number(e.target.dataset.step);
    if (step) {
      reached = Math.max(none, Math.min(last, Planner.stepPage(book, reached, step)));
      show();
    }
  });
  $("#reached").addEventListener("change", (e) => {
    reached = snap(Number(e.target.value));
    show();
  });
  $("#minutes").addEventListener("change", (e) => {
    minutes = Math.max(1, Number(e.target.value) || 1);
    show();
  });
  $("#log-save").addEventListener("click", async () => {
    if (reached < start) return closeSheet();
    const pages = Planner.pagesBetween(book, start, reached);
    await Store.put("sessions", { kid_id: kid.id, book_id: book.id, start_page: start, end_page: reached, pages, minutes, studied_at: new Date().toISOString() });
    await Store.put("books", { id: book.id, current_page: reached });
    sync();
    timer = null;
    $("#sheet").close();
    go(`#/kid/${kid.id}/today`);
    render();
  });
}

// ============================================================
// Aflys i dag: hvad betyder det for tiden, og hvor kan den findes?
// ============================================================

// Regler der kun lever i arket, til at vise konsekvensen før noget gemmes.
const draftRule = (kid, date, type) => ({ id: "kladde-" + date, kid_id: kid.id, kind: "day", from_date: date, day_type: type, updated_at: "9999" });

function cancelSheet(kid) {
  const t = today();
  const rules = Store.all("day_rules");
  const s = settingsOf(kid);
  const before = planFor(kid);
  const cancel = draftRule(kid, t, "none");
  const afterCancel = planWith(kid, { rules: [...rules, cancel] });
  // Forslag: de næste dage frem til den strammeste frist, der kan få mere læsetid.
  const until = afterCancel.check.worst?.deadline ?? Planner.addDays(t, 21);
  const ideas = [];
  for (let d = Planner.addDays(t, 1); d <= until && ideas.length < 4; d = Planner.addDays(d, 1)) {
    const type = afterCancel.typeOf(d);
    if (type !== "full") ideas.push({ date: d, from: type, to: type === "none" ? "half" : "full" });
  }
  const picked = new Set();
  const planned = before.today.minutes;

  openSheet(`
    <h2>Når du ikke at læse i dag?</h2>
    <p class="muted small">${longDate(t)} har ${TYPES[before.today.dayType].label.toLowerCase()} (${formatHours(before.today.capacity)}).${planned ? ` Planlagt: ${formatMinutes(planned)}.` : ""} Dagen bliver fri, og planen flyttes.</p>
    <div id="cancel-check"></div>
    <div id="cancel-ideas" class="stack" style="gap:8px"></div>
    <div class="row"><button type="button" class="grow" data-action="close">Fortryd</button><button class="primary grow" id="cancel-save">Aflys i dag</button></div>`);

  const draw = () => {
    const extra = [...picked].map((i) => draftRule(kid, ideas[i].date, ideas[i].to));
    const after = planWith(kid, { rules: [...rules, cancel, ...extra] });
    $("#cancel-check").innerHTML = checkCard(after.check);
    const show = after.check.status !== "ok" || picked.size;
    $("#cancel-ideas").innerHTML = show && ideas.length ? `
      <span class="section-label" style="margin:0">Forslag til ny læsetid</span>
      ${ideas.map((idea, i) => `<button type="button" class="idea ${picked.has(i) ? "on" : ""}" data-idea="${i}" aria-pressed="${picked.has(i)}">
        <span class="grow">${shortDate(idea.date)}: ${TYPES[idea.from].short.toLowerCase()} → ${TYPES[idea.to].short.toLowerCase()} (+${formatHours(Planner.capacityMinutes(idea.to, s) - Planner.capacityMinutes(idea.from, s))})</span>
        <span>${picked.has(i) ? "Tilføjet" : "+"}</span></button>`).join("")}` : "";
    const btn = $("#cancel-save");
    btn.textContent = after.check.status === "ok" ? (picked.size ? "Aflys og tilføj tid" : "Aflys i dag") : "Aflys alligevel";
    btn.className = after.check.status === "ok" ? "primary grow" : "grow";
  };
  draw();

  $("#cancel-ideas").addEventListener("click", (e) => {
    const el = e.target.closest("[data-idea]");
    if (!el) return;
    const i = Number(el.dataset.idea);
    picked.has(i) ? picked.delete(i) : picked.add(i);
    draw();
  });
  $("#cancel-save").addEventListener("click", async () => {
    await setDayType(kid, t, "none", "Aflyst");
    for (const i of picked) await setDayType(kid, ideas[i].date, ideas[i].to, "Ekstra læsetid");
    sync();
    closeSheet();
  });
}

// Gem en undtagelse for én dag (erstatter en tidligere undtagelse samme dag).
async function setDayType(kid, date, type, label) {
  const existing = rulesOf(kid.id).filter((r) => r.kind === "day" && r.from_date === date);
  for (const r of existing.slice(1)) await Store.remove("day_rules", r.id);
  await Store.put("day_rules", { id: existing[0]?.id, kid_id: kid.id, kind: "day", from_date: date, to_date: null, weekday: null, day_type: type, label });
}

// ============================================================
// Siden sidst: læsedage, hvor der ikke er registreret noget
// ============================================================

let catchupDone = false;

// Læsedage siden sidste besøg (til og med i går), hvor der ikke er gemt en læsning.
function missedDays(kid) {
  const s = settingsOf(kid);
  if (!s.lastSeen) return [];
  const rules = rulesOf(kid.id);
  const logged = new Set(Store.all("sessions", (x) => x.kid_id === kid.id).map((x) => localDay(x.studied_at)));
  const out = [];
  const from = Planner.addDays(s.lastSeen, 1) > Planner.addDays(today(), -14) ? Planner.addDays(s.lastSeen, 1) : Planner.addDays(today(), -14);
  for (let d = from; d < today(); d = Planner.addDays(d, 1)) {
    if (Planner.dayType(d, rules, s.week) !== "none" && !logged.has(d)) out.push(d);
  }
  return out;
}

async function markSeen(kid) {
  const k = Store.get("kids", kid.id);
  if (settingsOf(k).lastSeen === today()) return;
  await save("kids", { id: k.id, settings: { ...(k.settings || {}), lastSeen: today() } });
}

function maybeCatchup(kid) {
  if (catchupDone || !kid || $("#sheet").open) return;
  catchupDone = true;
  const days = missedDays(kid).filter((d) => planWith(kid, { day: d }).today.items.length);
  if (days.length) catchupSheet(kid, days);
  else markSeen(kid);
}

// Én dag ad gangen: hvad var planlagt den dag, og blev det læst?
function catchupSheet(kid, days) {
  let i = 0;
  const step = () => {
    if (i >= days.length) return finish();
    const d = days[i];
    const items = planWith(kid, { day: d }).today.items;
    if (!items.length) {
      i++;
      return step();
    }
    const type = planWith(kid, { day: d }).typeOf(d);
    openSheet(`
      <span class="muted small">${days.length > 1 ? `Dag ${i + 1} af ${days.length} · ` : ""}Siden du sidst var inde</span>
      <h2>Fik du læst ${longDate(d).toLowerCase()}?</h2>
      <div class="row small">${typeSwatch(type)}<span class="muted">${TYPES[type].label}. Planlagt:</span></div>
      <div class="stack" style="gap:8px;margin:8px 0 12px">${items.map((it) => {
        const b = Store.get("books", it.bookId);
        return `<div class="card item"><span class="swatch" style="background:${bookColor(b)}"></span>
          <div class="grow"><strong>${escapeHtml(b.title)}</strong><p class="muted small">s. ${Planner.piecesText(it.pieces)} · ${formatMinutes(it.minutes)}</p></div></div>`;
      }).join("")}</div>
      <div class="seg three" role="group" aria-label="Svar">
        <label><input type="radio" name="ans" value="yes"><span>Ja, alt</span></label>
        <label><input type="radio" name="ans" value="part"><span>Noget</span></label>
        <label><input type="radio" name="ans" value="no"><span>Nej</span></label>
      </div>
      <form id="part-form" class="stack" style="margin-top:12px" hidden>
        ${items.map((it, n) => {
          const b = Store.get("books", it.bookId);
          return `<div class="card stack" style="gap:6px"><strong class="small">${escapeHtml(b.title)}</strong>
            <div class="grid-2"><label>Nåede til side<input name="page${n}" type="number" inputmode="numeric" placeholder="${it.fromPage}-${it.toPage}"></label>
            <label>Minutter<input name="min${n}" type="number" inputmode="numeric" min="1"></label></div></div>`;
        }).join("")}
        <button class="primary">Gem</button>
      </form>`);
    const logItem = async (it, page, minutes) => {
      const b = Store.get("books", it.bookId);
      const end = Math.min(page, Planner.rangesOf(b).at(-1).to);
      const pages = Planner.pagesBetween(b, it.fromPage, end);
      if (pages < 1) return;
      await Store.put("sessions", { kid_id: kid.id, book_id: b.id, start_page: it.fromPage, end_page: end, pages, minutes: Math.max(1, minutes || Math.round(pages * it.minutes / it.pages)), studied_at: new Date(d + "T12:00:00").toISOString() });
      await Store.put("books", { id: b.id, current_page: Math.max(b.current_page ?? -1, end) });
    };
    $("#sheet-body").addEventListener("change", async (e) => {
      if (e.target.name !== "ans") return;
      if (e.target.value === "part") return ($("#part-form").hidden = false);
      if (e.target.value === "yes") for (const it of items) await logItem(it, it.toPage, it.minutes);
      i++;
      step();
    });
    $("#part-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      for (const [n, it] of items.entries()) {
        const page = Number(f["page" + n].value);
        if (page) await logItem(it, page, Number(f["min" + n].value));
      }
      i++;
      step();
    });
  };
  const finish = async () => {
    await markSeen(kid);
    sync();
    const check = planFor(kid).check;
    openSheet(`
      <h2>Planen er rettet</h2>
      <p class="muted small">Alt der ikke blev læst, er flyttet frem i planen.</p>
      ${checkCard(check)}
      <div class="row" style="margin-top:12px">
        ${check.status === "ok" ? '<button class="primary grow" data-action="close">Videre til i dag</button>'
          : `<button class="grow" data-action="close">Senere</button><a class="button primary grow" href="#/kid/${kid.id}/time" id="go-time">Find mere læsetid</a>`}
      </div>`);
    $("#go-time")?.addEventListener("click", () => $("#sheet").close());
  };
  step();
}

// ============================================================
// Læsetid: timer pr. dagstype, normal uge og enkelte dage
// ============================================================

async function changeHours(kid, type, step) {
  const s = settingsOf(kid);
  const key = type === "full" ? "fullHours" : "halfHours";
  let value = s[key] + step;
  if (type === "full") value = Math.min(12, Math.max(s.halfHours + 0.5, value));
  else value = Math.max(0.5, Math.min(s.fullHours - 0.5, value));
  await save("kids", { id: kid.id, settings: { ...(kid.settings || {}), [key]: value } });
}

async function cycleWeekday(kid, dow) {
  const week = [...settingsOf(kid).week];
  week[dow] = NEXT_TYPE[week[dow]];
  await save("kids", { id: kid.id, settings: { ...(kid.settings || {}), week } });
}

// Tryk på en dag i kalenderen: fuld → halv → ingen. Ender man på det, dagen
// ville være uden undtagelse, fjernes undtagelsen igen.
async function cycleDay(kid, date) {
  const rules = rulesOf(kid.id);
  const week = settingsOf(kid).week;
  const now = Planner.dayType(date, rules, week);
  const base = Planner.dayTypeInfo(date, rules, week, { skipDays: true }).type;
  const next = NEXT_TYPE[now];
  const existing = rules.filter((r) => r.kind === "day" && r.from_date === date);
  if (next === base) {
    for (const r of existing) await Store.remove("day_rules", r.id);
  } else if (existing.length) {
    await Store.put("day_rules", { id: existing[0].id, day_type: next });
    for (const r of existing.slice(1)) await Store.remove("day_rules", r.id);
  } else {
    await Store.put("day_rules", { kid_id: kid.id, kind: "day", from_date: date, to_date: null, weekday: null, day_type: next, label: null });
  }
  sync();
}

// ============================================================
// Fokus-timer
// ============================================================

function currentElapsed() {
  if (!timer) return 0;
  return timer.elapsed + (timer.startedAt ? Date.now() - timer.startedAt : 0);
}

function clockText() {
  const s = Math.floor(currentElapsed() / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

setInterval(() => {
  const el = $("#clock");
  if (el) el.textContent = clockText();
}, 1000);

// ============================================================
// Klik og formularer på siden
// ============================================================

$("#app").addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;
  const kid = el.dataset.kid && Store.get("kids", el.dataset.kid);
  if (action === "edit-kid") kidSheet(Store.get("kids", id));
  else if (action === "new-subject") subjectSheet(kid, null);
  else if (action === "edit-subject") subjectSheet(kid, Store.get("curricula", id));
  else if (action === "edit-book") bookSheet(kid, id && Store.get("books", id), el.dataset.subject);
  else if (action === "log-session") logSheet(kid, Store.get("books", id));
  else if (action === "new-rule") ruleSheet(kid);
  else if (action === "cancel-today") cancelSheet(kid);
  else if (action === "delete-rule") {
    const r = Store.get("day_rules", id);
    if (r && confirm(`Slet reglen "${r.label || ruleKindName(r)}"?`)) await removeRow("day_rules", id);
  } else if (action === "hours") await changeHours(kid, el.dataset.type, Number(el.dataset.step));
  else if (action === "week-day") await cycleWeekday(kid, Number(el.dataset.dow));
  else if (action === "cycle-day") await cycleDay(kid, el.dataset.date);
  else if (action === "account") accountSheet();
  else if (action === "timer-toggle") {
    if (timer.startedAt) {
      timer.elapsed += Date.now() - timer.startedAt;
      timer.startedAt = null;
    } else timer.startedAt = Date.now();
    el.textContent = timer.startedAt ? "Pause" : "Start";
  }
});

$("#app").addEventListener("submit", async (e) => {
  if (e.target.id !== "welcome-form") return;
  e.preventDefault();
  const f = e.target.elements;
  const kid = await save("kids", {
    name: f.name.value.trim(),
    grade: f.grade.value.trim() || null,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    settings: { fullHours: 4, halfHours: 2, week: [...Planner.DEFAULT_WEEK], lastSeen: today() },
  });
  go(`#/kid/${kid.id}/books`);
});

// ============================================================
// Login
// ============================================================

function showView(signedIn) {
  $("#auth-view").hidden = signedIn;
  $("#app").hidden = !signedIn;
  if (!signedIn) $("#tabbar").hidden = true;
}

function authMessage(text, kind = "") {
  const el = $("#auth-msg");
  el.hidden = !text;
  el.className = "notice " + kind;
  el.textContent = text;
}

function translateAuthError(err) {
  const m = err?.message || String(err);
  if (/invalid login credentials/i.test(m)) return "Forkert e-mail eller adgangskode.";
  if (/email not confirmed/i.test(m)) return "Du skal først bekræfte din e-mail via linket, vi har sendt dig.";
  if (/already registered/i.test(m)) return "Der findes allerede en konto med den e-mail. Log ind i stedet.";
  if (/password should be at least/i.test(m)) return "Adgangskoden skal være på mindst 8 tegn.";
  if (/rate limit/i.test(m)) return "For mange forsøg. Vent lidt og prøv igen.";
  if (/fetch|network/i.test(m)) return "Ingen forbindelse. Tjek dit internet.";
  return m;
}

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const mode = e.submitter?.dataset.mode || "signin";
  const email = e.target.email.value.trim();
  const password = e.target.password.value;
  const buttons = $$("button", e.target);
  buttons.forEach((b) => (b.disabled = true));
  authMessage(mode === "signup" ? "Opretter konto…" : "Logger ind…");
  try {
    if (mode === "signup") {
      const { data, error } = await db.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (data.session) return;
      authMessage("Konto oprettet! Tjek din e-mail og klik på linket. Kom derefter tilbage og log ind.", "ok");
    } else {
      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
      authMessage("");
    }
  } catch (err) {
    authMessage(translateAuthError(err), "error");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

function accountSheet() {
  openSheet(`
    <h2>Konto</h2>
    <p class="muted">Logget ind som <strong>${escapeHtml(user?.email ?? "")}</strong></p>
    <div class="row" style="margin-top:12px"><button class="grow" data-action="close">Luk</button><button class="grow" id="logout-btn">Log ud</button></div>`);
  $("#logout-btn").addEventListener("click", async () => {
    if (Store.pendingCount() && !confirm("Nogle ændringer er endnu ikke gemt online og går tabt, hvis du logger ud. Log ud alligevel?")) return;
    $("#sheet").close();
    await db.auth.signOut();
  });
}

async function onSignedIn(newUser) {
  user = newUser;
  await Store.useOwner(newUser.id);
  showView(true);
  if (!location.hash) {
    const last = localStorage.getItem(KID_KEY);
    if (last && Store.get("kids", last)) location.hash = `#/kid/${last}/today`;
  }
  render();
  await sync();
  synced = true;
  render();
}

async function start() {
  await Store.open();
  db.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      if (user?.id !== session.user.id) onSignedIn(session.user);
    } else if (event === "SIGNED_OUT") {
      user = null;
      Store.clear();
      try {
        localStorage.removeItem(KID_KEY);
      } catch {}
      location.hash = "";
      showView(false);
    }
  });
  // Uden net: brug den gemte session, så appen åbner offline.
  const { data } = await db.auth.getSession();
  if (data.session?.user) onSignedIn(data.session.user);
  else showView(false);
}

start();

// ============================================================
// Hjælpere
// ============================================================

// Lokal dato ("YYYY-MM-DD") for et tidspunkt gemt i UTC.
function localDay(iso) {
  return iso ? Planner.toIso(new Date(iso)) : null;
}

function longDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return `${LONG_DAY_NAMES[d.getDay()]} ${d.getDate()}. ${MONTHS[d.getMonth()]}`;
}

function shortDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()}. ${MONTHS[d.getMonth()]}`;
}

function formatNum(x) {
  return x.toFixed(1).replace(/\.0$/, "").replace(".", ",");
}

function formatPace(p) {
  return `${formatNum(p.minPerPage)} min pr. side`;
}

function formatMinutes(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} t${m % 60 ? ` ${m % 60} min` : ""}`;
}

function formatHours(min) {
  return `${formatNum(min / 60)} t`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
