// SBN Payroll tracker: everyone's pay, across every location, in one place. Owner-only and READ-ONLY: it never changes anything at a location.
// It has nothing to do with the rep tracker (separate site, separate password), so the sales team never sees any of this.
const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" });
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { setHeaders: (res, f) => { if (/\.(js|html|css)$/.test(f)) res.setHeader("Cache-Control", "no-cache"); } }));

const PORT = process.env.PORT || 3500;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const BUILD = "2026-11-10-payroll-39";

// ---------- storage ----------
const newId = () => crypto.randomBytes(8).toString("hex");
function loadDB() {
  let db;
  if (!fs.existsSync(DATA_FILE)) db = {};
  else db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!db.locations) db.locations = [];
  if (!db.sessionSecret) { db.sessionSecret = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  if (db.password === undefined) db.password = null;
  if (!db.sessionsValidAfter) db.sessionsValidAfter = 0;
  return db;
}
const saveDB = (db) => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

// ---------- the one password (salted, slow hash) and signed, expiring sessions ----------
const SESSION_DAYS = 30;
function hashPassword(pw, salt) { salt = salt || crypto.randomBytes(16).toString("hex"); return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString("hex") }; }
function passwordOk(pw, rec) { if (!rec) return false; const a = Buffer.from(hashPassword(pw, rec.salt).hash, "hex"), b = Buffer.from(rec.hash, "hex"); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function signSession(db) {
  const payload = Buffer.from(JSON.stringify({ ts: Date.now() })).toString("base64");
  return payload + "." + crypto.createHmac("sha256", db.sessionSecret).update(payload).digest("hex");
}
function verifySession(db, token) {
  if (!token || typeof token !== "string") return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const want = crypto.createHmac("sha256", db.sessionSecret).update(payload).digest("hex");
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  let ts; try { ts = JSON.parse(Buffer.from(payload, "base64").toString("utf8")).ts; } catch (e) { return false; }
  return ts >= db.sessionsValidAfter && Date.now() - ts < SESSION_DAYS * 86400000;
}
function setSessionCookie(req, res, db) { res.cookie("session", signSession(db), { httpOnly: true, sameSite: "strict", secure: req.secure || req.get("x-forwarded-proto") === "https", maxAge: SESSION_DAYS * 86400000 }); }
function requireOwner(req, res, next) { if (!verifySession(loadDB(), req.cookies.session)) return res.status(401).json({ error: "Not logged in." }); next(); }

// too many wrong passwords from one place: wait
const tries = new Map(), MAX_TRIES = 8, WINDOW_MS = 15 * 60 * 1000;
const tooMany = (ip) => { const t = (tries.get(ip) || []).filter((x) => Date.now() - x < WINDOW_MS); tries.set(ip, t); return t.length >= MAX_TRIES; };
const noteFail = (ip) => { const t = tries.get(ip) || []; t.push(Date.now()); tries.set(ip, t); };

app.get("/api/session", (req, res) => { const db = loadDB(); res.json({ loggedIn: verifySession(db, req.cookies.session), needsSetup: !db.password, build: BUILD }); });
app.post("/api/setup/owner-password", (req, res) => {
  const db = loadDB();
  if (db.password) return res.status(400).json({ error: "Already set up." });
  const { password } = req.body || {};
  if (!password || String(password).length < 8) return res.status(400).json({ error: "Use at least 8 characters." });
  db.password = hashPassword(password); saveDB(db); setSessionCookie(req, res, db); res.json({ ok: true });
});
app.post("/api/login", (req, res) => {
  const db = loadDB(), ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: "Too many wrong tries. Wait 15 minutes and try again." });
  if (!passwordOk((req.body || {}).password, db.password)) { noteFail(ip); return res.status(401).json({ error: "Wrong password." }); }
  tries.delete(ip); setSessionCookie(req, res, db); res.json({ ok: true });
});
app.post("/api/logout", (req, res) => { res.clearCookie("session"); res.json({ ok: true }); });
app.post("/api/password", requireOwner, (req, res) => {
  const db = loadDB(), { current, next } = req.body || {};
  if (!passwordOk(current, db.password)) return res.status(401).json({ error: "Your current password isn't right." });
  if (!next || String(next).length < 8) return res.status(400).json({ error: "Use at least 8 characters." });
  db.password = hashPassword(next); db.sessionsValidAfter = Date.now(); saveDB(db);           // signs every other device out
  setSessionCookie(req, res, db); res.json({ ok: true });
});

