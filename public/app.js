// SBN Payroll tracker (read-only). Everyone's pay, across every location, in one place.
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === null || v === undefined || v === false) return;
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v);
  });
  (children || []).flat().forEach((c) => { if (c !== null && c !== undefined && c !== false) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return e;
}
const money = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sum2 = (arr, f) => Math.round(arr.reduce((t, x) => t + (Number(x[f]) || 0), 0) * 100) / 100;
const personKey = (n) => String(n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const initials = (n) => String(n).split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
const day = (ymd) => (ymd ? new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }) : "");
const dayLong = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
async function api(path, opts) {
  const r = await fetch(path, { method: "GET", headers: { "Content-Type": "application/json" }, ...(opts || {}) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login" && path !== "/api/password") { await boot(); throw new Error("Please sign in again."); }
  if (!r.ok) throw new Error(d.error || "Something went wrong.");
  return d;
}
const app = document.getElementById("app");
let openBonus = false;
let tab = "payroll", kind = "people", view = "location", periodId = null, repEnd = null, query = "", multiOnly = false, printAll = false, build = "";
const openKeys = new Set();

async function boot() {
  const s = await fetch("/api/session").then((r) => r.json());
  build = s.build || "";
  app.innerHTML = "";
  if (!s.loggedIn) return renderAuth(s.needsSetup);
  renderMain();
}
function renderAuth(needsSetup) {
  const pw = el("input", { class: "in", type: "password", autocomplete: needsSetup ? "new-password" : "current-password", "aria-label": "Password" });
  const pw2 = el("input", { class: "in", type: "password", autocomplete: "new-password", "aria-label": "Repeat the password" });
  const msg = el("div", { class: "msg err", role: "alert" });
  const go = async () => {
    msg.textContent = "";
    if (needsSetup && pw.value !== pw2.value) { msg.textContent = "The two passwords don't match."; return; }
    try { await api(needsSetup ? "/api/setup/owner-password" : "/api/login", { method: "POST", body: JSON.stringify({ password: pw.value }) }); await boot(); } catch (e) { msg.textContent = e.message; }
  };
  [pw, pw2].forEach((i) => i.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go(); }));
  app.appendChild(el("div", { class: "auth" }, [el("div", { class: "card" }, [
    el("div", { style: "display:flex;background:#E9EBEE;border-radius:10px;padding:8px 14px;align-self:center" }, [el("img", { src: "/logo.png", alt: "SBN Auto Styling", style: "height:56px;width:auto;display:block" })]),
    el("div", { style: "text-align:center" }, [el("h1", { class: "num", style: "margin:0;font-size:38px", text: needsSetup ? "Set your password" : "SBN Payroll" }), el("div", { class: "sub", text: needsSetup ? "This is the only password. Use at least 8 characters." : "Owner sign-in" })]),
    el("label", { class: "f" }, [el("span", { class: "lbl", text: "Password" }), pw]),
    needsSetup ? el("label", { class: "f" }, [el("span", { class: "lbl", text: "Repeat the password" }), pw2]) : null,
    msg, el("button", { class: "btn pri", onclick: go, text: needsSetup ? "Save and sign in" : "Sign in" }),
  ])]));
  pw.focus();
}
function renderMain() {
  const nav = [["payroll", "Payroll"], ["redos", "Redos"], ["locations", "Locations"], ["account", "Account"]];
  app.appendChild(el("header", { class: "top noprint" }, [
    el("div", { class: "brand" }, [el("div", { class: "plate" }, [el("img", { src: "/logo.png", alt: "SBN Auto Styling" })]), el("span", { class: "num", text: "SBN Payroll" })]),
    el("nav", { class: "nav", "aria-label": "Main" }, nav.map(([k, l]) => el("button", { class: "tab" + (tab === k ? " on" : ""), "aria-current": tab === k ? "page" : "false", onclick: () => { tab = k; boot(); }, text: l }))),
    el("div", { class: "sp" }), el("span", { class: "mut", style: "margin-right:12px", text: build ? "build " + build : "" }),
    el("button", { class: "btn sm", onclick: async () => { await fetch("/api/logout", { method: "POST" }); boot(); }, text: "Log out" }),
  ]));
  const main = el("main", {}); app.appendChild(main);
  if (tab === "payroll") renderPayroll(main); else if (tab === "redos") renderRedosAll(main); else if (tab === "locations") renderLocations(main); else renderAccount(main);
}

