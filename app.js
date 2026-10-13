// Studieplan – lektie- og læseplan for børn.
// Data ligger i en offline database på enheden (store.js) og synkroniseres med
// Supabase bag familiens login. Planen udregnes i planner.js ud fra bøgernes
// sidetal, fristerne og barnets målte læsefart.

const KID_KEY = "studieplan.kid.v1";   // hvilket barn der sidst brugte enheden
const COLORS = ["#C2410C", "#6D28D9", "#2F55D4", "#1F7A52", "#B4235A"];
const DAY_NAMES = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
const LONG_DAY_NAMES = ["Søndag", "Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag"];
const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const { supabaseUrl, supabaseKey } = window.STUDY_PLANNER_CONFIG;
const db = supabase.createClient(supabaseUrl, supabaseKey);

let user = null;
let timer = null; // { bookId, startedAt, elapsed, running }

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

// ============================================================
// Data-hjælpere
// ============================================================

const kids = () => Store.all("kids").sort((a, b) => (a.created_at ?? a.id) < (b.created_at ?? b.id) ? -1 : 1);
const booksOf = (kidId) => Store.all("books", (b) => b.kid_id === kidId);
const curriculumOf = (kidId) => Store.all("curricula", (c) => c.kid_id === kidId)[0] ?? null;

function planFor(kid) {
  return Planner.planKid({
    kid,
    curricula: Store.all("curricula"),
    books: Store.all("books"),
    sessions: Store.all("sessions"),
    today: today(),
  });
}

// Det barnet allerede har læst i dag i en bog.
function readToday(bookId) {
  return Store.all("sessions", (s) => s.book_id === bookId && localDay(s.studied_at) === today());
}

function settingsOf(kid) {
  return { maxMinutesPerDay: 120, studyFrom: "09:00", freeFrom: "17:00", studyDays: [1, 2, 3, 4, 5], ...(kid.settings || {}) };
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
  const tab = (key, label, inner) =>
    `<a href="#/kid/${kid.id}/${key}" aria-label="${label}" ${current === key ? 'aria-current="page"' : ""}>${inner}</a>`;
  nav.innerHTML =
    tab("today", "I dag", icon("today", current === "today" ? 2.6 : 2)) +
    tab("week", "Ugen", icon("week", current === "week" ? 2.6 : 2)) +
    tab("focus", "Start læsning", `<span class="create"><span>${icon("plus", 3)}</span></span>`) +
    tab("books", "Pensum", icon("books", current === "books" ? 2.6 : 2)) +
    `<a href="#/" aria-label="Skift profil">${avatar(kid, 30, "me")}</a>`;
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
    else app.innerHTML = todayView(kid);
  } else if (r.name === "parent") {
    renderTabbar(null);
    app.innerHTML = parentView();
  } else {
    renderTabbar(null);
    app.innerHTML = pickerView();
  }
}

// ============================================================
// Visninger
// ============================================================