// ---------- the locations this reads from ----------
// only ever hint at a long secret; a short one is hidden completely
const mask = (s) => (String(s).length >= 12 ? "••••" + String(s).slice(-4) : "••••••••");
app.get("/api/locations", requireOwner, (req, res) => res.json(loadDB().locations.map((l) => ({ id: l.id, name: l.name, url: l.url, secretHint: mask(l.secret) }))));
const nameTaken = (db, name, exceptId) => db.locations.some((l) => l.id !== exceptId && l.name.trim().toLowerCase() === String(name).trim().toLowerCase());
app.post("/api/locations", requireOwner, (req, res) => {
  const db = loadDB(), { name, url, secret } = req.body || {};
  if (!name || !url || !secret) return res.status(400).json({ error: "Name, address and secret are all required." });
  if (nameTaken(db, name)) return res.status(400).json({ error: "A location with that name already exists." });
  let u; try { u = new URL(String(url).trim()); } catch (e) { return res.status(400).json({ error: "That address isn't a web address." }); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: "The address must start with https://" });
  const twin = db.locations.find((l) => String(l.url).toLowerCase() === u.origin.toLowerCase());
  if (twin) return res.status(400).json({ error: `That tracker is already added as "${twin.name}". Adding it twice would count its pay twice.` });
  db.locations.push({ id: newId(), name: String(name).trim(), url: u.origin, secret: String(secret).trim() }); saveDB(db); res.json({ ok: true });
});
// The order of the list is the order locations appear on the Payroll screen (Jersey, Philly, Sunrise, and any you add later go to the end).
app.post("/api/locations/:id/move", requireOwner, (req, res) => {
  const db = loadDB(), i = db.locations.findIndex((l) => l.id === req.params.id), dir = (req.body || {}).direction === "up" ? -1 : (req.body || {}).direction === "down" ? 1 : 0;
  if (i < 0) return res.status(404).json({ error: "No such location." });
  if (!dir) return res.status(400).json({ error: "Say up or down." });
  const k = i + dir;
  if (k >= 0 && k < db.locations.length) { const t = db.locations[i]; db.locations[i] = db.locations[k]; db.locations[k] = t; saveDB(db); }
  res.json({ ok: true });
});
app.patch("/api/locations/:id", requireOwner, (req, res) => {
  const db = loadDB(), loc = db.locations.find((l) => l.id === req.params.id), name = String((req.body || {}).name || "").trim();
  if (!loc) return res.status(404).json({ error: "No such location." });
  if (!name || name.length > 60) return res.status(400).json({ error: "Give it a name of up to 60 characters." });
  if (nameTaken(db, name, loc.id)) return res.status(400).json({ error: "A location with that name already exists." });
  loc.name = name; saveDB(db); res.json({ ok: true });
});
app.delete("/api/locations/:id", requireOwner, (req, res) => { const db = loadDB(); db.locations = db.locations.filter((l) => l.id !== req.params.id); saveDB(db); res.json({ ok: true }); });