// ---------------- Payroll ----------------
// "Check before you pay": every location's notes in ONE bar at the top. Closed, it is a single line with the counts; open, each location lists its notes, and the long lists of
// names, days and jobs sit behind a "Show details" of their own, so a big pile of notes never pushes the pay off the screen.
const CHECK_ORDER = { corrections: 0, attendance: 1, unpaid: 2, unmarked: 3, missing: 4 };
let checksOpen = false; const detailOpen = new Set();
function renderChecks(d) {
  const locs = d.locations.filter((l) => l.ok && l.state === "open" && l.warnings.length);
  if (!locs.length) return null;
  const total = locs.reduce((t, l) => t + l.warnings.length, 0), wrap = el("section", { class: "checks noprint", "data-part": "checks" });
  function draw() {
    wrap.innerHTML = "";
    wrap.appendChild(el("button", { class: "checks-head", "data-act": "checks-toggle", "aria-expanded": String(checksOpen), onclick: () => { checksOpen = !checksOpen; draw(); } }, [
      el("span", { class: "checks-ico", "aria-hidden": "true", text: "⚠" }), el("span", { class: "checks-title", text: `Check before you pay · ${total} note${total === 1 ? "" : "s"}` }),
      el("span", { class: "checks-sum", "data-part": "checks-sum", text: locs.map((l) => `${l.locationName} ${l.warnings.length}`).join(" · ") }), el("span", { class: "checks-caret", "aria-hidden": "true", text: checksOpen ? "▴" : "▾" })]));
    if (!checksOpen) return;
    const body = el("div", { class: "checks-body", "data-part": "checks-body" });
    locs.forEach((l) => {
      const ws = l.warnings.slice().sort((a, b) => (CHECK_ORDER[a.code] ?? 9) - (CHECK_ORDER[b.code] ?? 9));
      body.appendChild(el("div", { class: "check-loc", "data-name": l.locationName }, [
        el("div", { class: "row", style: "margin:6px 0 4px" }, [el("h3", { class: "num", style: "margin:0;font-size:24px", text: `${l.locationName} · ${ws.length} note${ws.length === 1 ? "" : "s"}` }), l.url ? el("a", { class: "btn sm", href: l.url, target: "_blank", rel: "noopener noreferrer", "data-act": "open-shop", text: `Open ${l.locationName}` }) : null]),
        ...ws.map((w) => {
          const key = l.locationId + ":" + w.code, items = (w.items || []).map(String), open = detailOpen.has(key);
          return el("div", { class: "check", "data-part": "check", "data-code": w.code }, [
            el("div", { class: "check-text", text: w.text }),
            w.code === "corrections" ? el("div", { class: "check-fix", "data-part": "check-fix" }, [
              el("div", { text: l.url && w.periodStart ? `To fix it: tap the button. It opens ${day(w.periodStart)} \u2013 ${day(w.periodEnd)} in ${l.locationName}, where you press "Re-run this payroll" if its checks haven't gone out yet, or "Add the underpayments to the next check" if they have.` : `To fix it: open ${l.locationName}, go to Payroll, pick Pay period and go back to that period. Press "Re-run this payroll" if its checks haven't gone out yet, or "Add the underpayments to the next check" if they have.` }),
              l.url && w.periodStart && w.periodEnd ? el("a", { class: "btn sm pri", style: "margin-top:8px", "data-act": "open-period", href: `${l.url}/#payroll=${w.periodStart}_${w.periodEnd}`, target: "_blank", rel: "noopener noreferrer", text: `Open ${day(w.periodStart)} \u2013 ${day(w.periodEnd)} in ${l.locationName} to re-run it` }) : null]) : null,
            items.length ? el("button", { class: "check-more", "data-act": "details", "aria-expanded": String(open), onclick: () => { open ? detailOpen.delete(key) : detailOpen.add(key); draw(); }, text: open ? "Hide details" : `Show details (${items.length})` }) : null,
            items.length && open ? el("ul", { class: "check-items", "data-part": "check-items" }, items.map((i) => el("li", { text: i }))) : null]);
        })]));
    });
    wrap.appendChild(body);
  }
  draw();
  return wrap;
}