function pickerView() {
  const list = kids();
  return `
    <div class="auth-card" style="margin:24px auto 12px">
      <div class="logo">${icon("books")}</div>
      <h1 style="font-size:34px">studieplan</h1>
      <p class="muted">Læs pensum i dit eget tempo. Planen følger med.</p>
    </div>
    ${list.map((k) => {
      const plan = planFor(k);
      const all = [...doneToday(k), ...plan.today.items];
      const left = all.filter((i) => !itemDone(i)).length;
      return `<a class="card row" style="text-decoration:none" href="#/kid/${k.id}/today">
        <span class="ring ${left ? "" : "seen"}">${avatar(k, 54)}</span>
        <div class="grow"><strong style="font-size:18px">${escapeHtml(k.name)}</strong>
          <p class="muted small">${all.length === 0 ? "Ingen læsning i dag" : left === 0 ? "Alt klaret i dag" : `${all.length - left} af ${all.length} klaret i dag`}</p></div>
        ${streakBadge(k)}
      </a>`;
    }).join("")}
    <a class="card row" style="text-decoration:none;background:none;border:1px solid var(--line)" href="#/parent">
      <div class="grow"><strong style="font-size:18px">Følg med</strong><p class="muted small">Overblik for forælder</p></div>
    </a>
    ${list.length === 0 ? '<p class="notice">Start med at tilføje profiler under Følg med.</p>' : ""}`;
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

// Fast farve pr. bog (ud fra id'et, så den er ens på alle enheder).
const BOOK_COLORS = ["#FF3B7F", "#25F4EE", "#FFB547", "#8B7CFF", "#3DDC97"];
function bookColor(book) {
  let h = 0;
  for (const c of book.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BOOK_COLORS[h % BOOK_COLORS.length];
}

function shortTitle(title) {
  return escapeHtml(title.replace(/[,(].*$/, "").slice(0, 5));
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
  return Object.values(byBook).filter((d) => Store.get("books", d.bookId));
}

// Et punkt i dagens plan er klaret, når barnet har læst til planens sidste side.
function itemDone(item) {
  if (item.done) return true;
  const book = Store.get("books", item.bookId);
  return (book?.current_page ?? 0) >= item.toPage;
}

function todayView(kid) {
  const s = settingsOf(kid);
  const plan = planFor(kid);
  const items = [...doneToday(kid), ...plan.today.items];
  const done = items.filter(itemDone).length;
  const next = items.find((i) => !itemDone(i));
  const nextBook = next && Store.get("books", next.bookId);
  const planned = new Set(plan.today.items.filter((i) => !itemDone(i)).map((i) => i.bookId));

  const stories = booksOf(kid.id).filter((b) => Planner.remainingPages(b) > 0).map((b) => `
    <a class="story" href="#/kid/${kid.id}/focus/${b.id}">
      <span class="ring ${planned.has(b.id) ? "" : "seen"}"><span class="avatar">${shortTitle(b.title)}</span></span>
      <span>${escapeHtml(b.title)}</span>
    </a>`).join("");

  const rows = items.map((i) => {
    const b = Store.get("books", i.bookId);
    const isDone = itemDone(i);
    return `<div class="card item" style="padding:10px 10px 10px 14px">
      <span class="swatch" style="background:${bookColor(b)}"></span>
      <a class="grow" style="text-decoration:none;color:inherit" href="#/kid/${kid.id}/focus/${b.id}">
        <strong style="${isDone ? "text-decoration:line-through;color:var(--muted)" : ""}">${escapeHtml(b.title)}</strong>
        <p class="muted small">s. ${i.fromPage}-${i.toPage} · ${i.minutes} min</p>
      </a>
      <a class="check button" href="#/kid/${kid.id}/focus/${b.id}" aria-label="${isDone ? "Læst" : "Start"} ${escapeHtml(b.title)}" ${isDone ? 'aria-pressed="true"' : ""}>${isDone ? "✓" : icon("play")}</a>
    </div>`;
  });

  return `
    <div class="row"><span class="wordmark grow" style="font-size:26px;font-weight:800;letter-spacing:-.8px">studieplan</span>${streakBadge(kid)}</div>
    ${stories ? `<div class="stories">${stories}</div>` : ""}

    ${next ? `<div class="next"><div>
      <span class="kicker">Næste op · ${deadlineText(Planner.deadlineFor(nextBook, Store.get("curricula", nextBook.curriculum_id)))}</span>
      <div><div class="title">${escapeHtml(nextBook.title)}</div>
        <p class="muted">s. ${next.fromPage}-${next.toPage} · ca. ${next.minutes} min med din fart</p></div>
      <a class="button dark" style="align-self:flex-start;padding:12px 22px" href="#/kid/${kid.id}/focus/${nextBook.id}">${icon("play")} Start</a>
    </div></div>` : items.length ? `<div class="ok-box"><strong>Alt er læst i dag.</strong> Resten af dagen er din.</div>` : ""}

    ${plan.atRisk ? `<div class="warn-box small">Planen er stram lige nu. Overvej at starte tidligere på dagen eller flytte en frist.</div>` : ""}

    <div class="row" style="justify-content:space-between"><span class="section-title">I dag</span>${items.length ? `<span class="muted small">${done} af ${items.length} klaret</span>` : ""}</div>
    ${rows.join("") || '<p class="muted">Ingen læsning planlagt i dag.</p>'}
    <div class="fun row">${icon("lock")}<span>Fri fra ${s.freeFrom}. Ingen læsning her.</span></div>`;
}

function weekView(kid) {
  const plan = planFor(kid);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = Planner.addDays(today(), i);
    days.push(plan.days.find((x) => x.date === d) ?? { date: d, minutes: 0, items: [] });
  }
  const total = days.reduce((s, d) => s + d.minutes, 0);
  return `
    <h1>De næste 7 dage</h1>
    <div class="card"><strong>${formatMinutes(total)}</strong> læsning i alt · læsefart ca. ${formatPace(plan.pace)}</div>
    ${days.map((d) => `
      <p class="section-label">${longDate(d.date)}${d.tooMuch ? " · for meget" : ""}</p>
      ${d.items.length ? d.items.map((i) => {
        const b = Store.get("books", i.bookId);
        return `<div class="card item"><span class="swatch" style="background:${bookColor(b)}"></span>
          <div class="grow"><strong>${escapeHtml(b.title)}</strong><p class="muted small">s. ${i.fromPage}-${i.toPage}</p></div>
          <span class="muted small">${i.minutes} min</span></div>`;
      }).join("") : '<div class="fun">Fri</div>'}`).join("")}`;
}

function booksView(kid) {
  const cur = curriculumOf(kid.id);
  const books = booksOf(kid.id);
  const plan = planFor(kid);
  const totalPages = books.reduce((s, b) => s + (b.to_page - b.from_page + 1), 0);
  const readPages = books.reduce((s, b) => s + Math.max(0, (b.current_page ?? b.from_page - 1) - b.from_page + 1), 0);
  return `
    <div class="row"><div class="grow"><span class="muted small">${escapeHtml(kid.name)}${kid.grade ? " · " + escapeHtml(kid.grade) : ""}</span><h1>Pensum</h1></div></div>
    <button class="card stack" data-action="edit-curriculum" data-kid="${kid.id}">
      <div class="row"><span class="grow muted small">Samlet frist for pensum</span><strong>${cur?.deadline ? longDate(cur.deadline) : "Ikke sat"}</strong></div>
      <div class="bar"><span style="width:${totalPages ? Math.round((readPages / totalPages) * 100) : 0}%;background:var(--green)"></span></div>
      <span class="muted small">${readPages} af ${totalPages} sider læst${plan.atRisk ? " · planen er stram" : ""}</span>
    </button>
    <div class="card row"><span class="grow">Læsefart: <strong>ca. ${formatPace(plan.pace)}</strong></span>
      <span class="muted small">${plan.pace.measured ? `målt ${plan.pace.samples} gange` : "gæt, til der er målt"}</span></div>
    ${books.map((b) => {
      const p = plan.plans.find((x) => x.bookId === b.id);
      const read = Math.max(0, (b.current_page ?? b.from_page - 1) - b.from_page + 1);
      const pct = Math.round((read / (b.to_page - b.from_page + 1)) * 100);
      return `<button class="card stack" data-action="edit-book" data-kid="${kid.id}" data-id="${b.id}">
        <div class="row"><div class="grow"><strong>${escapeHtml(b.title)}</strong>
          <p class="muted small">${b.subject ? escapeHtml(b.subject) + " · " : ""}s. ${b.from_page}-${b.to_page}</p></div>
          <span class="badge ${b.deadline ? "own" : ""}">${b.deadline ? shortDate(b.deadline) : "Samlet frist"}</span></div>
        <div class="bar"><span style="width:${pct}%;background:${bookColor(b)}"></span></div>
        <span class="muted small">${bookStatus(b, p)}</span>
      </button>`;
    }).join("")}
    <button class="ghost wide" data-action="edit-book" data-kid="${kid.id}">+ Tilføj bog eller tekst</button>`;
}

function bookStatus(book, plan) {
  if (!plan) return "";
  if (plan.status === "done") return "Læst færdig";
  if (plan.status === "no-deadline") return "Sæt en frist for at få en plan";
  const perDay = plan.days.length ? Math.round(plan.totalMinutes / plan.days.length) : plan.totalMinutes;
  const at = book.current_page ? `Læst til s. ${book.current_page} · ` : "";
  return plan.status === "late" ? `${at}Fristen er nået: ${plan.remaining} sider mangler` : `${at}ca. ${perDay} min om dagen`;
}

function focusView(kid, bookId) {
  const plan = planFor(kid);
  const item = bookId ? plan.today.items.find((i) => i.bookId === bookId) : plan.today.items.find((i) => !itemDone(i));
  const book = Store.get("books", bookId || item?.bookId);
  if (!book) return `<h1>Fokus</h1><p class="muted">Intet at læse lige nu. Vælg en bog under Pensum.</p>`;
  if (!timer || timer.bookId !== book.id) timer = { bookId: book.id, elapsed: 0, startedAt: null };
  const start = Planner.nextPage(book);
  return `
    <div class="focus">
      <div class="row">
        <span class="avatar" style="background:var(--surface-2);width:40px;height:40px;font-size:12px">${shortTitle(book.title)}</span>
        <div class="grow"><strong>${escapeHtml(book.title)}</strong>
          <p class="small" style="color:var(--soft)">${item ? `s. ${item.fromPage}-${item.toPage}` : `fra s. ${start}`}</p></div>
        <a href="#/kid/${kid.id}/today" aria-label="Luk" style="color:var(--ink);font-size:24px;text-decoration:none;padding:8px">✕</a>
      </div>
      <div class="stack" style="flex:1;justify-content:center;text-align:center">
        <span class="small" style="font-weight:800;letter-spacing:1px;color:var(--cyan)">FOKUS</span>
        <div class="timer" id="clock">${clockText()}</div>
        <span class="small" style="color:var(--soft)">Telefonen bliver liggende. Du klarer det.</span>
      </div>
      <button class="dark wide" data-action="timer-toggle" style="min-height:56px;font-size:18px">${timer.startedAt ? "Pause" : "Start"}</button>
      <button class="wide" data-action="log-session" data-kid="${kid.id}" data-id="${book.id}" style="min-height:56px;font-size:18px;background:none;border:1.5px solid #fff">Færdig, gem hvor langt jeg nåede</button>
    </div>`;
}

function parentView() {
  const list = kids();
  return `
    <a href="#/" class="muted" style="text-decoration:none">‹ Skift profil</a>
    <h1>Følg med</h1>
    ${list.map((k) => {
      const plan = planFor(k);
      const items = [...doneToday(k), ...plan.today.items];
      const done = items.filter(itemDone).length;
      const risky = plan.plans.filter((p) => p.status === "late");
      return `<div class="card stack">
        <div class="row"><span class="ring">${avatar(k, 46)}</span><strong class="grow" style="font-size:17px">${escapeHtml(k.name)}</strong>${streakBadge(k)}
          <span class="badge ${plan.atRisk ? "own" : ""}">${plan.atRisk ? "Stram plan" : items.length && done === items.length ? "Færdig i dag" : "Følger planen"}</span></div>
        <div class="bar"><span style="width:${items.length ? Math.round((done / items.length) * 100) : 100}%"></span></div>
        <span class="muted small">${done} af ${items.length} i dag · læsefart ca. ${formatPace(plan.pace)}</span>
        ${risky.map((p) => `<span class="small" style="color:var(--amber)">${escapeHtml(Store.get("books", p.bookId).title)}: fristen er nået, ${p.remaining} sider mangler</span>`).join("")}
        ${plan.days.filter((d) => d.tooMuch).slice(0, 1).map((d) => `<span class="small" style="color:var(--amber)">${longDate(d.date)}: ${d.minutes} min læsning, mere end de ${settingsOf(k).maxMinutesPerDay} min I har aftalt</span>`).join("")}
        <div class="row"><a class="button grow" href="#/kid/${k.id}/books">Pensum</a><button class="grow" data-action="edit-kid" data-id="${k.id}">Indstillinger</button></div>
      </div>`;
    }).join("")}
    <button class="ghost wide" data-action="edit-kid">+ Tilføj profil</button>
    <button class="wide" data-action="account">Konto</button>`;
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
  const s = kid ? settingsOf(kid) : settingsOf({});
  const color = kid?.color || COLORS[kids().length % COLORS.length];
  openSheet(`
    <h2>${kid ? "Indstillinger" : "Ny profil"}</h2>
    <form id="kid-form" class="stack">
      <label>Navn<input name="name" required value="${escapeHtml(kid?.name ?? "")}"></label>
      <div class="grid-2">
        <label>Studie/semester<input name="grade" value="${escapeHtml(kid?.grade ?? "")}" placeholder="fx 3. semester"></label>
        <label>Farve<input name="color" type="color" value="${color}"></label>
      </div>
      <div class="grid-3">
        <label>Læsning fra<input name="studyFrom" type="time" value="${s.studyFrom}"></label>
        <label>Fritid fra<input name="freeFrom" type="time" value="${s.freeFrom}"></label>
        <label>Højst min/dag<input name="max" type="number" min="10" max="600" value="${s.maxMinutesPerDay}"></label>
      </div>
      <label class="row" style="flex-direction:row;color:var(--ink);font-size:16px"><input name="weekend" type="checkbox" style="width:auto;min-height:0" ${s.studyDays.includes(6) ? "checked" : ""}> Læsning i weekenden</label>
      <div class="row"><button type="button" class="grow" data-action="close">Annullér</button><button class="primary grow">Gem</button></div>
    </form>`);
  $("#kid-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    await save("kids", {
      id: kid?.id,
      name: f.name.value.trim(),
      grade: f.grade.value.trim() || null,
      color: f.color.value,
      settings: {
        ...(kid?.settings || {}),
        studyFrom: f.studyFrom.value,
        freeFrom: f.freeFrom.value,
        maxMinutesPerDay: Number(f.max.value) || 120,
        studyDays: f.weekend.checked ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5],
      },
    });
    closeSheet();
  });
}