// The secret travels in a header (kept out of server logs). Not JSON and either "not found" or a normal page = an older tracker that needs the update.
async function callLocation(loc, pathAndQuery) {
  const r = await fetch(loc.url + pathAndQuery, { headers: { "X-Cross-Secret": loc.secret }, signal: AbortSignal.timeout(12000) });
  let data = null; try { data = await r.json(); } catch (e) { /* not json */ }
  return { status: r.status, ok: r.ok, data, notOurApi: data === null && (r.status === 404 || r.ok) };
}
// Which release each shop is running. Every shop release is listed here, oldest to newest (add each new one when a new shop zip is made), so the screen can say plainly
// which shops are behind. "old" = no Re-run payroll yet; "behind" = has it but not the newest fixes; "latest" = up to date.
const SHOP_BUILDS = ["2026-10-26-payroll", "2026-10-26-calendars", "2026-10-26-calendars2", "2026-10-27-rerun", "2026-10-27-showroom", "2026-10-28-upsells", "2026-10-28-upsells2", "2026-10-28-payperiods", "2026-10-28-rerunaccess", "2026-10-29-cash", "2026-10-29-cash2", "2026-10-29-ghlmirror", "2026-10-29-ghlauto", "2026-10-30-redos", "2026-10-30-va", "2026-10-30-va2", "2026-10-30-closers", "2026-10-30-dupes", "2026-10-30-dupes2", "2026-10-30-dupes3", "2026-10-30-initials", "2026-10-30-initials2", "2026-10-30-redocal", "2026-10-30-privacy", "2026-10-30-privacy3", "2026-10-31-revenue", "2026-10-31-extracars", "2026-11-01-statsexport", "2026-11-02-hooklog", "2026-11-02-addrep", "2026-11-03-ghlalign", "2026-11-04-sameday", "2026-11-05-attendance", "2026-11-05-titleprice", "2026-11-08-recover", "2026-11-08-sundaywarn", "2026-11-09-paydetail", "2026-11-09-halfday", "2026-11-09-runall", "2026-11-10-breakdown", "2026-11-10-allcars", "2026-11-10-upsellguard"];
const LATEST_SHOP = SHOP_BUILDS[SHOP_BUILDS.length - 1], RERUN_FROM = "2026-10-27-rerun";
function buildState(build) {
  if (!build) return "unknown";
  const i = SHOP_BUILDS.indexOf(build), r = SHOP_BUILDS.indexOf(RERUN_FROM);
  if (i >= 0) return i === SHOP_BUILDS.length - 1 ? "latest" : i >= r ? "behind" : "old";
  const d = String(build).slice(0, 10);                       // a label not in the list: judge by its date
  return d >= LATEST_SHOP.slice(0, 10) ? "latest" : d >= RERUN_FROM.slice(0, 10) ? "behind" : "old";
}
async function getBuild(loc) {
  try { const r = await fetch(loc.url + "/api/version", { signal: AbortSignal.timeout(6000) }); const d = await r.json(); return typeof d.build === "string" ? d.build : null; } catch (e) { return null; }
}
async function askAll(db, pathAndQuery) {
  return Promise.all(db.locations.map(async (loc) => {
    const base = { locationId: loc.id, locationName: loc.name, locationUrl: loc.url };
    const build = await getBuild(loc); base.locationBuild = build;
    try {
      const r = await callLocation(loc, pathAndQuery);
      if (r.notOurApi) return { ...base, needsUpdate: true };
      if (r.status === 401) return { ...base, error: "The secret for this location was refused. Check it in Locations." };
      if (!r.ok) return { ...base, error: (r.data && r.data.error) || `HTTP ${r.status}` };
      return { ...base, data: r.data };
    } catch (e) { return { ...base, error: e.name === "TimeoutError" ? "No answer after 12 seconds." : (e.message || "Unreachable") }; }
  }));
}
const personKey = (n) => String(n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (arr, f) => cents(arr.reduce((t, x) => t + (Number(x[f]) || 0), 0));
const nice = (n) => String(n).replace(/\s+/g, " ").trim();
const statusOf = (l) => ({ locationId: l.locationId, locationName: l.locationName, url: l.locationUrl || null, build: l.locationBuild || null, buildState: buildState(l.locationBuild), ok: !!l.data, needsUpdate: !!l.needsUpdate, error: l.error || null, state: l.data ? l.data.state || null : null, runClosedAt: l.data ? l.data.runClosedAt || null : null, warnings: l.data && Array.isArray(l.data.warnings) ? l.data.warnings : [] });

// ---------- techs and managers: each location's own Payroll numbers, added up by name ----------
async function peoplePay(periodId) {
  const db = loadDB();
  const locs = await askAll(db, `/api/cross-location/people-pay?list=1${periodId ? `&periodId=${encodeURIComponent(periodId)}` : ""}`);
  const good = locs.filter((l) => l.data), first = good.length ? good[0].data : null, by = new Map();
  good.forEach((l) => (l.data.people || []).forEach((p) => {
    const k = personKey(p.name); if (!k) return;
    if (!by.has(k)) by.set(k, { key: k, name: nice(p.name), locations: [] });
    const rec = by.get(k); if (nice(p.name).length > rec.name.length) rec.name = nice(p.name);
    rec.locations.push({ locationId: l.locationId, locationName: l.locationName, state: l.data.state, ...p });
  }));
  const people = [...by.values()].map((p) => ({ ...p, locationCount: p.locations.length, combined: { base: sum(p.locations, "base"), upsellCommission: sum(p.locations, "upsellCommission"), walkInCommission: sum(p.locations, "walkInCommission"), tips: sum(p.locations, "tips"), subtotal: sum(p.locations, "subtotal"), adjustments: sum(p.locations, "adjustments"), total: sum(p.locations, "total") } }));
  // Bonuses are typed in here (not in the shops): they belong to a person and a pay period, and become part of that person's one combined check.
  const period0 = first ? first.period : null, bonusRows = period0 ? (db.bonuses || []).filter((b) => b.periodId === period0.id).map((b) => ({ id: b.id, personKey: b.personKey, personName: b.personName, amount: b.amount, reason: b.reason, note: b.note || "", matched: false })) : [];
  people.forEach((p) => { const mine = bonusRows.filter((b) => b.personKey === p.key); mine.forEach((b) => { b.matched = true; }); p.bonuses = mine; p.bonus = cents(mine.reduce((t, b) => t + b.amount, 0)); p.combined.bonus = p.bonus; p.combined.total = cents(p.combined.total + p.bonus); });
  const bonusTotal = cents(bonusRows.reduce((t, b) => t + b.amount, 0)), unmatchedTotal = cents(bonusRows.filter((b) => !b.matched).reduce((t, b) => t + b.amount, 0));
  people.sort((a, b) => b.locationCount - a.locationCount || b.combined.total - a.combined.total || a.name.localeCompare(b.name));
  const roleOrder = { manager: 0, tech: 1 };
  const byLocation = locs.map((l) => { const list = l.data ? (l.data.people || []).slice().sort((a, b) => (roleOrder[a.role] ?? 2) - (roleOrder[b.role] ?? 2) || a.name.localeCompare(b.name)).map((p) => ({ ...p, name: nice(p.name) })) : [];
    return { ...statusOf(l), people: list, totals: { base: sum(list, "base"), upsellCommission: sum(list, "upsellCommission"), walkInCommission: sum(list, "walkInCommission"), tips: sum(list, "tips"), adjustments: sum(list, "adjustments"), total: sum(list, "total") } }; });
  // Notices (the "Check before you pay" list) are for the LAST pay period and the one in progress, and nothing older: a correction on an October payroll, or the checks of an old period you happen to open, are not today's problem.
  // They are not thrown away: they are handed over separately as hiddenWarnings, so the screen can keep them one tap away and an underpayment can never be lost for good.
  const cur = first && first.containingIndex >= 0 ? first.periods[first.containingIndex] : null, prev = first && first.containingIndex > 0 ? first.periods[first.containingIndex - 1] : null;
  const noticesFrom = (prev || cur || {}).start || null, viewingOld = !!(noticesFrom && first && first.period && first.period.end < noticesFrom);
  const windowed = (e) => { if (!noticesFrom) return { ...e, hiddenWarnings: [] }; const shown = [], hidden = []; (e.warnings || []).forEach((w) => ((viewingOld || (w.code === "corrections" && w.periodEnd && w.periodEnd < noticesFrom)) ? hidden : shown).push(w)); return { ...e, warnings: shown, hiddenWarnings: hidden }; };
  return { latestShopBuild: LATEST_SHOP, noticesFrom, viewingOld, byLocation: byLocation.map(windowed), period: first ? first.period : null, periods: first ? first.periods : [], containingIndex: first ? first.containingIndex : -1, locations: locs.map(statusOf).map(windowed), people, grandTotal: cents(people.reduce((t, p) => t + p.combined.total, 0) + unmatchedTotal), bonuses: bonusRows, bonusTotal, bonusReasons: BONUS_REASONS };
}
app.get("/api/pay/people", requireOwner, async (req, res) => res.json(await peoplePay(String(req.query.periodId || ""))));

// ---------- Run payroll for every shop ----------
// Running payroll records everyone's pay for a finished period at each shop. This does it for all the shops in one go, through each shop's own "Run payroll" (the same function the shop's button uses), and only after a review:
//  - every shop is asked what it would run (people, total, notices, waiting adjustments, and a fingerprint of all of it);
//  - nothing runs if any shop can't be reached, is out of date, isn't past the end of the period, or is waiting on an earlier period; a shop that already ran it is simply left alone;
//  - you must type RUN, and the run is refused if anything at any shop changed after you reviewed it;
//  - each shop's result is reported on its own, and the attempt is written to a log here.
// Bonuses live only in this tracker, so they are NOT part of a shop's run: the review says so.
async function postLocation(loc, pathAndQuery, body) {
  const r = await fetch(loc.url + pathAndQuery, { method: "POST", headers: { "X-Cross-Secret": loc.secret, "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(60000) });
  let data = null; try { data = await r.json(); } catch (e) { /* not json */ }
  return { status: r.status, ok: r.ok, data };
}
async function runReview(periodId) {
  const db = loadDB(), locs = await askAll(db, `/api/cross-location/payroll-run-preview?periodId=${encodeURIComponent(periodId)}`);
  const shops = locs.map((l) => {
    const base = { locationId: l.locationId, locationName: l.locationName };
    if (l.needsUpdate) return { ...base, status: "needs_update", reason: `${l.locationName} needs the latest shop update before it can run payroll from here.` };
    if (!l.data) return { ...base, status: "unreachable", reason: `Couldn't reach ${l.locationName} (${l.error || "no answer"}).` };
    const d = l.data, common = { ...base, people: d.people, total: d.total, warnings: d.warnings || [], pendingAdjustments: d.pendingAdjustments || { count: 0, amount: 0 }, carry: d.carry || { count: 0, amount: 0, from: null, items: [] }, older: d.older || 0, overpaid: d.overpaid || { count: 0, items: [] }, fingerprint: d.fingerprint, period: d.period };
    if (d.state === "run") return { ...common, status: "already_run", reason: `Already run${d.run && d.run.closedAt ? " on " + d.run.closedAt.slice(0, 10) : ""}. Left alone.`, run: d.run };
    if (d.state === "skipped") return { ...common, status: "skipped", reason: "This period was marked as paid another way. Left alone." };
    if (!d.over) return { ...common, status: "not_over", reason: `${l.locationName}: this pay period isn't over yet. It ends ${d.period.end}.` };
    if (d.blockedBy) return { ...common, status: "blocked", reason: `${l.locationName}: run ${d.blockedBy.name} first. Pay periods are run in order.` };
    if (!d.runnable) return { ...common, status: "not_runnable", reason: `${l.locationName} can't run this period.` };
    return { ...common, status: "ready", reason: "" };
  });
  const stop = shops.filter((x) => ["needs_update", "unreachable", "not_over", "blocked", "not_runnable"].includes(x.status)), ready = shops.filter((x) => x.status === "ready");
  const bonuses = (db.bonuses || []).filter((b) => b.periodId === periodId), period = (shops.find((x) => x.period) || {}).period || null;
  const fingerprint = require("crypto").createHash("sha1").update(JSON.stringify(shops.map((x) => [x.locationId, x.status, x.fingerprint || null]))).digest("hex");
  return { period, shops, canRun: !stop.length && ready.length > 0, blockers: stop.map((x) => x.reason), readyCount: ready.length, bonus: { count: bonuses.length, total: cents(bonuses.reduce((t, b) => t + b.amount, 0)) }, fingerprint };
}
app.get("/api/pay/run-review", requireOwner, async (req, res) => { const id = String(req.query.periodId || ""); if (!id) return res.status(400).json({ error: "Pick a pay period." }); res.set("Cache-Control", "no-store"); res.json(await runReview(id)); });
const runLocks = new Set();
app.post("/api/pay/run", requireOwner, async (req, res) => {
  const b = req.body || {}, periodId = String(b.periodId || "");
  if (b.confirm !== "RUN") return res.status(400).json({ error: "Type RUN to confirm." });
  if (!periodId) return res.status(400).json({ error: "Pick a pay period." });
  if (runLocks.has(periodId)) return res.status(409).json({ error: "A run for this pay period is already in progress." });
  runLocks.add(periodId);
  try {
    const review = await runReview(periodId);
    if (!review.canRun) return res.status(409).json({ error: "Nothing was run. " + (review.blockers[0] || "There is nothing ready to run."), blockers: review.blockers });
    if (!b.fingerprint || b.fingerprint !== review.fingerprint) return res.status(409).json({ changed: true, error: "Something changed since you reviewed this (a person's pay, a notice, or a shop's status). Nothing was run. Review it again." });
    // Corrections to the last pay period are added ONLY if you approved them: b.approve is { shopId: [item ids shown in the review] }. An id that was not in the review is refused, and nothing is run.
    const approve = b.approve && typeof b.approve === "object" ? b.approve : {};
    for (const [shopId, ids] of Object.entries(approve)) { const sh = review.shops.find((x) => x.locationId === shopId); if (!sh || !Array.isArray(ids) || ids.some((id) => !((sh.carry && sh.carry.items) || []).some((i) => i.id === String(id)))) return res.status(409).json({ changed: true, error: "A correction you approved isn't in what was reviewed. Nothing was run. Review it again." }); }
    const db = loadDB(), results = [];
    for (const shop of review.shops.filter((x) => x.status === "ready")) {
      const loc = db.locations.find((l) => l.id === shop.locationId), ids = (Array.isArray(approve[shop.locationId]) ? approve[shop.locationId] : []).map(String);
      try {
        const r = await postLocation(loc, "/api/cross-location/payroll-run", { periodId, fingerprint: shop.fingerprint, approvedCarry: ids });
        if (r.ok && r.data && r.data.ok) results.push({ locationId: shop.locationId, locationName: shop.locationName, ok: true, people: r.data.people, total: r.data.total, closedAt: r.data.closedAt, ranWithWarnings: r.data.ranWithWarnings || [], carried: r.data.carried || [] });
        else results.push({ locationId: shop.locationId, locationName: shop.locationName, ok: false, changed: !!(r.data && r.data.changed), error: (r.data && r.data.error) || `The shop answered ${r.status}.` });
      } catch (e) { results.push({ locationId: shop.locationId, locationName: shop.locationName, ok: false, error: e.name === "TimeoutError" ? "No answer from the shop. Check it before running again: it may or may not have run." : (e.message || "Couldn't reach the shop.") }); }
    }
    const fresh = loadDB(); fresh.runLog = fresh.runLog || [];
    fresh.runLog.unshift({ id: newId(), at: new Date().toISOString(), periodId, period: review.period ? review.period.name : null, approvedCorrections: Object.values(approve).reduce((t, a) => t + (Array.isArray(a) ? a.length : 0), 0), results }); fresh.runLog = fresh.runLog.slice(0, 200); saveDB(fresh);
    res.json({ ok: results.every((r) => r.ok), results, skipped: review.shops.filter((x) => x.status !== "ready").map((x) => ({ locationName: x.locationName, status: x.status, reason: x.reason })), bonus: review.bonus });
  } finally { runLocks.delete(periodId); }
});

const BONUS_REASONS = ["Hit a goal", "Top performer", "Holiday", "Other"];
// Add or take away a bonus. It is the owner's own list in this tracker; nothing is sent to the shops.
app.post("/api/pay/bonus", requireOwner, async (req, res) => {
  const b = req.body || {}, amount = Math.round(Number(b.amount) * 100) / 100, note = String(b.note || "").trim();
  if (!isFinite(amount) || amount <= 0 || amount > 100000) return res.status(400).json({ error: "Enter a bonus amount above zero." });
  if (!BONUS_REASONS.includes(b.reason)) return res.status(400).json({ error: "Pick a reason." });
  if (note.length > 200) return res.status(400).json({ error: "Keep the note under 200 characters." });
  if (b.reason === "Other" && !note) return res.status(400).json({ error: "Add a short note saying what the bonus is for." });
  const wanted = String(b.periodId || ""), d = await peoplePay(wanted);
  if (!d.period || (wanted && d.period.id !== wanted)) return res.status(400).json({ error: "Couldn't find that pay period. Check the Locations tab." });
  const person = d.people.find((p) => p.key === b.personKey); if (!person) return res.status(400).json({ error: "Pick someone from the list." });
  const db = loadDB(); db.bonuses = db.bonuses || [];
  const rec = { id: newId(), personKey: person.key, personName: person.name, periodId: d.period.id, periodStart: d.period.start, periodEnd: d.period.end, amount, reason: b.reason, note, createdAt: new Date().toISOString() };
  db.bonuses.push(rec); saveDB(db); res.json({ ok: true, id: rec.id });
});
app.delete("/api/pay/bonus/:id", requireOwner, (req, res) => {
  const db = loadDB(), before = (db.bonuses || []).length; db.bonuses = (db.bonuses || []).filter((x) => x.id !== req.params.id);
  if (db.bonuses.length === before) return res.status(404).json({ error: "That bonus isn't there any more." });
  saveDB(db); res.json({ ok: true });
});

// ---------- redos: who gets the most, every shop together ----------
// Each shop reports its own redo counts (a redo counts against the techs who worked the original car); people are matched by name across shops, like pay is.
async function redoTotals(rangeParam) {
  const db = loadDB(), today = etToday(), range = ["30", "90", "year", "all"].includes(String(rangeParam)) ? String(rangeParam) : "90";
  const start = range === "all" ? "2020-01-01" : range === "year" ? today.slice(0, 4) + "-01-01" : addDays(today, -Number(range));
  const locs = await askAll(db, `/api/cross-location/redos?period=custom&startDate=${start}&endDate=${today}`);
  const by = new Map(), reasons = {}, events = [];
  locs.filter((l) => l.data).forEach((l) => {
    (l.data.people || []).forEach((p) => {
      const k = personKey(p.name); if (!k) return;
      if (!by.has(k)) by.set(k, { key: k, name: nice(p.name), redos: 0, cars: 0, reasons: {}, shops: [] });
      const r = by.get(k); if (nice(p.name).length > r.name.length) r.name = nice(p.name);
      r.redos += p.redos; r.cars += p.cars; Object.entries(p.reasons || {}).forEach(([reason, n]) => { r.reasons[reason] = (r.reasons[reason] || 0) + n; });
      r.shops.push({ locationId: l.locationId, locationName: l.locationName, redos: p.redos, cars: p.cars, rate: p.cars ? Math.round((p.redos / p.cars) * 1000) / 10 : null });
    });
    (l.data.reasons || []).forEach((x) => { reasons[x.reason] = (reasons[x.reason] || 0) + x.count; });
    (l.data.events || []).forEach((e) => events.push({ ...e, locationName: l.locationName }));
  });
  const people = [...by.values()].map((p) => ({ ...p, rate: p.cars ? Math.round((p.redos / p.cars) * 1000) / 10 : null, shops: p.shops.sort((a, b) => b.redos - a.redos) })).sort((a, b) => b.redos - a.redos || (b.rate || 0) - (a.rate || 0) || a.name.localeCompare(b.name));
  const ok = locs.filter((l) => l.data), tot = (f) => ok.reduce((t, l) => t + ((l.data.totals || {})[f] || 0), 0), redos = tot("redos"), cars = tot("cars");
  events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { range, start, end: today, people, events: events.slice(0, 200), totals: { redos, cars, notTechFault: tot("notTechFault"), rate: cars ? Math.round((redos / cars) * 1000) / 10 : null },
    reasons: Object.entries(reasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    byShop: locs.map((l) => ({ locationId: l.locationId, locationName: l.locationName, ok: !!l.data, needsUpdate: !!l.needsUpdate, redos: l.data ? (l.data.totals || {}).redos : null, cars: l.data ? (l.data.totals || {}).cars : null, rate: l.data ? (l.data.totals || {}).rate : null })),
    locations: locs.map(statusOf) };
}
app.get("/api/pay/redos", requireOwner, async (req, res) => res.json(await redoTotals(req.query.range)));

// ---------- sales reps: their own two-week Thursday-to-Wednesday pay period ----------
const SALES_ANCHOR_END = "2026-08-26";                                                         // a Wednesday that ends one of their pay periods
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
function salesPeriods() { const out = []; for (let k = -30; k <= 12; k++) { const end = addDays(SALES_ANCHOR_END, 14 * k); out.push({ id: end, start: addDays(end, -13), end }); } return out; }
async function salesRepPay(endParam) {
  const db = loadDB(), periods = salesPeriods(), today = etToday();
  const containingIndex = periods.findIndex((p) => p.start <= today && today <= p.end);
  const period = periods.find((p) => p.id === endParam) || periods[containingIndex];
  const locs = await askAll(db, `/api/cross-location/salesrep-pay?start=${period.start}&end=${period.end}`);
  const by = new Map();
  locs.filter((l) => l.data).forEach((l) => (l.data.reps || []).forEach((r) => {
    const k = personKey(r.name); if (!k) return;
    if (!by.has(k)) by.set(k, { key: k, name: nice(r.name), locations: [] });
    const rec = by.get(k); if (nice(r.name).length > rec.name.length) rec.name = nice(r.name);
    rec.locations.push({ locationId: l.locationId, locationName: l.locationName, ...r });
  }));
  const reps = [...by.values()].map((r) => ({ ...r, locationCount: r.locations.length, combined: { totalBooked: sum(r.locations, "totalBooked"), showedCount: sum(r.locations, "showedCount"), noShowCount: sum(r.locations, "noShowCount"), showedValue: sum(r.locations, "showedValue"), commission: sum(r.locations, "commission"), duplicateCount: sum(r.locations, "duplicateCount") } }));
  reps.sort((a, b) => b.combined.commission - a.combined.commission || a.name.localeCompare(b.name));
  const byLocation = locs.map((l) => { const list = l.data ? (l.data.reps || []).slice().sort((a, b) => b.commission - a.commission || a.name.localeCompare(b.name)).map((r) => ({ ...r, name: nice(r.name) })) : [];
    return { ...statusOf(l), reps: list, totals: { totalBooked: sum(list, "totalBooked"), showedCount: sum(list, "showedCount"), noShowCount: sum(list, "noShowCount"), showedValue: sum(list, "showedValue"), commission: sum(list, "commission") } }; });
  return { latestShopBuild: LATEST_SHOP, byLocation, period, periods, containingIndex, locations: locs.map(statusOf), reps, grandTotal: cents(reps.reduce((t, r) => t + r.combined.commission, 0)) };
}
app.get("/api/pay/salesreps", requireOwner, async (req, res) => res.json(await salesRepPay(String(req.query.end || ""))));

// ---------- a spreadsheet of what's on screen ----------
const csvCell = (v) => { let s = v === null || v === undefined ? "" : String(v); if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
app.get("/api/pay/export.csv", requireOwner, async (req, res) => {
  const kind = req.query.kind === "salesreps" ? "salesreps" : "people", byLoc = req.query.view === "location";
  let rows, name;
  if (kind === "people") {
    const d = await peoplePay(String(req.query.periodId || ""));
    const tag = d.period ? `${d.period.start}_${d.period.end}` : "";
    if (byLoc) {
      rows = [["Location", "Person", "Role", "Pay type", "Base pay", "Upsell commission", "Walk-in commission", "Tips", "Adjustments", "Bonus", "Total"]];
      d.byLocation.forEach((l) => {
        if (!l.ok) { rows.push([l.locationName, l.needsUpdate ? "(not included: needs the latest tracker update)" : "(not included: couldn't reach it)"]); return; }
        l.people.forEach((p) => rows.push([l.locationName, p.name, p.role, p.payType || "commission", p.base, p.upsellCommission, p.walkInCommission, p.tips, p.adjustments, "", p.total]));
        rows.push([l.locationName, "SUBTOTAL", "", "", l.totals.base, l.totals.upsellCommission, l.totals.walkInCommission, l.totals.tips, l.totals.adjustments, "", l.totals.total]);
      });
      const ok = d.byLocation.filter((l) => l.ok), all = (f) => cents(ok.reduce((t, l) => t + l.totals[f], 0));
      (d.bonuses || []).forEach((b) => rows.push(["BONUS", `${b.personName} (${b.reason}${b.note ? ": " + b.note : ""})`, "", "", "", "", "", "", "", b.amount, b.amount]));
      rows.push(["ALL LOCATIONS", "TOTAL", "", "", all("base"), all("upsellCommission"), all("walkInCommission"), all("tips"), all("adjustments"), d.bonusTotal || "", cents(all("total") + (d.bonusTotal || 0))]);
      name = `payroll-by-location-techs-managers-${tag}`;
    } else {
      rows = [["Person", "Location", "Role", "Pay type", "Base pay", "Upsell commission", "Walk-in commission", "Tips", "Adjustments", "Bonus", "Total"]];
      d.people.forEach((p) => {
        p.locations.forEach((l) => rows.push([p.name, l.locationName, l.role, l.payType || "commission", l.base, l.upsellCommission, l.walkInCommission, l.tips, l.adjustments, "", l.total]));
        (p.bonuses || []).forEach((b) => rows.push([p.name, `Bonus: ${b.reason}${b.note ? " (" + b.note + ")" : ""}`, "", "", "", "", "", "", "", b.amount, b.amount]));
        if (p.locationCount > 1 || (p.bonuses || []).length) rows.push([p.name, "All locations", "", "", p.combined.base, p.combined.upsellCommission, p.combined.walkInCommission, p.combined.tips, p.combined.adjustments, p.combined.bonus || "", p.combined.total]);
      });
      (d.bonuses || []).filter((b) => !b.matched).forEach((b) => rows.push([b.personName, `Bonus: ${b.reason}${b.note ? " (" + b.note + ")" : ""} (not matched to anyone right now)`, "", "", "", "", "", "", "", b.amount, b.amount]));
      name = d.period ? `payroll-techs-managers-${tag}` : "payroll-techs-managers";
    }
  } else {
    const d = await salesRepPay(String(req.query.end || ""));
    const tag = `${d.period.start}_${d.period.end}`;
    if (byLoc) {
      rows = [["Location", "Sales rep", "Booked", "Showed", "No-shows", "Showed value", "In-hours sales", "After-hours sales", "Commission"]];
      d.byLocation.forEach((l) => {
        if (!l.ok) { rows.push([l.locationName, l.needsUpdate ? "(not included: needs the latest tracker update)" : "(not included: couldn't reach it)"]); return; }
        l.reps.forEach((r) => rows.push([l.locationName, r.name, r.totalBooked, r.showedCount, r.noShowCount, r.showedValue, r.duringHoursCount, r.afterHoursCount, r.commission]));
        rows.push([l.locationName, "SUBTOTAL", l.totals.totalBooked, l.totals.showedCount, l.totals.noShowCount, l.totals.showedValue, "", "", l.totals.commission]);
      });
      const ok = d.byLocation.filter((l) => l.ok), all = (f) => cents(ok.reduce((t, l) => t + l.totals[f], 0));
      rows.push(["ALL LOCATIONS", "TOTAL", all("totalBooked"), all("showedCount"), all("noShowCount"), all("showedValue"), "", "", all("commission")]);
      name = `payroll-by-location-sales-reps-${tag}`;
    } else {
      rows = [["Sales rep", "Location", "Booked", "Showed", "No-shows", "Showed value", "In-hours sales", "After-hours sales", "Commission"]];
      d.reps.forEach((r) => { r.locations.forEach((l) => rows.push([r.name, l.locationName, l.totalBooked, l.showedCount, l.noShowCount, l.showedValue, l.duringHoursCount, l.afterHoursCount, l.commission]));
        if (r.locationCount > 1) rows.push([r.name, "All locations", r.combined.totalBooked, r.combined.showedCount, r.combined.noShowCount, r.combined.showedValue, "", "", r.combined.commission]); });
      name = `payroll-sales-reps-${tag}`;
    }
  }
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` });
  res.send("\ufeff" + csv(rows));
});

// ---------- is each location reachable, and new enough? ----------
app.post("/api/locations/:id/test", requireOwner, async (req, res) => {
  const loc = loadDB().locations.find((l) => l.id === req.params.id);
  if (!loc) return res.status(404).json({ error: "No such location." });
  try {
    const r = await callLocation(loc, "/api/cross-location/people-pay");
    if (r.notOurApi) return res.json({ ok: false, message: "Reached it, but it needs the latest tracker update." });
    if (r.status === 401) return res.json({ ok: false, message: "It refused the secret. Check the secret you entered." });
    if (!r.ok) return res.json({ ok: false, message: (r.data && r.data.error) || `It answered with an error (${r.status}).` });
    const sr = await callLocation(loc, `/api/cross-location/salesrep-pay?start=2026-01-01&end=2026-01-02`);
    const bld = await getBuild(loc), st = buildState(bld);
    res.json({ ok: !sr.notOurApi && sr.ok, build: bld, buildState: st, message: sr.notOurApi ? "Reached it, but it needs the latest tracker update for sales rep pay." : "Connected." + (bld ? ` Running build ${bld}${st === "latest" ? " (the newest)." : st === "behind" ? ", which is behind the newest. Upload the latest shop zip to get the newest payroll fixes." : ", which is old: it has no Re-run payroll yet. Upload the latest shop zip."}` : "") });
  } catch (e) { res.json({ ok: false, message: e.name === "TimeoutError" ? "No answer after 12 seconds." : "Couldn't reach it: " + (e.message || "unknown error") }); }
});

app.listen(PORT, () => console.log(`SBN Payroll tracker ${BUILD} on :${PORT}`));