// ---------- Redos: who gets the most, every location together ----------
let redoRange = "90"; const redoOpen = new Set();
async function renderRedosAll(main) {
  const body = el("div", { style: "display:flex;flex-direction:column;gap:16px" }, [el("div", { class: "mut", text: "Asking every location?" })]);
  main.appendChild(el("div", {}, [el("h1", { class: "num t1", text: "Redos" }), el("div", { class: "sub", text: "Who gets the most redos, every location together. A redo counts against the techs who worked the original car." })]));
  main.appendChild(body);
  let d; try { d = await api("/api/pay/redos?range=" + redoRange); } catch (e) { body.innerHTML = ""; body.appendChild(el("div", { class: "card", text: e.message || "Couldn't load the redos." })); return; }
  body.innerHTML = "";
  const rate = (r) => (r == null ? "\u2014" : r + "%");
  body.appendChild(el("div", { class: "seg", role: "tablist", "aria-label": "How far back" }, [["30", "Last 30 days"], ["90", "Last 90 days"], ["year", "This year"], ["all", "All time"]].map(([k, l]) => el("button", { class: redoRange === k ? "on" : "", role: "tab", "data-range": k, "aria-selected": String(redoRange === k), onclick: () => { redoRange = k; boot(); }, text: l }))));
  d.byShop.filter((s) => !s.ok).forEach((s) => body.appendChild(el("div", { class: "co w", "data-part": "redo-problem" }, [el("b", { text: `${s.locationName} ${s.needsUpdate ? "can't report redos yet (it needs the latest shop update)" : "couldn't be reached"}` })])));
  body.appendChild(el("div", { class: "tiles", "data-part": "redo-tiles", style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px" }, [["Redos", d.totals.redos, d.totals.redos ? "var(--red,#ff8a7a)" : ""], ["Cars worked", d.totals.cars, ""], ["Redo rate", rate(d.totals.rate), ""], ["Not the tech's fault", d.totals.notTechFault, ""]].map(([l, v, c]) => el("div", { class: "card", style: "padding:14px 16px" }, [el("div", { class: "mut", style: "font-size:13px", text: l }), el("div", { class: "num", style: "font-size:34px;" + (c ? "color:" + c : ""), text: String(v) })]))));
  if (d.byShop.some((s) => s.ok)) body.appendChild(el("div", { class: "card", "data-part": "redo-shops", style: "padding:14px 16px" }, [el("div", { style: "font-weight:600;margin-bottom:6px", text: "By location" }), ...d.byShop.filter((s) => s.ok).map((s) => el("div", { class: "row", style: "justify-content:space-between;padding:4px 0" }, [el("span", { text: s.locationName }), el("span", { class: "mut", text: `${s.redos} redo${s.redos === 1 ? "" : "s"} \u00B7 ${s.cars} cars \u00B7 ${rate(s.rate)}` })]))]));
  const list = el("div", { style: "display:flex;flex-direction:column;gap:10px", "data-part": "redo-people" });
  body.appendChild(el("h2", { class: "num", style: "margin:4px 0 0;font-size:26px", text: "Who gets the most" }));
  body.appendChild(list);
  if (!d.people.length) list.appendChild(el("div", { class: "mut", text: "No cars or redos in this period yet." }));
  d.people.forEach((p, i) => {
    const open = redoOpen.has(p.key), mine = d.events.filter((e) => (e.people || []).some((x) => personKey(x.name) === p.key));
    list.appendChild(el("article", { class: "card", "data-part": "redo-person", "data-name": p.name }, [
      el("button", { class: "person", "aria-expanded": String(open), onclick: () => { open ? redoOpen.delete(p.key) : redoOpen.add(p.key); boot(); } }, [
        el("div", { class: "av", text: initials(p.name) }),
        el("div", { style: "flex:1;min-width:0" }, [el("div", { class: "num nm", text: `${p.redos > 0 ? "#" + (i + 1) + "  " : ""}${p.name}` }), el("div", { class: "where", text: `${p.cars} car${p.cars === 1 ? "" : "s"} worked \u00B7 ${rate(p.rate)} redo rate \u00B7 ${p.shops.map((s) => `${s.locationName} ${s.redos}`).join(" \u00B7 ")}` })]),
        el("span", { class: "num chr", "data-part": "redo-count", style: "font-size:36px;" + (p.redos ? "color:var(--red,#ff8a7a)" : ""), text: String(p.redos) }), el("span", { style: "color:var(--mut)", text: open ? "\u25B4" : "\u25BE" })]),
      open ? el("div", { style: "padding:8px 18px 14px" }, mine.length ? mine.map((e) => el("div", { style: "padding:6px 0;border-top:1px solid var(--ln)", "data-part": "redo-event" }, [el("div", { text: `${e.car}${e.customerName ? " \u00B7 " + e.customerName : ""}` }), el("div", { class: "mut", style: "font-size:13px", text: `${e.locationName} \u00B7 came back ${e.date} \u00B7 ${e.reason}${e.notFault ? " \u00B7 not the tech's fault" : ""}${e.note ? " \u00B7 " + e.note : ""}` })])) : [el("div", { class: "mut", text: "No redos in this period." })]) : null]));
  });
  if (d.reasons.length) { const max = Math.max(1, ...d.reasons.map((r) => r.count)); body.appendChild(el("h2", { class: "num", style: "margin:8px 0 0;font-size:26px", text: "Why they happen" })); body.appendChild(el("div", { class: "card", "data-part": "redo-reasons", style: "padding:14px 16px" }, d.reasons.map((r) => el("div", { style: "padding:6px 0" }, [el("div", { class: "row", style: "justify-content:space-between" }, [el("span", { text: r.reason }), el("span", { class: "num", text: String(r.count) })]), el("div", { style: "height:4px;background:var(--ln);border-radius:2px;margin-top:4px" }, [el("div", { style: `height:100%;border-radius:2px;background:var(--acc,#5b93ff);width:${Math.max(3, (r.count / max) * 100)}%` })])])))); }
}

async function renderPayroll(main) {
  const body = el("div", { style: "display:flex;flex-direction:column;gap:18px" }, [el("div", { class: "mut", text: "Asking every location…" })]);
  main.appendChild(body);
  let d;
  try { d = await api(kind === "people" ? "/api/pay/people" + (periodId ? "?periodId=" + encodeURIComponent(periodId) : "") : "/api/pay/salesreps" + (repEnd ? "?end=" + repEnd : "")); } catch (e) { body.innerHTML = ""; body.appendChild(el("div", { class: "co e", text: e.message })); return; }
  body.innerHTML = "";
  const per = d.period, periods = d.periods || [], idx = per ? periods.findIndex((p) => p.id === per.id) : -1, isCur = idx === d.containingIndex;
  const step = (n) => () => { const p = periods[idx + n]; if (!p) return; if (kind === "people") periodId = p.id; else repEnd = p.id; boot(); };
  const printDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  body.appendChild(el("div", { class: "row" }, [
    el("div", {}, [el("h1", { class: "num t1", "data-date": printDate, text: "Payroll" }), el("div", { class: "sub", text: (kind === "people" ? "Techs and managers" : "Sales rep commission") + (view === "location" ? ", one section for each location." : ", every location, added up by name.") })]),
    el("div", { class: "sp" }),
    el("div", { class: "row noprint", style: "gap:10px" }, [
      el("div", { class: "seg", role: "tablist", "aria-label": "How to group it" }, [["location", "By location"], ["person", "By person"]].map(([k, l]) => el("button", { class: view === k ? "on" : "", role: "tab", "data-view": k, "aria-selected": String(view === k), onclick: () => { view = k; boot(); }, text: l }))),
      el("div", { class: "seg", role: "tablist", "aria-label": "Who" }, [["people", "Techs and managers"], ["reps", "Sales reps"]].map(([k, l]) => el("button", { class: kind === k ? "on" : "", role: "tab", "aria-selected": String(kind === k), onclick: () => { kind = k; boot(); }, text: l }))),
    ]),
  ]));
  if (!per) { body.appendChild(el("div", { class: "co e", text: "No location answered, so there is nothing to show. Check the Locations tab." })); }
  else {
    const label = kind === "people" ? `${day(per.start)} – ${day(per.end)} · ${per.name}` : `${dayLong(per.start)} – ${dayLong(per.end)}`;
    body.appendChild(el("div", { class: "row" }, [
      el("div", {}, [el("div", { class: "num", style: "font-size:28px", "data-part": "period", text: label }), el("div", { class: "mut", style: "margin-top:4px", text: (isCur ? "This is the current pay period. " : "") + (kind === "people" && per.paid ? "Paid " + day(per.paid) + "." : kind === "reps" ? "Sales reps are paid on their own two-week cycle." : "") })]),
      el("div", { class: "sp" }),
      el("div", { class: "row noprint", style: "gap:8px" }, [
        el("button", { class: "btn sm", "data-act": "prev", onclick: step(-1), disabled: idx <= 0, text: "Previous" }),
        el("button", { class: "btn sm", "data-act": "current", onclick: () => { periodId = null; repEnd = null; boot(); }, text: "Current" }),
        el("button", { class: "btn sm", "data-act": "next", onclick: step(1), disabled: idx < 0 || idx >= periods.length - 1, text: "Next" }),
      ]),
    ]));
  }
  body.appendChild(el("div", { class: "row", style: "gap:8px" }, d.locations.map((l) => {
    const t = l.needsUpdate ? "needs the latest update" : !l.ok ? "can't reach" : kind === "people" ? (l.state === "run" ? "payroll run " + day((l.runClosedAt || "").slice(0, 10)) : l.state === "skipped" ? "payroll skipped" : "payroll not run yet") : "connected";
    return el("span", { class: "chip " + (l.needsUpdate || !l.ok ? "a" : l.state === "run" ? "g" : ""), "data-part": "loc", title: l.build ? `${l.locationName} is running build ${l.build}` : "", text: `${l.locationName}: ${t}` });
  })));
  d.locations.filter((l) => l.buildState === "old" || l.buildState === "behind").forEach((l) => body.appendChild(el("div", { class: "co w", "data-part": "version-note", "data-state": l.buildState }, [
    el("b", { text: `${l.locationName} is ${l.buildState === "old" ? "on an old version" : "not on the newest version"} (build ${l.build})` }),
    el("div", { class: "sub", text: l.buildState === "old" ? "It doesn't have Re-run payroll yet, so you can't re-run a period there. Upload the latest sbn-tracker-live.zip to that shop." : `It has Re-run payroll, but not the newest payroll fixes (the newest is ${d.latestShopBuild}). Upload the latest sbn-tracker-live.zip to that shop.` })])));
  d.locations.filter((l) => l.needsUpdate || !l.ok).forEach((l) => body.appendChild(el("div", { class: "co w", "data-part": "problem", text: l.needsUpdate ? `${l.locationName} needs the latest tracker update before its pay can be shown here. The totals below do not include it.` : `Couldn't reach ${l.locationName} (${l.error || "no answer"}). The totals below do not include it.` })));
  const checks = kind === "people" ? renderChecks(d) : null;
  if (checks) body.appendChild(checks);
  const list = kind === "people" ? d.people : d.reps;
  const search = el("input", { class: "in", placeholder: "Search a name", "aria-label": "Search a name", value: query, style: "max-width:280px", "data-field": "search" });
  search.addEventListener("input", () => { query = search.value; drawList(); });
  const multi = el("input", { type: "checkbox", style: "width:22px;height:22px;accent-color:#5B93FF", "data-field": "multi" }); multi.checked = multiOnly;
  multi.addEventListener("change", () => { multiOnly = multi.checked; drawList(); });
  const total = el("span", { style: "color:var(--sub)" });
  const csvHref = (kind === "people" ? "/api/pay/export.csv?kind=people" + (periodId ? "&periodId=" + encodeURIComponent(periodId) : "") : "/api/pay/export.csv?kind=salesreps" + (repEnd ? "&end=" + repEnd : "")) + (view === "location" ? "&view=location" : "");
  body.appendChild(el("div", { class: "row noprint" }, [search, kind === "people" && view === "person" ? el("label", { style: "display:flex;align-items:center;gap:12px;min-height:44px" }, [multi, "Only people at 2+ locations"]) : null, el("div", { class: "sp" }), total,
    el("a", { class: "btn sm", href: csvHref, "data-act": "csv", download: "", text: "Export spreadsheet" }), el("button", { class: "btn sm", "data-act": "print", onclick: () => { printAll = true; drawList(); window.print(); printAll = false; drawList(); }, text: "Print" })]));
  // Bonuses: typed in here, added to the person's one combined check for the pay period on screen
  function bonusCard() {
    const list = d.bonuses || [], card = el("section", { class: "card", "data-part": "bonuses", style: "padding:16px 18px" }), msg = el("div", { style: "font-size:13px;min-height:16px;margin-top:6px;color:var(--warn)", "data-part": "bonus-msg" });
    const person = el("select", { class: "in", "data-field": "bonus-person", style: "width:100%;margin-bottom:8px" }, [el("option", { value: "", text: "Who gets the bonus?" }), ...(d.people || []).slice().sort((x, y) => x.name.localeCompare(y.name)).map((p) => el("option", { value: p.key, text: `${p.name} (${p.locations.map((l) => l.locationName).join(" + ")})` }))]);
    const amount = el("input", { class: "in", type: "number", step: "0.01", min: "0", inputmode: "decimal", placeholder: "Amount, like 100", "data-field": "bonus-amount", style: "width:100%;margin-bottom:8px" });
    const reason = el("select", { class: "in", "data-field": "bonus-reason", style: "width:100%;margin-bottom:8px" }, (d.bonusReasons || []).map((r) => el("option", { value: r, text: r })));
    const note = el("input", { class: "in", type: "text", maxlength: "200", placeholder: "Note (what it's for)", "data-field": "bonus-note", style: "width:100%;margin-bottom:8px" });
    const form = el("div", { style: "display:none;margin-top:12px", "data-part": "bonus-form" }, [person, amount, reason, note,
      el("div", { class: "mut", style: "font-size:13px;margin-bottom:8px", text: `It goes on the ${d.period ? d.period.name + " (" + d.period.start + " to " + d.period.end + ")" : "pay period on screen"} check, added to everything else they're paid.` }),
      el("button", { class: "btn pri", "data-act": "bonus-save", text: "Add bonus", onclick: async () => { msg.textContent = ""; try { await api("/api/pay/bonus", { method: "POST", body: JSON.stringify({ personKey: person.value, periodId: d.period && d.period.id, amount: amount.value, reason: reason.value, note: note.value }) }); openBonus = true; await boot(); } catch (e) { msg.textContent = e.message || "Couldn't add that."; } } })]);
    if (openBonus) form.style.display = "block";
    card.appendChild(el("div", { class: "row", style: "align-items:baseline;gap:12px" }, [el("h2", { class: "num", style: "margin:0;font-size:26px", text: "Bonuses" }), el("span", { class: "mut", "data-part": "bonus-sum", text: list.length ? `${list.length} this period \u00B7 ${money(d.bonusTotal)}` : "none this period" }), el("div", { class: "sp" }), el("button", { class: "btn sm pri noprint", "data-act": "bonus-toggle", text: "+ Add a bonus", onclick: () => { openBonus = form.style.display === "none"; form.style.display = openBonus ? "block" : "none"; } })]));
    list.forEach((b) => card.appendChild(el("div", { class: "row", "data-part": "bonus-row", style: "padding:9px 0;border-top:1px solid var(--ln);gap:10px;align-items:center" }, [el("div", { style: "flex:1;min-width:0" }, [el("div", { text: b.personName }), el("div", { class: "mut", style: "font-size:13px", text: `${b.reason}${b.note ? " \u00B7 " + b.note : ""}${b.matched ? "" : " \u00B7 not matched to anyone right now"}` })]), el("b", { class: "num chr", text: money(b.amount) }), el("button", { class: "btn sm noprint", "data-act": "bonus-remove", text: "Remove", onclick: async () => { if (!confirm(`Remove ${money(b.amount)} bonus for ${b.personName}?`)) return; try { await api("/api/pay/bonus/" + b.id, { method: "DELETE" }); openBonus = false; await boot(); } catch (e) { msg.textContent = e.message || "Couldn't remove that."; } } })])));
    card.appendChild(form); card.appendChild(msg); return card;
  }
  if (kind === "people") body.appendChild(bonusCard());
  const listEl = el("div", { style: "display:flex;flex-direction:column;gap:12px", "data-part": "list" }); body.appendChild(listEl);
  const line = (l, v, cls) => el("div", { class: "ln" }, [l, el("b", { style: cls || "", text: v })]);
  function peopleBoxes(p) {
    const box = (t, x, all) => el("div", { class: "box" + (all ? " all" : "") }, [el("h4", { text: t }), line("Base pay", money(x.base)), line("Upsell commission", money(x.upsellCommission)), line("Walk-in commission", money(x.walkInCommission)), line("Tips", money(x.tips)), x.adjustments ? line(x.state === "open" || all ? "Adjustments" : "Adjustments", (x.adjustments > 0 ? "+" : "") + money(x.adjustments)) : null,
      x.bonus ? line("Bonus", money(x.bonus), "color:#6BF0B4") : null,
      el("div", { class: "ln t" }, ["Total", el("b", { class: "chr", text: money(x.total) })]), x.changedSinceRun ? el("div", { style: "font-size:12px;color:var(--warn);margin-top:6px", text: "Jobs changed after payroll was run here, so this may no longer match what was paid. These are the amounts the run recorded." }) : null]);
    return el("div", { class: "boxes" }, [...p.locations.map((l) => box(`${l.locationName} · ${l.role}${l.payType ? " · " + l.payType : ""}${l.payType && l.daysPresent ? ` · ${l.daysPresent} day${l.daysPresent !== 1 ? "s" : ""} marked present` : ""}`, l)), (p.locationCount > 1 || p.bonus) ? box("Combined, all locations", p.combined, true) : null]);
  }
  function repBoxes(r) {
    const box = (t, x, all) => el("div", { class: "box" + (all ? " all" : "") }, [el("h4", { text: t }), line("Booked", String(x.totalBooked)), line("Showed", String(x.showedCount), "color:#6BF0B4"), line("No-shows", String(x.noShowCount), x.noShowCount ? "color:#FFA99D" : ""), line("Showed value", money(x.showedValue)),
      all ? null : line("In-hours / after-hours sales", `${x.duringHoursCount} / ${x.afterHoursCount}`), el("div", { class: "ln t" }, ["Commission", el("b", { class: "chr", text: money(x.commission) })]),
      x.duplicateCount ? el("div", { style: "font-size:12px;color:var(--warn);margin-top:6px", text: `${x.duplicateCount} possible duplicate job${x.duplicateCount !== 1 ? "s" : ""} counted here. Check this location's Test tool.` }) : null]);
    return el("div", { class: "boxes" }, [...r.locations.map((l) => box(`${l.locationName} · ${l.commissionRate}% in-hours, ${l.afterHoursCommissionRate}% after-hours`, l)), r.locationCount > 1 ? box("Combined, all locations", r.combined, true) : null]);
  }
  function drawList() { if (view === "location") drawLocations(); else drawPeople(); }
  // One section per location, in the order set on the Locations tab: everyone at that location with its own subtotal, and a tile on top for each location plus all of them.
  function drawLocations() {
    listEl.innerHTML = "";
    const q = query.trim().toLowerCase(), isP = kind === "people", locs = d.byLocation || [];
    const rowsOf = (l) => (isP ? l.people : l.reps).filter((p) => !q || p.name.toLowerCase().includes(q));
    const amtOf = (x) => (isP ? x.total : x.commission);
    const okLocs = locs.filter((l) => l.ok);
    const grand = Math.round((okLocs.reduce((t, l) => t + (isP ? l.totals.total : l.totals.commission), 0) + (isP ? d.bonusTotal || 0 : 0)) * 100) / 100;
    const headcount = okLocs.reduce((t, l) => t + (isP ? l.people.length : l.reps.length), 0);
    total.textContent = `${headcount} ${isP ? (headcount === 1 ? "person" : "people") : (headcount === 1 ? "sales rep" : "sales reps")} across ${okLocs.length} location${okLocs.length === 1 ? "" : "s"} · ${money(grand)} in total`;
    if (!locs.length) { listEl.appendChild(el("div", { class: "co w", text: "No locations yet. Add each shop on the Locations tab." })); return; }
    listEl.appendChild(el("div", { class: "grid", style: "--m:210px", "data-part": "loc-summary" }, [
      ...locs.map((l) => el("div", { class: "card", style: "padding:16px 18px", "data-part": "loc-tile", "data-name": l.locationName }, [
        el("div", { class: "lbl", text: l.locationName }),
        el("div", { class: "num" + (l.ok ? " chr" : ""), style: "font-size:34px;margin-top:8px" + (l.ok ? "" : ";color:var(--warn)"), text: l.ok ? money(isP ? l.totals.total : l.totals.commission) : "not included" }),
        el("div", { class: "mut", style: "margin-top:4px", text: l.ok ? (() => { const n = (isP ? l.people : l.reps).length; return `${n} ${isP ? (n === 1 ? "person" : "people") : (n === 1 ? "sales rep" : "sales reps")}`; })() : (l.needsUpdate ? "needs the latest update" : "can't reach it") })])),
      isP && d.bonusTotal ? el("div", { class: "card", style: "padding:16px 18px", "data-part": "loc-tile", "data-name": "Bonuses" }, [el("div", { class: "lbl", text: "Bonuses" }), el("div", { class: "num chr", style: "font-size:34px;margin-top:8px", text: money(d.bonusTotal) }), el("div", { class: "mut", style: "margin-top:4px", text: `${(d.bonuses || []).length} bonus${(d.bonuses || []).length === 1 ? "" : "es"}, not tied to one location` })]) : null,
      el("div", { class: "card", style: "padding:16px 18px;background:var(--card2)", "data-part": "loc-tile", "data-name": "All locations" }, [
        el("div", { class: "lbl", text: "All locations" }), el("div", { class: "num chr", style: "font-size:34px;margin-top:8px", text: money(grand) }), el("div", { class: "mut", style: "margin-top:4px", text: `${okLocs.length} of ${locs.length} included` })]),
    ]));
    const det = (label, v, cls) => el("span", { class: "det" }, [el("span", { class: "dl", text: label }), el("b", { style: cls || "", text: v })]);
    locs.forEach((l) => {
      const shown = l.ok ? rowsOf(l) : [];
      if (q && l.ok && !shown.length) return;                                    // a search hides locations with no match
      const stateChip = !l.ok ? el("span", { class: "chip a", text: l.needsUpdate ? "needs the latest update" : "can't reach" }) : isP ? el("span", { class: "chip " + (l.state === "run" ? "g" : ""), text: l.state === "run" ? "payroll run " + day((l.runClosedAt || "").slice(0, 10)) : l.state === "skipped" ? "payroll skipped" : "payroll not run yet" }) : null;
      const sec = el("section", { class: "lsec", "data-part": "loc-section", "data-name": l.locationName });
      const tot = isP ? { base: sum2(shown, "base"), up: sum2(shown, "upsellCommission"), wi: sum2(shown, "walkInCommission"), tips: sum2(shown, "tips"), adj: sum2(shown, "adjustments"), total: sum2(shown, "total") } : { booked: sum2(shown, "totalBooked"), showed: sum2(shown, "showedCount"), ns: sum2(shown, "noShowCount"), val: sum2(shown, "showedValue"), commission: sum2(shown, "commission") };
      sec.appendChild(el("div", { class: "row", style: "align-items:baseline;margin-bottom:6px" }, [el("h2", { class: "num", style: "margin:0;font-size:30px", text: l.locationName }), stateChip, el("div", { class: "sp" }), l.ok ? el("span", { class: "num chr", "data-part": "loc-total", style: "font-size:34px", text: money(isP ? tot.total : tot.commission) }) : null]));
      if (!l.ok) { sec.appendChild(el("div", { class: "co w", text: l.needsUpdate ? `${l.locationName} needs the latest tracker update before its pay can be shown here. It is not included in the totals.` : `Couldn't reach ${l.locationName} (${l.error || "no answer"}). It is not included in the totals.` })); listEl.appendChild(sec); return; }
      if (!shown.length) { sec.appendChild(el("div", { class: "mut", style: "padding:10px 0", text: isP ? "No one has pay for this period at this location." : "No sales reps at this location." })); listEl.appendChild(sec); return; }
      sec.appendChild(isP
        ? el("div", { class: "lrow h" }, [el("span", { text: "Person" }), ...["Base pay", "Upsell", "Walk-in", "Tips", "Adjust."].map((h) => el("span", { class: "r", text: h })), el("span", { class: "r", text: "Total" })])
        : el("div", { class: "lrow h" }, [el("span", { text: "Sales rep" }), ...["Booked", "Showed", "No-shows", "Showed value", "In / after hrs"].map((h) => el("span", { class: "r", text: h })), el("span", { class: "r", text: "Commission" })]));
      shown.forEach((p) => {
        const k = "L:" + kind + ":" + l.locationId + ":" + personKey(p.name), open = printAll || openKeys.has(k);
        const sub = isP ? `${p.role}${p.payType ? " · " + p.payType : ""}` : `${p.commissionRate}% in-hours · ${p.afterHoursCommissionRate}% after-hours`;
        sec.appendChild(el("div", { class: "lrow" + (open ? " open" : ""), role: "button", tabindex: "0", "aria-expanded": String(open), "data-part": "lrow", "data-name": p.name, onclick: () => { openKeys.has(k) ? openKeys.delete(k) : openKeys.add(k); drawList(); }, onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openKeys.has(k) ? openKeys.delete(k) : openKeys.add(k); drawList(); } } }, [
          el("div", { class: "nm2" }, [el("div", { text: p.name }), el("div", { class: "mut", text: sub })]),
          ...(isP ? [det("Base pay", money(p.base)), det("Upsell commission", money(p.upsellCommission)), det("Walk-in commission", money(p.walkInCommission)), det("Tips", money(p.tips)), det("Adjustments", p.adjustments ? (p.adjustments > 0 ? "+" : "") + money(p.adjustments) : "$0.00")]
                  : [det("Booked", String(p.totalBooked)), det("Showed", String(p.showedCount), "color:#6BF0B4"), det("No-shows", String(p.noShowCount), p.noShowCount ? "color:#FFA99D" : ""), det("Showed value", money(p.showedValue)), det("In / after-hours sales", `${p.duringHoursCount} / ${p.afterHoursCount}`)]),
          el("b", { class: "num tot", "data-part": "row-total", text: money(amtOf(p)) })]));
      });
      sec.appendChild(el("div", { class: "lrow t" }, [el("span", { text: (q ? "Total shown, " : "Total, ") + l.locationName }),
        ...(isP ? [det("", money(tot.base)), det("", money(tot.up)), det("", money(tot.wi)), det("", money(tot.tips)), det("", (tot.adj > 0 ? "+" : "") + money(tot.adj))] : [det("", String(tot.booked)), det("", String(tot.showed)), det("", String(tot.ns)), det("", money(tot.val)), det("", "")]),
        el("b", { class: "num tot", text: money(isP ? tot.total : tot.commission) })]));
      listEl.appendChild(sec);
    });
  }
  function drawPeople() {
    listEl.innerHTML = "";
    const q = query.trim().toLowerCase();
    const shown = list.filter((p) => (!multiOnly || kind !== "people" || p.locationCount > 1) && (!q || p.name.toLowerCase().includes(q)));
    const grand = Math.round(shown.reduce((t, p) => t + (kind === "people" ? p.combined.total : p.combined.commission), 0) * 100) / 100;
    total.textContent = shown.length ? `${shown.length} ${kind === "people" ? (shown.length === 1 ? "person" : "people") : (shown.length === 1 ? "sales rep" : "sales reps")} · ${money(grand)} in total` : "";
    if (!shown.length) { listEl.appendChild(el("div", { class: "mut", style: "padding:14px 0", text: list.length ? "No one matches that." : "Nothing to show for this pay period." })); return; }
    shown.forEach((p) => {
      const open = printAll || openKeys.has(kind + ":" + p.key), amt = kind === "people" ? p.combined.total : p.combined.commission;
      const where = p.locations.map((l) => `${l.locationName} ${money(kind === "people" ? l.total : l.commission)}`).join(" · ");
      listEl.appendChild(el("article", { class: "card", "data-part": "person", "data-name": p.name }, [
        el("button", { class: "person", "aria-expanded": String(open), onclick: () => { const k = kind + ":" + p.key; openKeys.has(k) ? openKeys.delete(k) : openKeys.add(k); drawList(); } }, [
          el("div", { class: "av", text: initials(p.name) }), el("div", { style: "flex:1;min-width:0" }, [el("div", { class: "num nm", text: p.name }), el("div", { class: "where", text: where })]),
          el("span", { class: "num chr", "data-part": "amount", style: "font-size:36px", text: money(amt) }), el("span", { class: "noprint", style: "color:var(--mut)", text: open ? "▴" : "▾" })]),
        open ? (kind === "people" ? peopleBoxes(p) : repBoxes(p)) : null]));
    });
  }
  drawList();
  body.appendChild(el("p", { class: "mut", style: "max-width:760px;margin:0", text: (view === "location" ? "Each section is one location's own Payroll figures. " : "") + (kind === "people" ? "Techs and managers use the shops' shared pay schedule. " : "") + "People are matched by name, so spell someone's name the same way at every location. This screen only reads. Nothing here changes any location's payroll." }));
}

// ---------------- Locations ----------------
async function renderLocations(main) {
  main.appendChild(el("div", {}, [el("h1", { class: "num t1", text: "Locations" }), el("div", { class: "sub", text: "The trackers this reads pay from, in the order they appear on the Payroll screen. It never writes to them." })]));
  const box = el("div", { style: "display:flex;flex-direction:column;gap:12px" }); main.appendChild(box);
  const locs = await api("/api/locations");
  box.appendChild(el("div", { class: "card", "data-part": "locations" }, locs.length ? locs.map((l, li) => {
    const status = el("span", { class: "chip", "data-part": "status", text: "Not tested" });
    return el("div", { class: "row", style: "padding:10px 0;border-bottom:1px solid var(--ln)", "data-name": l.name }, [el("div", { style: "flex:1 1 260px" }, [el("div", { class: "num", style: "font-size:24px", text: l.name }), el("div", { class: "mut", text: l.url + " · secret " + l.secretHint })]), status,
      el("button", { class: "btn sm", "data-act": "up", "aria-label": "Move " + l.name + " up", disabled: li === 0, onclick: async () => { await api(`/api/locations/${l.id}/move`, { method: "POST", body: JSON.stringify({ direction: "up" }) }); boot(); }, text: "↑" }),
      el("button", { class: "btn sm", "data-act": "down", "aria-label": "Move " + l.name + " down", disabled: li === locs.length - 1, onclick: async () => { await api(`/api/locations/${l.id}/move`, { method: "POST", body: JSON.stringify({ direction: "down" }) }); boot(); }, text: "↓" }),
      el("button", { class: "btn sm", "data-act": "rename", onclick: async () => { const nm = prompt("New name for " + l.name, l.name); if (nm === null || !nm.trim()) return; try { await api("/api/locations/" + l.id, { method: "PATCH", body: JSON.stringify({ name: nm.trim() }) }); boot(); } catch (e) { alert(e.message); } }, text: "Rename" }),
      el("button", { class: "btn sm", onclick: async () => { status.className = "chip"; status.textContent = "Testing…"; const r = await api(`/api/locations/${l.id}/test`, { method: "POST" }); status.className = "chip " + (r.ok ? "g" : "a"); status.textContent = r.message; }, text: "Test connection" }),
      el("button", { class: "btn sm dng", onclick: async () => { if (!confirm(`Remove ${l.name}? Its pay will no longer be included.`)) return; await api("/api/locations/" + l.id, { method: "DELETE" }); boot(); }, text: "Remove" })]);
  }) : [el("div", { class: "mut", text: "No locations yet. Add each one below." })]));
  const name = el("input", { class: "in", placeholder: "e.g. NJ, Philly, Sunrise", "aria-label": "Location name" }), url = el("input", { class: "in", placeholder: "https://your-tracker.up.railway.app", "aria-label": "Tracker address" }), secret = el("input", { class: "in", type: "password", placeholder: "That location's cross-location secret", autocomplete: "off", "aria-label": "Cross-location secret" });
  const msg = el("div", { class: "msg" });
  box.appendChild(el("div", { class: "card" }, [el("h2", { class: "num", style: "margin:0 0 12px;font-size:24px", text: "Add a location" }),
    el("div", { class: "grid", style: "--m:260px;align-items:end" }, [el("label", { class: "f" }, [el("span", { class: "lbl", text: "Location name" }), name]), el("label", { class: "f" }, [el("span", { class: "lbl", text: "Tracker address" }), url]), el("label", { class: "f" }, [el("span", { class: "lbl", text: "Cross-location secret" }), secret]),
      el("button", { class: "btn pri", onclick: async () => { msg.className = "msg"; try { await api("/api/locations", { method: "POST", body: JSON.stringify({ name: name.value, url: url.value, secret: secret.value }) }); boot(); } catch (e) { msg.className = "msg err"; msg.textContent = e.message; } }, text: "Add location" })]),
    msg, el("div", { class: "mut", style: "margin-top:8px;max-width:760px", text: "The secret is the CROSS_LOCATION_SECRET set on that location's tracker. Once saved it is never shown again. To add a new location later: deploy its tracker on the latest build, set its CROSS_LOCATION_SECRET, then add it here. It joins the end of the list, and nothing else needs to change." })]));
}
// ---------------- Account ----------------
function renderAccount(main) {
  main.appendChild(el("div", {}, [el("h1", { class: "num t1", text: "Account" }), el("div", { class: "sub", text: "Change the password. Every other device is signed out when you do." })]));
  const cur = el("input", { class: "in", type: "password", autocomplete: "current-password", "aria-label": "Current password" }), nxt = el("input", { class: "in", type: "password", autocomplete: "new-password", "aria-label": "New password" }), msg = el("div", { class: "msg" });
  main.appendChild(el("div", { class: "card", style: "max-width:460px;display:flex;flex-direction:column;gap:14px" }, [el("label", { class: "f" }, [el("span", { class: "lbl", text: "Current password" }), cur]), el("label", { class: "f" }, [el("span", { class: "lbl", text: "New password (at least 8 characters)" }), nxt]), msg,
    el("button", { class: "btn pri", onclick: async () => { msg.className = "msg"; try { await api("/api/password", { method: "POST", body: JSON.stringify({ current: cur.value, next: nxt.value }) }); msg.className = "msg ok"; msg.textContent = "Password changed."; cur.value = ""; nxt.value = ""; } catch (e) { msg.className = "msg err"; msg.textContent = e.message; } }, text: "Change password" })]));
}
boot();
