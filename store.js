// Studieplan – offline database.
// Alle data ligger i IndexedDB på enheden, så appen virker helt uden net.
// Ændringer lægges i en udbakke og sendes til Supabase, når der er forbindelse.
// Ændringer fra andre enheder hentes ned (kun det der er ændret siden sidst).
//
// Regler:
// - Hver række har id (uuid), updated_at og deleted. Sletning er "blød"
//   (deleted = true), så den også når frem til de andre enheder.
// - Ved konflikt vinder den lokale ændring, indtil den er sendt op.
//   Derefter vinder den seneste ændring på serveren.

(function (root) {
  const DB_NAME = "studieplan";
  const DB_VERSION = 1;
  const TABLES = ["kids", "curricula", "books", "sessions"];
  const PAGE = 500;
  const OVERLAP_MS = 60_000;

  let idb = null;
  const data = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
  let outbox = new Map();   // "tabel:id" -> revision
  let meta = {};            // owner, pull-markører pr. tabel
  let rev = Date.now();
  const listeners = new Set();

  // ---------- IndexedDB ----------

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const t of TABLES) if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: "id" });
        if (!d.objectStoreNames.contains("outbox")) d.createObjectStore("outbox", { keyPath: "key" });
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = idb.transaction(stores, mode);
      const result = fn(t);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  function getAll(store) {
    return new Promise((resolve, reject) => {
      const req = idb.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function open() {
    idb = await openDb();
    for (const t of TABLES) {
      data[t].clear();
      for (const row of await getAll(t)) data[t].set(row.id, row);
    }
    outbox = new Map((await getAll("outbox")).map((o) => [o.key, o.rev]));
    meta = Object.fromEntries((await getAll("meta")).map((m) => [m.key, m.value]));
  }

  function setMeta(key, value) {
    meta[key] = value;
    return tx(["meta"], "readwrite", (t) => t.objectStore("meta").put({ key, value }));
  }

  // Data fra en anden bruger må aldrig blandes ind.
  async function useOwner(userId) {
    if (meta.owner && meta.owner !== userId) await clear();
    await setMeta("owner", userId);
  }

  async function clear() {
    await tx([...TABLES, "outbox", "meta"], "readwrite", (t) => {
      for (const s of [...TABLES, "outbox", "meta"]) t.objectStore(s).clear();
    });
    for (const t of TABLES) data[t].clear();
    outbox.clear();
    meta = {};
    emit();
  }

  // ---------- Læs og skriv ----------

  function all(table, filter) {
    const rows = [...data[table].values()].filter((r) => !r.deleted);
    return filter ? rows.filter(filter) : rows;
  }

  function get(table, id) {
    const r = data[table].get(id);
    return r && !r.deleted ? r : null;
  }

  async function put(table, row) {
    const full = { ...data[table].get(row.id), ...row, id: row.id || crypto.randomUUID(), updated_at: new Date().toISOString() };
    full.deleted ??= false;
    data[table].set(full.id, full);
    const key = `${table}:${full.id}`;
    outbox.set(key, ++rev);
    await tx([table, "outbox"], "readwrite", (t) => {
      t.objectStore(table).put(full);
      t.objectStore("outbox").put({ key, table, id: full.id, rev });
    });
    emit();
    return full;
  }

  function remove(table, id) {
    return put(table, { id, deleted: true });
  }

  function pendingCount() {
    return outbox.size;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function emit() {
    for (const fn of listeners) fn();
  }

  // ---------- Synkronisering ----------

  let syncing = false;
  let syncAgain = false;

  // Kun én synkronisering ad gangen. Kommer der et kald undervejs, køres en runde til bagefter.
  async function sync(db) {
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    try {
      do {
        syncAgain = false;
        await push(db);
        await pull(db);
      } while (syncAgain);
    } finally {
      syncing = false;
    }
  }

  async function push(db) {
    const sent = new Map(outbox);
    for (const table of TABLES) {
      const rows = [...sent.keys()]
        .filter((k) => k.startsWith(table + ":"))
        .map((k) => data[table].get(k.slice(table.length + 1)))
        .filter(Boolean)
        .map(({ updated_at, ...row }) => row); // serveren sætter selv updated_at
      if (!rows.length) continue;
      // defaultToNull: false, så nye rækker får user_id m.m. fra databasens standardværdier.
      const { error } = await db.from(table).upsert(rows, { defaultToNull: false });
      if (error) throw error;
    }
    // Fjern kun det der ikke er ændret igen, mens vi sendte.
    const done = [...sent].filter(([k, r]) => outbox.get(k) === r).map(([k]) => k);
    for (const k of done) outbox.delete(k);
    if (done.length) await tx(["outbox"], "readwrite", (t) => done.forEach((k) => t.objectStore("outbox").delete(k)));
  }

  async function pull(db) {
    let changed = false;
    for (const table of TABLES) {
      const cursorKey = "pulled:" + table;
      // Første side starter lidt før sidste markør, så en ændring der blev gemt
      // på serveren samtidig med sidste hentning ikke bliver overset.
      let from = meta[cursorKey] ? new Date(Date.parse(meta[cursorKey]) - OVERLAP_MS).toISOString() : null;
      for (;;) {
        let q = db.from(table).select("*").order("updated_at").limit(PAGE);
        if (from) q = q.gt("updated_at", from);
        const { data: rows, error } = await q;
        if (error) throw error;
        if (!rows.length) break;
        const fresh = rows.filter((r) => !outbox.has(`${table}:${r.id}`));
        for (const r of fresh) data[table].set(r.id, r);
        await tx([table], "readwrite", (t) => fresh.forEach((r) => t.objectStore(table).put(r)));
        from = rows.at(-1).updated_at;
        await setMeta(cursorKey, from);
        changed ||= fresh.length > 0;
        if (rows.length < PAGE) break;
      }
    }
    if (changed) emit();
  }

  const api = { TABLES, open, useOwner, clear, all, get, put, remove, pendingCount, onChange, sync };
  root.Store = api;
})(window);