function curriculumSheet(kid) {
  const cur = curriculumOf(kid.id);
  openSheet(`
    <h2>Samlet frist</h2>
    <p class="muted small">Bøger uden egen frist skal være læst til denne dato.</p>
    <form id="cur-form" class="stack">
      <label>Navn<input name="title" required value="${escapeHtml(cur?.title ?? "Pensum")}"></label>
      <label>Frist<input name="deadline" type="date" value="${cur?.deadline ?? ""}"></label>
      <div class="row"><button type="button" class="grow" data-action="close">Annullér</button><button class="primary grow">Gem</button></div>
    </form>`);
  $("#cur-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    await save("curricula", { id: cur?.id, kid_id: kid.id, title: f.title.value.trim(), deadline: f.deadline.value || null });
    closeSheet();
  });
}

async function ensureCurriculum(kidId) {
  return curriculumOf(kidId) ?? save("curricula", { kid_id: kidId, title: "Pensum", deadline: null });
}

function bookSheet(kid, book) {
  const cur = curriculumOf(kid.id);
  openSheet(`
    <h2>${book ? "Ret bog" : "Tilføj bog eller tekst"}</h2>
    <form id="book-form" class="stack">
      <label>Titel<input name="title" required value="${escapeHtml(book?.title ?? "")}"></label>
      <div class="grid-3">
        <label>Fag<input name="subject" value="${escapeHtml(book?.subject ?? "")}"></label>
        <label>Fra side<input name="from" type="number" inputmode="numeric" min="0" required value="${book?.from_page ?? 1}"></label>
        <label>Til side<input name="to" type="number" inputmode="numeric" min="1" required value="${book?.to_page ?? ""}"></label>
      </div>
      <label>Egen frist (tom = samlet frist${cur?.deadline ? ", " + shortDate(cur.deadline) : ""})<input name="deadline" type="date" value="${book?.deadline ?? ""}"></label>
      ${book ? `<label>Læst til side<input name="current" type="number" inputmode="numeric" value="${book.current_page ?? ""}"></label>` : ""}
      <p id="book-preview" class="notice small"></p>
      <div class="row">
        ${book ? '<button type="button" class="grow" data-action="delete-book">Slet</button>' : '<button type="button" class="grow" data-action="close">Annullér</button>'}
        <button class="primary grow">Gem</button>
      </div>
    </form>`);
  const form = $("#book-form");
  const draft = () => {
    const f = form.elements;
    return {
      ...book,
      id: book?.id ?? "ny",
      kid_id: kid.id,
      curriculum_id: book?.curriculum_id ?? cur?.id ?? null,
      title: f.title.value.trim(),
      subject: f.subject.value.trim() || null,
      from_page: Number(f.from.value),
      to_page: Number(f.to.value),
      deadline: f.deadline.value || null,
      current_page: f.current ? (f.current.value === "" ? null : Number(f.current.value)) : book?.current_page ?? null,
    };
  };
  // Vis med det samme, hvad bogen betyder pr. dag med barnets læsefart.
  const preview = () => {
    const b = draft();
    const el = $("#book-preview");
    if (!(b.to_page >= b.from_page)) return (el.textContent = "Skriv første og sidste side.");
    const p = Planner.pace(Store.all("sessions", (s) => s.kid_id === kid.id));
    const plan = Planner.planBook(b, { curriculum: cur, minPerPage: p.minPerPage, today: today(), studyDays: settingsOf(kid).studyDays });
    if (plan.status === "no-deadline") return (el.textContent = `${plan.remaining} sider er ca. ${formatMinutes(plan.totalMinutes)}. Sæt en frist for at få en plan.`);
    if (plan.status === "done") return (el.textContent = "Bogen er læst færdig.");
    if (plan.status === "late") return (el.textContent = "Fristen er allerede nået.");
    el.textContent = `${plan.remaining} sider med ${formatPace(p)} er ca. ${formatMinutes(plan.totalMinutes)}. Det bliver ca. ${Math.round(plan.totalMinutes / plan.days.length)} min om dagen på ${plan.days.length} læsedage.`;
  };
  form.addEventListener("input", preview);
  preview();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = draft();
    if (b.to_page < b.from_page) return alert("Sidste side skal være efter første side.");
    if (!b.curriculum_id) b.curriculum_id = (await ensureCurriculum(kid.id)).id;
    if (b.id === "ny") delete b.id;
    await save("books", b);
    closeSheet();
  });
  form.addEventListener("click", async (e) => {
    if (e.target.dataset.action !== "delete-book") return;
    if (!confirm(`Slet "${book.title}"?`)) return;
    await Store.remove("books", book.id);
    sync();
    closeSheet();
  });
}

// Efter læsning: hvilken side nåede du til, og hvor længe læste du?
function logSheet(kid, book) {
  const start = Planner.nextPage(book);
  const item = planFor(kid).today.items.find((i) => i.bookId === book.id);
  let reached = Math.min(book.to_page, item?.toPage ?? start + 9);
  let minutes = Math.max(1, Math.round(currentElapsed() / 60000)) || item?.minutes || 15;
  const before = Planner.pace(Store.all("sessions", (s) => s.kid_id === kid.id));

  openSheet(`
    <h2>Nice! Hvor langt nåede du?</h2>
    <p class="muted small">${escapeHtml(book.title)} · startede på s. ${start}</p>
    <div class="card stack">
      <div class="row"><strong class="grow">Jeg nåede til side</strong>
        <div class="stepper"><button type="button" data-step="-1" aria-label="En side færre">−</button><output id="reached"></output><button type="button" data-step="1" aria-label="En side mere">+</button></div></div>
      <label>Jeg læste i (minutter)<input id="minutes" type="number" inputmode="numeric" min="1" max="300"></label>
    </div>
    <div id="log-result"></div>
    <div class="row"><button type="button" class="grow" data-action="close">Annullér</button><button class="primary grow" id="log-save">Gem</button></div>`);

  const show = () => {
    $("#reached").textContent = reached;
    $("#minutes").value = minutes;
    const pages = reached - start + 1;
    const session = { kid_id: kid.id, book_id: book.id, start_page: start, end_page: reached, minutes, studied_at: new Date().toISOString() };
    const after = Planner.pace([...Store.all("sessions", (s) => s.kid_id === kid.id), session]);
    const plan = Planner.planBook({ ...book, current_page: reached }, {
      curriculum: Store.get("curricula", book.curriculum_id), minPerPage: after.minPerPage,
      today: today(), studyDays: settingsOf(kid).studyDays, readToday: true,
    });
    const perDay = plan.days.length ? Math.round(plan.totalMinutes / plan.days.length) : plan.totalMinutes;
    const tight = plan.status === "late" || perDay > settingsOf(kid).maxMinutesPerDay;
    $("#log-result").innerHTML = pages < 1 ? '<p class="notice">Vælg den side, du nåede til.</p>' : `
      <div class="card stack">
        <span class="section-label">Din læsefart</span>
        <span>I dag: <strong>${pages} sider på ${minutes} min</strong>, ca. ${formatNum(minutes / pages)} min pr. side.</span>
        <span>Ny gennemsnitsfart: <strong>${formatPace(after)}</strong>${before.measured ? ` (før ${formatPace(before)})` : ""}.</span>
      </div>
      <div class="${tight ? "warn-box" : "ok-box"} stack" style="margin-top:10px">
        ${plan.status === "done" ? "<strong>Bogen er læst færdig!</strong>"
          : plan.status === "no-deadline" ? `Der mangler ${plan.remaining} sider. Sæt en frist for at få en plan.`
          : `<span>Resten (s. ${reached + 1}-${book.to_page}) bliver <strong>ca. ${perDay} min om dagen</strong>${plan.days.length ? ` i ${plan.days.length} læsedage` : ""}.</span>
             <span>${tight ? "Det bliver stramt. Start tidligere på dagen, eller flyt noget fra en anden bog." : "Du når det stadig til fristen, og fritiden er ikke rørt."}</span>`}
      </div>`;
  };
  show();
  $("#sheet-body").addEventListener("click", (e) => {
    const step = Number(e.target.dataset.step);
    if (step) {
      reached = Math.max(start - 1, Math.min(book.to_page, reached + step));
      show();
    }
  });
  $("#minutes").addEventListener("change", (e) => {
    minutes = Math.max(1, Number(e.target.value) || 1);
    show();
  });
  $("#log-save").addEventListener("click", async () => {
    if (reached < start) return closeSheet();
    await Store.put("sessions", { kid_id: kid.id, book_id: book.id, start_page: start, end_page: reached, minutes, studied_at: new Date().toISOString() });
    await Store.put("books", { id: book.id, current_page: reached });
    sync();
    timer = null;
    $("#sheet").close();
    go(`#/kid/${kid.id}/today`);
    render();
  });
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
// Klik
// ============================================================

$("#app").addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;
  const kid = el.dataset.kid && Store.get("kids", el.dataset.kid);
  if (action === "edit-kid") kidSheet(id && Store.get("kids", id));
  else if (action === "edit-curriculum") curriculumSheet(kid);
  else if (action === "edit-book") bookSheet(kid, id && Store.get("books", id));
  else if (action === "log-session") logSheet(kid, Store.get("books", id));
  else if (action === "account") accountSheet();
  else if (action === "timer-toggle") {
    if (timer.startedAt) {
      timer.elapsed += Date.now() - timer.startedAt;
      timer.startedAt = null;
    } else timer.startedAt = Date.now();
    el.textContent = timer.startedAt ? "Pause" : "Start";
  }
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
  sync();
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

function deadlineText(iso) {
  return iso ? `læses senest ${shortDate(iso)}` : "ingen frist";
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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
