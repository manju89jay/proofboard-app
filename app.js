/* =====================================================================
   Proofboard front end. The data lives in a private GitHub repository;
   rules.js checks every change and sync.js saves it.
   ===================================================================== */
import { view, seedToState, hexId, openableType, safeExtension, cleanFileName } from "./rules.js";
import { createClient, apiBaseFor } from "./github.js";
import { Sync } from "./sync.js";
import { renderLearnList, renderTopic } from "./learn.js";

const $ = (id) => document.getElementById(id);
let S = null;             // what the page shows: view() of the synced data
const IX = {};            // lookups built from S
const ui = {
  tab: "today", planTrack: "", hideDone: false, lateOnly: false, openWeeks: {}, openNotes: {}, openProof: {},
  logEdit: null,
  sk: { q: "", cat: "", prio: "q1", proof: "", sort: "prio", open: {} },
  lib: { q: "", kind: "", skill: "" },
  schedDraft: null, schedKey: null,
  learn: { topic: null },
};
// The Learn pages ship with the page (learn/*.json) and load when first needed.
const LEARN = { index: null, loading: false, error: false, bodies: {}, body: {} };
try { ui.tab = sessionStorage.getItem("pb-tab") || "today"; } catch (e) { /* private mode */ }

const TRACKS = {
  cpp: "C++ and patterns", dsa: "DSA and live coding", concepts: "Design, robotics, simulation",
  project: "Project and open source", review: "Review", apps: "Job applications", general: "General",
};
const PLAN_TRACKS = ["cpp", "dsa", "concepts", "project", "review"];
const KINDS = {
  code: "Code (GitHub or repo)", leetcode: "LeetCode or coding problem", notes: "Notes in my own words",
  doc: "PDF or document", recording: "Recording of me explaining", design: "Design sketch or write-up",
  mock: "Mock interview", other: "Other",
};
const KIND_FOR_TRACK = { cpp: "code", dsa: "leetcode", concepts: "design", project: "code", review: "notes", general: "notes" };
const CONF = ["Not rated", "Shaky", "Okay", "Good", "Could teach it"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Status ladders from the roadmap. Open-source targets use their own.
const LADDER = ["Not started", "Studied", "Implemented with help", "Independent implementation", "Delayed re-test passed"];
const OSS_LADDER = ["Not started", "Reproduced", "Patch/tests", "Submitted", "Review", "Accepted"];
const ladderFor = (s) => (s.cat === "oss" ? OSS_LADDER : LADDER);
const PRIOS = ["", "P0", "Awareness", "P1", "P2"];
const PRANK = { P0: 0, Awareness: 1, P1: 2, P2: 3, "": 4 };
const LOG_FIELDS = [
  ["cpp", "C++ and patterns", "C++"],
  ["dsa", "DSA problems (names, time, how it went)", "DSA"],
  ["concepts", "Design, robotics or simulation", "Concepts"],
  ["project", "Project and open source", "Project"],
  ["apps", "Job applications (evening)", "Applications"],
  ["notes", "Notes in your own words", "My notes"],
  ["stuck", "Stuck on or questions", "Stuck on"],
];
const MAX_FILE = 25 * 1024 * 1024;
const CONFIG_KEY = "pb-config";

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => (n < 10 ? "0" : "") + n;
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = (s) => { const p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); };
const today = () => isoOf(new Date());
const fmt = (s, o) => { try { return parseD(s).toLocaleDateString("en-GB", o || { weekday: "short", day: "numeric", month: "short" }); } catch (e) { return s; } };
const fmtLong = (s) => fmt(s, { weekday: "long", day: "numeric", month: "long" });
const fmtTs = (iso) => { try { const d = new Date(iso); return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return iso; } };
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const tag = (track) => `<span class="tag t-${esc(track)}">${esc(TRACKS[track] || track)}</span>`;
const opts = (list, cur, blank = "Not set", names) => list.map((v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v === "" ? blank : names ? names[v] : v)}</option>`).join("");
const accBar = (done, total) => `<span class="bar acc" aria-hidden="true"><i style="width:${total ? (100 * done) / total : 0}%"></i></span>`;
const byDue = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : PLAN_TRACKS.indexOf(a.track) - PLAN_TRACKS.indexOf(b.track));
const doneCount = (list) => list.filter((i) => i.done).length;
const startMin = (b) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(b.start).trim()); return m ? +m[1] * 60 + +m[2] : 100000; };
const rangeTxt = (w) => { const a = parseD(w.start), b = parseD(w.end); return `${a.getDate()}${a.getMonth() !== b.getMonth() ? " " + a.toLocaleDateString("en-GB", { month: "short" }) : ""} to ${b.getDate()} ${b.toLocaleDateString("en-GB", { month: "short" })}`; };
// The last week that started on or before d, so a weekend between two weeks still belongs to one.
const weekOf = (d) => (!S.weeks.length || d < S.weeks[0].start || d > S.weeks[S.weeks.length - 1].end ? null : S.weeks.filter((w) => w.start <= d).pop());
const sched = () => S.schedule.sets[S.schedule.active];
// A debounced function that can also run its waiting call at once (flush).
const debounce = (fn, ms) => {
  let t = null, last = [];
  const d = (...a) => { last = a; clearTimeout(t); t = setTimeout(() => { t = null; fn(...last); }, ms); };
  d.flush = () => { if (t !== null) { clearTimeout(t); t = null; fn(...last); } };
  return d;
};

function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2500);
}

/* ---------- data ---------- */
let sync = null;
let viewFor = "";            // the local date S was built for
let staleRender = false;     // another device changed data while you were typing

const newId = (bytes) => hexId(crypto.getRandomValues(new Uint8Array(bytes)));

function readConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)); } catch (e) { return null; }
}


function refreshView() {
  viewFor = today();
  S = view(sync.state, viewFor);
  buildIndex();
}

// Applies a change here at once and queues it for saving. Throws if the change is invalid.
function change(op, opts) {
  return sync.enqueue({ ...op, at: new Date().toISOString() }, opts);
}

function act(fn, okMsg) {
  try {
    fn();
    refreshView();
    render();
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

const typing = () => {
  const a = document.activeElement;
  return !!(a && a.closest && a.closest("textarea, input:not([type=checkbox]):not([type=radio]), select"));
};

function onSyncChange(kind) {
  if (kind === "local" || kind === "saved") refreshView();
  if (kind === "remote") {
    refreshView();
    if (typing() || $("proofDlg").open || ui.logEdit) staleRender = true;
    else render();
  }
  renderStatus();
}

function renderStatus() {
  if (!sync) return;
  const st = sync.status;
  const n = st.pending;
  const waiting = `${n} change${n === 1 ? "" : "s"} waiting`;
  const text = {
    saved: staleRender ? "Updated from another device" : "All changes saved",
    saving: n ? `Saving ${n} change${n === 1 ? "" : "s"}…` : "Saving…",
    waiting: `${waiting}. ${st.message}`,
    offline: `${waiting}: no connection. They stay on this device.`,
    error: st.message,
  }[st.phase];
  const el = $("syncStatus");
  el.textContent = text;
  el.className = "savestate" + (st.phase === "saved" || st.phase === "saving" ? "" : " dirty");
  if (st.phase === "offline" || st.phase === "error" || st.phase === "waiting") {
    el.insertAdjacentHTML("beforeend", ` <button type="button" class="btn link" data-act="retrysave">Try again</button>`);
  }
  const rej = $("rejected");
  rej.hidden = !st.rejected.length;
  rej.innerHTML = st.rejected.length
    ? `<div><b>These changes could not be saved, because the data changed on another device:</b><ul>${st.rejected.map((r) => `<li>${esc(r.what)}: ${esc(r.why)}</li>`).join("")}</ul></div><button type="button" class="btn small" data-act="dismissrejected">OK, I've seen them</button>`
    : "";
}

/* ---------- setup ---------- */
function showApp(on) {
  document.querySelector(".tabs").hidden = !on;
  $("addProofTop").hidden = !on;
  $("tools").hidden = !on;
  $("p-setup").hidden = on;
  $("loading").hidden = true;
}

function renderSetup({ message = "", empty = false } = {}) {
  showApp(false);
  for (const k of Object.keys(RENDER)) $("p-" + k).hidden = true;
  const cfg = readConfig() || {};
  let h = `<h2>Connect Proofboard to your data</h2>`;
  h += `<p class="lede">Your plan and proof live in a private GitHub repository. This device needs the repository's name and a token that can read and write only that repository. Both stay in this browser.</p>`;
  if (message) h += `<p class="dlg-err">${esc(message)}</p>`;
  if (empty) {
    h += `<div class="card"><h3>${esc(cfg.repo || "The repository")} has no Proofboard data yet</h3><p>Start with the roadmap plan: 13 weeks, 133 items and 111 skills. You can change dates and add items later.</p><button type="button" class="btn primary" data-act="startroadmap">Start from the roadmap</button> <button type="button" class="btn" data-act="forget">Use a different repository</button></div>`;
  } else {
    h += `<ol class="steps"><li>On GitHub, create a <b>private</b> repository, for example <code>proofboard-data</code>.</li>`;
    h += `<li>Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained token</a>. Under <b>Repository access</b> pick <b>Only select repositories</b> and choose that repository. Under <b>Permissions</b> set <b>Contents</b> to <b>Read and write</b>. Pick an expiry date you'll remember.</li>`;
    h += `<li>Enter both here, once on each device.</li></ol>`;
    h += `<div class="card"><div class="grid2"><label class="fld">Repository (owner/name)<input type="text" id="setupRepo" value="${esc(cfg.repo || "")}" placeholder="your-name/proofboard-data" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`;
    h += `<label class="fld">Token<input type="password" id="setupToken" autocomplete="off" spellcheck="false" placeholder="github_pat_..."></label></div>`;
    h += `<div class="row" style="margin-top:12px"><button type="button" class="btn primary" data-act="connect">Connect</button></div></div>`;
  }
  $("p-setup").innerHTML = h;
}

async function boot() {
  const cfg = readConfig();
  if (!cfg || !cfg.repo || !cfg.token) { renderSetup(); return; }
  let client;
  try {
    client = createClient({ repo: cfg.repo, token: cfg.token, apiBase: apiBaseFor(location) });
  } catch (e) {
    renderSetup({ message: e.message });
    return;
  }
  sync = new Sync({
    client, storage: localStorage, storageKey: cfg.repo, onChange: onSyncChange, newUid: () => newId(8),
    nowMs: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id),
  });
  let started;
  try {
    started = await sync.start();
  } catch (e) {
    sync = null;
    renderSetup({ message: e.message });
    return;
  }
  if (!started.ready) { renderSetup({ empty: true }); return; }
  showApp(true);
  refreshView();
  render();
  renderStatus();
}

function buildIndex() {
  IX.skill = Object.fromEntries(S.skills.map((s) => [s.id, s]));
  IX.item = Object.fromEntries(S.items.map((i) => [i.id, i]));
  IX.ev = Object.fromEntries(S.evidence.map((e) => [e.id, e]));
  IX.cat = Object.fromEntries(S.cats.map((c) => [c.id, c.name]));
  IX.evBySkill = {};
  for (const e of S.evidence) for (const s of e.skills) (IX.evBySkill[s] ||= []).push(e);
  IX.itemsBySkill = {};
  for (const i of S.items) for (const s of i.skills) (IX.itemsBySkill[s] ||= []).push(i);
}

/* ---------- shared pieces ---------- */
function proofCard(e, { clamp = true, showSkills = true } = {}) {
  const conf = e.confidence ? `<span class="conf conf-${e.confidence}">Can explain: ${esc(CONF[e.confidence])}</span>` : "";
  const links = e.links.map((l) => `<a href="${esc(l)}" target="_blank" rel="noopener noreferrer">${esc(l.replace(/^https?:\/\//, ""))}</a>`);
  const files = e.files.map((f) => `<a href="#" data-act="openfile" data-path="${esc(f.path)}" data-name="${esc(f.name)}">${esc(f.name)}</a> <span class="muted">(${kb(f.size)})</span>`);
  const skills = showSkills && e.skills.length ? `<div class="ptags">${e.skills.map((s) => `<span>${esc(IX.skill[s] ? IX.skill[s].name : s)}</span>`).join("")}</div>` : "";
  return `<article class="pcard">
    <div class="row" style="justify-content:space-between;align-items:flex-start"><h4>${esc(e.title)}</h4>
      <button type="button" class="btn link no-print" data-act="editproof" data-id="${esc(e.id)}">Edit</button></div>
    <div class="pmeta"><span>${esc(fmt(e.date, { day: "numeric", month: "short", year: "numeric" }))}</span><span>${esc(KINDS[e.kind] || e.kind)}</span>${conf}</div>
    ${e.summary ? `<p class="psum${clamp ? " clamp" : ""}">${esc(e.summary)}</p>` : ""}
    ${links.length || files.length ? `<div class="plinks">${links.concat(files).map((x) => `<span>${x}</span>`).join("")}</div>` : ""}
    ${skills}
  </article>`;
}

function itemRow(i, mode) {
  const t = today();
  const late = !i.done && i.due < t;
  const n = i.evidence.length;
  let h = `<li class="it${i.done ? " done" : ""}${late ? " late" : ""}" data-item="${esc(i.id)}">`;
  h += `<input type="checkbox" data-act="toggle" aria-label="${i.done ? "Done" : "Mark done with proof"}"${i.done ? " checked" : ""}>`;
  h += `<span class="it-text" data-act="toggle">${esc(i.text)}</span><div class="it-meta">${tag(i.track)}`;
  if (mode === "plan") {
    h += `<label class="due">Due <input type="date" data-act="due" value="${esc(i.due)}"></label>`;
    if (late) h += `<span class="late-flag">Overdue</span>`;
    if (i.done && i.doneOn) h += `<span>Done ${esc(fmt(i.doneOn))}</span>`;
  } else if (mode === "late" || mode === "next") {
    h += `<span class="due-txt">Due ${esc(fmt(i.due))}</span>`;
  }
  h += n
    ? `<button type="button" class="btn link" data-act="showproof" aria-expanded="${!!ui.openProof[i.id]}">Proof (${n})</button>`
    : `<span class="proofcount none">No proof yet</span>`;
  h += `<button type="button" class="btn link" data-act="addproof">Add proof</button>`;
  h += `<button type="button" class="btn link" data-act="note" aria-expanded="${!!ui.openNotes[i.id]}">${i.note ? "Notes (saved)" : "Add notes"}</button>`;
  if (mode === "plan" && i.custom) h += `<button type="button" class="btn link danger" data-act="del">Remove</button>`;
  h += `</div>`;
  if (n && ui.openProof[i.id]) h += `<div class="plist">${i.evidence.map((id) => IX.ev[id]).filter(Boolean).map((e) => proofCard(e, { showSkills: false })).join("")}</div>`;
  h += `<textarea data-act="notetext" aria-label="Notes for this item"${ui.openNotes[i.id] ? "" : " hidden"} placeholder="Quick notes: links, what to repeat. Proof goes in Add proof.">${esc(i.note)}</textarea>`;
  return h + "</li>";
}

/* ---------- TODAY ---------- */
function renderToday() {
  const t = today(), d = parseD(t), dow = d.getDay();
  const w = weekOf(t);
  const s = sched();
  const blocks = s.blocks.filter((b) => b.days.includes(dow)).sort((a, b) => startMin(a) - startMin(b));
  const thisWeek = w ? S.items.filter((i) => i.w === w.n) : [];
  const openNow = (i) => !i.done && i.due >= t;
  const late = S.items.filter((i) => !i.done && i.due < t).sort(byDue);
  const withProof = S.skills.filter((sk) => IX.evBySkill[sk.id]).length;
  let h = `<h2>${esc(fmtLong(t))}</h2>`;
  if (w) h += `<p class="lede">Week ${w.n} of ${S.weeks.length}: ${esc(w.title)} (${esc(rangeTxt(w))}). Schedule in use: ${esc(s.name)}.</p>`;
  else if (t < S.plan.start) h += `<p class="lede">The plan starts on ${esc(fmtLong(S.plan.start))}.</p>`;
  else h += `<p class="lede">The plan ended on ${esc(fmt(S.plan.end, { day: "numeric", month: "long" }))}. Add new items in the Plan tab to keep going.</p>`;

  const bh = S.behind || { days: 0, items: 0 };
  if (bh.days > 0) {
    const dd = `${bh.days} study day${bh.days === 1 ? "" : "s"}`;
    h += `<div class="card behind"><h3>You're ${dd} behind</h3>`;
    h += `<p style="margin:6px 0 10px">${bh.items} open item${bh.items === 1 ? " is" : "s are"} past the due date. Pushing moves every open item and all later weeks ${dd} later. Nothing is skipped, and done items stay where they are.</p>`;
    h += `<button type="button" class="btn primary" data-act="push">Push the plan back ${dd}</button>`;
    h += `<ul class="items" style="margin-top:10px">${late.map((i) => itemRow(i, "late")).join("")}</ul></div>`;
  }

  h += `<div class="stats">`;
  if (w) h += `<div class="stat"><div class="l">This week, done with proof</div><div class="n">${doneCount(thisWeek)} / ${thisWeek.length}</div>${accBar(doneCount(thisWeek), thisWeek.length)}</div>`;
  h += `<div class="stat"><div class="l">Skills with proof</div><div class="n">${withProof} / ${S.skills.length}</div>${accBar(withProof, S.skills.length)}</div>`;
  const logged = S.log.find((e) => e.date === t);
  h += `<div class="stat"><div class="l">Today's log</div><div style="padding-top:6px">${logged ? "Written" + (logged.hours != null ? `, ${logged.hours} h` : "") : "Not written yet"}</div><button type="button" class="btn small" data-act="openlog" data-date="${t}" style="margin-top:6px">${logged ? "Edit today's log" : "Write today's log"}</button></div></div>`;

  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const used = {};
  if (!blocks.length) h += `<div class="card"><p class="empty">No study blocks on ${DAYS[dow]}.</p></div>`;
  for (const b of blocks) {
    used[b.track] = true;
    const mine = thisWeek.filter((i) => i.track === b.track);
    const open = mine.filter(openNow);
    const ahead = open.length ? [] : S.items.filter((i) => i.track === b.track && openNow(i) && (!w || i.w > w.n)).sort(byDue).slice(0, 1);
    const m1 = /^(\d{1,2}):(\d{2})$/.exec(b.start), m2 = /^(\d{1,2}):(\d{2})$/.exec(b.end);
    const isNow = m1 && m2 && nowMin >= +m1[1] * 60 + +m1[2] && nowMin < +m2[1] * 60 + +m2[2];
    h += `<div class="card block bl-${esc(b.track)}${isNow ? " now" : ""}"><div class="time">${esc(b.start)}${b.end ? " to " + esc(b.end) : ""}${isNow ? '<div class="muted" style="font-weight:400;font-size:.82rem">Now</div>' : ""}</div><div><h3>${esc(b.label)}</h3>`;
    if (b.track === "apps") h += `<p class="empty">Note the companies you applied to in today's log.</p>`;
    else {
      if (open.length) h += `<ul class="items">${open.map((i) => itemRow(i, "today")).join("")}</ul>`;
      if (ahead.length) h += `<p class="muted" style="margin:0 0 2px;font-size:.85rem">Nothing open for this block this week. Get ahead:</p><ul class="items">${ahead.map((i) => itemRow(i, "next")).join("")}</ul>`;
      if (!open.length && !ahead.length) h += `<p class="empty">Nothing left for this block.</p>`;
      const dn = doneCount(mine);
      if (dn) h += `<p class="hint" style="margin:6px 0 0">${dn} of ${mine.length} done this week.</p>`;
    }
    h += `</div></div>`;
  }
  const other = thisWeek.filter((i) => !used[i.track] && openNow(i));
  if (other.length) h += `<div class="card"><h3>Also this week</h3><ul class="items">${other.map((i) => itemRow(i, "today")).join("")}</ul></div>`;
  $("p-today").innerHTML = h;
}

/* ---------- PLAN ---------- */
function renderPlan() {
  const t = today(), cw = weekOf(t);
  let h = `<h2>12-week plan</h2><p class="lede">${esc(fmt(S.plan.start, { day: "numeric", month: "long" }))} to ${esc(fmt(S.plan.end, { day: "numeric", month: "long", year: "numeric" }))}. Twelve roadmap weeks and a buffer week, studying Monday to Friday. If you fall behind, Today offers to push the plan back. An item only counts as done once it has proof.</p>`;
  h += `<div class="trackbars">`;
  for (const tr of PLAN_TRACKS) {
    const list = S.items.filter((i) => i.track === tr), dn = doneCount(list);
    h += `<div><div class="tb-h">${tag(tr)}<span class="muted">${dn} / ${list.length}</span></div>${accBar(dn, list.length)}</div>`;
  }
  h += `</div><div class="row" style="margin-bottom:14px"><div class="chips" role="group" aria-label="Filter by area">`;
  h += `<button type="button" class="chip" data-act="ptrack" data-v="" aria-pressed="${ui.planTrack === ""}">All</button>`;
  for (const tr of PLAN_TRACKS) h += `<button type="button" class="chip" data-act="ptrack" data-v="${tr}" aria-pressed="${ui.planTrack === tr}">${esc(TRACKS[tr])}</button>`;
  h += `</div><label class="row" style="gap:6px"><input type="checkbox" data-act="hidedone"${ui.hideDone ? " checked" : ""}> Hide done</label>`;
  h += `<label class="row" style="gap:6px"><input type="checkbox" data-act="lateonly"${ui.lateOnly ? " checked" : ""}> Only overdue</label></div>`;
  for (const w of S.weeks) {
    const all = S.items.filter((i) => i.w === w.n);
    const list = all.filter((i) => (!ui.planTrack || i.track === ui.planTrack) && !(ui.hideDone && i.done) && !(ui.lateOnly && (i.done || i.due >= t))).sort(byDue);
    if ((ui.lateOnly || ui.hideDone) && !list.length) continue;
    const isCur = cw && cw.n === w.n;
    const isOpen = ui.openWeeks[w.n] !== undefined ? ui.openWeeks[w.n] : isCur;
    const dn = doneCount(all);
    h += `<details class="week${isCur ? " current" : ""}" data-week="${w.n}"${isOpen ? " open" : ""}>`;
    h += `<summary><span class="wk-n">Week ${w.n}</span><span><span class="wk-title">${esc(w.title)}</span><span class="wk-dates">${esc(rangeTxt(w))}${isCur ? ", this week" : ""}</span></span><span class="wk-count">${dn} of ${all.length} done${accBar(dn, all.length)}</span></summary><div class="wk-body">`;
    h += list.length ? `<ul class="items">${list.map((i) => itemRow(i, "plan")).join("")}</ul>` : `<p class="empty">Nothing matches this filter in this week.</p>`;
    const defDue = t >= w.start && t <= w.end ? t : w.start;
    h += `<div class="addrow" data-week="${w.n}"><input class="inp" type="text" data-add="text" placeholder="Add your own item to this week" aria-label="New item"><select class="inp" data-add="track" aria-label="Area">${PLAN_TRACKS.concat(["general"]).map((k) => `<option value="${k}"${k === (ui.planTrack || "cpp") ? " selected" : ""}>${esc(TRACKS[k])}</option>`).join("")}</select><input class="inp" type="date" data-add="due" value="${defDue}" aria-label="Due date"><button type="button" class="btn" data-act="additem">Add</button></div>`;
    h += `</div></details>`;
  }
  $("p-plan").innerHTML = h;
}

/* ---------- LOG ---------- */
function renderLog() {
  const t = today(), cw = weekOf(t);
  let weekHours = 0;
  for (const e of S.log) if (cw && e.date >= cw.start && e.date <= cw.end) weekHours += e.hours || 0;
  let h = `<h2>Daily log</h2><p class="lede">One entry per day: what you did in each block, the problems you solved, and your notes in any language. Proof you added that day shows under each entry.</p>`;
  h += `<div class="stats"><div class="stat"><div class="l">Days logged</div><div class="n">${S.log.length}</div></div><div class="stat"><div class="l">Hours this week</div><div class="n">${Math.round(weekHours * 10) / 10}</div></div><div class="stat"><div class="l">Proof entries</div><div class="n">${S.evidence.length}</div></div></div>`;
  if (ui.logEdit) {
    const e = ui.logEdit;
    h += `<div class="card" id="logform"><h3 style="margin-bottom:10px">${esc(fmtLong(e.date))}</h3><div class="grid2">`;
    h += `<label class="fld">Date<input type="date" data-log="date" value="${esc(e.date)}"></label>`;
    h += `<label class="fld">Hours spent<input type="number" min="0" max="24" step="0.25" data-log="hours" value="${e.hours ?? ""}"></label>`;
    for (const [k, label] of LOG_FIELDS) {
      const big = k === "notes";
      h += `<label class="fld${big || k === "stuck" ? " full" : ""}">${esc(label)}<textarea data-log="${k}" style="min-height:${big ? 160 : 64}px">${esc(e.data[k] || "")}</textarea></label>`;
    }
    h += `</div><div class="row" style="margin-top:12px"><button type="button" class="btn primary" data-act="logsave">Save entry</button><button type="button" class="btn" data-act="logcancel">Cancel</button>`;
    if (S.log.some((x) => x.date === e.date)) h += `<button type="button" class="btn danger" data-act="logdel" style="margin-left:auto">Delete entry</button>`;
    h += `</div></div>`;
  } else {
    h += `<div class="row" style="margin-bottom:12px"><button type="button" class="btn primary" data-act="openlog" data-date="${t}">${S.log.some((x) => x.date === t) ? "Edit today's entry" : "Write today's entry"}</button><label class="row" style="gap:6px">or open a day <input class="inp" style="width:auto" type="date" data-act="pickday" value="${t}"></label></div>`;
  }
  const days = [...new Set(S.log.map((e) => e.date).concat(S.evidence.map((e) => e.date)))].sort().reverse();
  h += `<div class="card">`;
  if (!days.length) h += `<p class="empty">No entries yet. Write the first one after today's blocks.</p>`;
  for (const day of days) {
    const e = S.log.find((x) => x.date === day);
    const proofs = S.evidence.filter((x) => x.date === day);
    h += `<div class="entry"><div class="row" style="justify-content:space-between"><strong>${esc(fmtLong(day))}</strong><span class="row"><span class="muted">${e && e.hours != null ? e.hours + " h" : ""}</span><button type="button" class="btn small" data-act="openlog" data-date="${esc(day)}">${e ? "Edit" : "Write log"}</button></span></div><dl>`;
    if (e) for (const [k, , short] of LOG_FIELDS) if (e.data[k]) h += `<dt>${esc(short)}</dt><dd>${esc(e.data[k])}</dd>`;
    if (proofs.length) h += `<dt>Proof added</dt><dd>${proofs.map((p) => `<button type="button" class="btn link" data-act="editproof" data-id="${esc(p.id)}">${esc(p.title)}</button>`).join("<br>")}</dd>`;
    h += `</dl></div>`;
  }
  h += `</div>`;
  $("p-log").innerHTML = h;
}

/* ---------- SKILLS AND PROOF ---------- */
function skillFacts(s) {
  const ev = IX.evBySkill[s.id] || [];
  const last = ev.reduce((m, e) => (e.date > m ? e.date : m), "");
  const best = ev.reduce((m, e) => Math.max(m, e.confidence || 0), 0);
  const items = IX.itemsBySkill[s.id] || [];
  return { ev, last, best, items, itemsDone: doneCount(items) };
}

function renderSkills() {
  const f = ui.sk;
  loadLearnIndex(); // for the Learn links in each open skill
  const facts = Object.fromEntries(S.skills.map((s) => [s.id, skillFacts(s)]));
  const withProof = S.skills.filter((s) => facts[s.id].ev.length).length;
  const topGaps = S.skills.filter((s) => s.priority === "P0" && !facts[s.id].ev.length).length;
  let h = `<h2>Skills and proof</h2><p class="lede">Every learning item from the roadmap, with the proof you've collected. Move a skill up its ladder only when your proof shows that step. Open a skill to see its proof and the plan items that train it.</p>`;
  h += `<div class="stats"><div class="stat"><div class="l">Skills with proof</div><div class="n">${withProof} / ${S.skills.length}</div>${accBar(withProof, S.skills.length)}</div><div class="stat"><div class="l">P0 without proof</div><div class="n">${topGaps}</div></div><div class="stat"><div class="l">Proof entries</div><div class="n">${S.evidence.length}</div></div></div>`;
  h += `<div class="row" style="margin-bottom:12px"><input class="inp" style="max-width:240px" type="search" data-sk="q" placeholder="Search skills" value="${esc(f.q)}" aria-label="Search skills">`;
  h += `<select class="inp" style="width:auto" data-sk="cat" aria-label="Category"><option value="">All categories</option>${S.cats.map((c) => `<option value="${c.id}"${f.cat === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`;
  h += `<select class="inp" style="width:auto" data-sk="prio" aria-label="Priority"><option value="">Any priority</option><option value="q1"${f.prio === "q1" ? " selected" : ""}>First 12 weeks (P0 and Awareness)</option>${PRIOS.slice(1).map((p) => `<option${f.prio === p ? " selected" : ""}>${p}</option>`).join("")}</select>`;
  h += `<select class="inp" style="width:auto" data-sk="proof" aria-label="Proof"><option value="">With or without proof</option><option value="yes"${f.proof === "yes" ? " selected" : ""}>Has proof</option><option value="no"${f.proof === "no" ? " selected" : ""}>No proof yet</option></select>`;
  h += `<select class="inp" style="width:auto" data-sk="sort" aria-label="Sort"><option value="prio"${f.sort === "prio" ? " selected" : ""}>By priority</option><option value="cat"${f.sort === "cat" ? " selected" : ""}>By category</option><option value="recent"${f.sort === "recent" ? " selected" : ""}>Recently worked on</option><option value="least"${f.sort === "least" ? " selected" : ""}>Least proof first</option></select></div>`;
  const q = f.q.trim().toLowerCase();
  let rows = S.skills.filter((s) => {
    if (f.cat && s.cat !== f.cat) return false;
    if (f.prio === "q1" ? s.priority !== "P0" && s.priority !== "Awareness" : f.prio && s.priority !== f.prio) return false;
    const n = facts[s.id].ev.length;
    if (f.proof === "yes" && !n) return false;
    if (f.proof === "no" && n) return false;
    if (q && ![s.name, s.plain, s.window, IX.cat[s.cat], s.note].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
  const catPos = Object.fromEntries(S.cats.map((c, k) => [c.id, k]));
  const cmp = {
    prio: (a, b) => PRANK[a.priority] - PRANK[b.priority] || catPos[a.cat] - catPos[b.cat],
    cat: (a, b) => catPos[a.cat] - catPos[b.cat],
    recent: (a, b) => (facts[b.id].last || "").localeCompare(facts[a.id].last || ""),
    least: (a, b) => facts[a.id].ev.length - facts[b.id].ev.length || PRANK[a.priority] - PRANK[b.priority],
  }[f.sort];
  rows = rows.slice().sort(cmp);
  h += `<div class="skl-cols no-print"><span>Skill</span><span>Priority</span><span class="hide-m">Status</span><span class="hide-m">Proof</span><span>Last proof</span></div>`;
  if (!rows.length) h += `<div class="card"><p class="empty">No skills match. Clear the search or change a filter.</p></div>`;
  for (const s of rows) {
    const x = facts[s.id], open = !!f.open[s.id];
    h += `<div class="skl p-${esc(s.priority || "none")} ${x.ev.length ? "has-proof" : "no-proof"}" data-skill="${esc(s.id)}">`;
    h += `<div class="skl-head" data-act="skillopen" role="button" tabindex="0" aria-expanded="${open}"><span class="sname">${esc(s.name)}<span class="scat">${esc(IX.cat[s.cat])}</span></span>`;
    h += `<span class="cell"><b>${esc(s.priority || "Not set")}</b></span><span class="cell hide-m">${esc(s.status)}</span>`;
    h += `<span class="cell hide-m">${x.ev.length ? `<b>${x.ev.length}</b> proof${x.ev.length > 1 ? "s" : ""}` : `<span class="nogap">None</span>`}</span>`;
    h += `<span class="cell">${x.last ? esc(fmt(x.last, { day: "numeric", month: "short" })) : "Not yet"}${x.best ? `<br><span class="conf conf-${x.best}">${esc(CONF[x.best])}</span>` : ""}</span></div>`;
    if (open) {
      h += `<div class="skl-body"><p style="margin:10px 0 4px">${esc(s.plain)}</p>`;
      h += `<p class="hint" style="margin:0 0 4px"><b>When:</b> ${esc(s.window)}</p>`;
      const topics = learnTopicsFor(s.id);
      if (topics.length) h += `<p class="hint" style="margin:0 0 4px"><b>Learn:</b> ${topics.map((t) => `<button type="button" class="btn link" data-act="learnopen" data-topic="${esc(t.id)}">${esc(t.title)}</button>`).join(", ")}</p>`;
      h += `<div class="grid3"><label class="fld">Status<select data-skf="status">${opts(ladderFor(s), s.status)}</select></label><label class="fld">Priority<select data-skf="priority">${opts(PRIOS, s.priority)}</select></label><label class="fld">Next action or open question<input type="text" data-skf="note" value="${esc(s.note)}" placeholder="Next step"></label></div>`;
      h += `<div class="row" style="justify-content:space-between;margin:6px 0"><h3>Proof (${x.ev.length})</h3><button type="button" class="btn small primary" data-act="addproofskill">Add proof for this skill</button></div>`;
      h += x.ev.length ? x.ev.map((e) => proofCard(e)).join("") : `<p class="empty">No proof yet. Add a repo link, a LeetCode solution, a PDF, a recording or a few paragraphs in your own words.</p>`;
      if (x.items.length) {
        h += `<h3 style="margin:12px 0 4px">Plan items that train this (${x.itemsDone} of ${x.items.length} done)</h3><ul class="items">${x.items.slice().sort(byDue).map((i) => itemRow(i, "next")).join("")}</ul>`;
      }
      h += `</div>`;
    }
    h += `</div>`;
  }
  $("p-skills").innerHTML = h;
}

/* ---------- PROOF LIBRARY ---------- */
function renderLibrary() {
  const f = ui.lib;
  let h = `<h2>Proof library</h2><p class="lede">Everything you've collected, newest first.</p>`;
  h += `<div class="row" style="margin-bottom:12px"><button type="button" class="btn primary" data-act="newproof">Add proof</button><input class="inp" style="max-width:240px" type="search" data-lib="q" placeholder="Search titles and notes" value="${esc(f.q)}" aria-label="Search proof">`;
  h += `<select class="inp" style="width:auto" data-lib="kind" aria-label="Kind"><option value="">Any kind</option>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${f.kind === k ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>`;
  h += `<select class="inp" style="width:auto;max-width:260px" data-lib="skill" aria-label="Skill"><option value="">Any skill</option>${S.skills.map((s) => `<option value="${s.id}"${f.skill === s.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>`;
  const q = f.q.trim().toLowerCase();
  const list = S.evidence.filter((e) => (!f.kind || e.kind === f.kind) && (!f.skill || e.skills.includes(f.skill)) &&
    (!q || [e.title, e.summary, ...e.links, ...e.files.map((x) => x.name)].join(" ").toLowerCase().includes(q)));
  h += list.length ? list.map((e) => proofCard(e)).join("") : `<div class="card"><p class="empty">${S.evidence.length ? "Nothing matches these filters." : "No proof yet. Tick a plan item or press Add proof."}</p></div>`;
  $("p-library").innerHTML = h;
}

/* ---------- SCHEDULE ---------- */
function renderSchedule() {
  if (!ui.schedDraft) { ui.schedDraft = JSON.parse(JSON.stringify(S.schedule)); ui.schedKey = S.schedule.active; }
  const D = ui.schedDraft, key = ui.schedKey in D.sets ? ui.schedKey : D.active, set = D.sets[key];
  const changed = JSON.stringify(D) !== JSON.stringify(S.schedule);
  let h = `<h2>Schedule</h2><p class="lede">Blocks for each weekday show on Today. Two versions are ready: 4 hours now, and 3 hours for when the German course starts.</p>`;
  h += `<p>In use: <b>${esc(D.sets[D.active].name)}</b></p><div class="chips" role="group" aria-label="Schedule to edit" style="margin-bottom:12px">`;
  for (const k of Object.keys(D.sets)) h += `<button type="button" class="chip" data-act="schedview" data-v="${esc(k)}" aria-pressed="${k === key}">${esc(D.sets[k].name)}</button>`;
  h += `</div><div class="row" style="margin-bottom:12px"><label class="fld" style="flex:1 1 260px;max-width:420px">Name of this schedule<input type="text" data-sched="name" value="${esc(set.name)}"></label>`;
  if (key !== D.active) h += `<button type="button" class="btn" data-act="schedactivate" style="align-self:end">Use this schedule</button>`;
  h += `</div><div class="tablebox"><table class="sched"><thead><tr><th>Days</th><th>Start</th><th>End</th><th>Block</th><th>Area</th><th></th></tr></thead><tbody>`;
  set.blocks.forEach((b, idx) => {
    h += `<tr data-block="${idx}"><td><div class="days">${[1, 2, 3, 4, 5, 6, 0].map((dn) => `<button type="button" class="day" data-act="blockday" data-v="${dn}" aria-pressed="${b.days.includes(dn)}">${DAYS[dn]}</button>`).join("")}</div></td>`;
    h += `<td style="width:90px"><input type="text" data-blk="start" value="${esc(b.start)}" aria-label="Start"></td><td style="width:90px"><input type="text" data-blk="end" value="${esc(b.end)}" aria-label="End"></td>`;
    h += `<td><input type="text" data-blk="label" value="${esc(b.label)}" aria-label="Block name"></td><td style="width:170px"><select data-blk="track" aria-label="Area">${Object.keys(TRACKS).map((k) => `<option value="${k}"${k === b.track ? " selected" : ""}>${esc(TRACKS[k])}</option>`).join("")}</select></td>`;
    h += `<td style="width:80px"><button type="button" class="btn small danger" data-act="blockdel">Remove</button></td></tr>`;
  });
  h += `</tbody></table></div><div class="row" style="margin-top:10px"><button type="button" class="btn" data-act="blockadd">Add block</button>`;
  h += `<button type="button" class="btn primary" data-act="schedsave"${changed ? "" : " disabled"}>Save schedule</button><button type="button" class="btn" data-act="schedundo"${changed ? "" : " disabled"}>Undo changes</button></div>`;
  h += `<p class="hint" style="margin-top:12px">Write times as 09:00. Today lists blocks in time order; blocks without a clock time, like Evening, come last. Items show inside a block with the same area; anything else due that day appears under "Also due today".</p>`;
  $("p-schedule").innerHTML = h;
}

/* ---------- LEARN ---------- */
// After a failure it waits for "Try again" (learnretry), so a render never starts a request loop.
async function loadLearnIndex() {
  if (LEARN.index || LEARN.loading || LEARN.error) return;
  LEARN.loading = true;
  LEARN.error = false;
  try {
    const r = await fetch("learn/index.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    LEARN.index = await r.json();
  } catch (e) {
    LEARN.error = true;
  }
  LEARN.loading = false;
  if (ui.tab === "learn" || ui.tab === "skills") render();
}

// LEARN.body[id] is "loading" or "error" while LEARN.bodies[id] is missing.
async function loadLearnBody(id) {
  if (LEARN.bodies[id] || LEARN.body[id] === "loading") return;
  LEARN.body[id] = "loading";
  try {
    const r = await fetch(`learn/${encodeURIComponent(id)}.json`, { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    LEARN.bodies[id] = await r.json();
    delete LEARN.body[id];
  } catch (e) {
    LEARN.body[id] = "error";
  }
  if (ui.tab === "learn" && ui.learn.topic === id) render();
}

const learnTopicsFor = (skillId) => (LEARN.index ? LEARN.index.topics.filter((t) => t.skills.includes(skillId)) : []);
const retryCard = (what) => `<div class="card"><p>${what} didn't load. Check the connection.</p><button type="button" class="btn small" data-act="learnretry">Try again</button></div>`;

function renderLearn() {
  const P = $("p-learn");
  if (!LEARN.index) {
    P.innerHTML = `<h2>Learn</h2>` + (LEARN.error ? retryCard("The Learn pages") : `<p class="muted">Loading the Learn pages…</p>`);
    loadLearnIndex();
    return;
  }
  const names = Object.fromEntries(S.skills.map((k) => [k.id, k.name]));
  const topic = ui.learn.topic ? LEARN.index.topics.find((t) => t.id === ui.learn.topic) : null;
  if (!topic) { P.innerHTML = renderLearnList(LEARN.index, names); return; }
  const body = LEARN.bodies[topic.id];
  if (topic.pending || body) { P.innerHTML = renderTopic(LEARN.index, topic, topic.pending ? null : body, names); return; }
  const head = `<button type="button" class="btn link" data-act="learnback">All topics</button><h2 class="ltopic">${esc(topic.title)}</h2>`;
  if (LEARN.body[topic.id] === "error") { P.innerHTML = head + retryCard("This topic"); return; }
  P.innerHTML = head + `<p class="muted">Loading…</p>`;
  loadLearnBody(topic.id);
}

/* ---------- tabs ---------- */
const RENDER = { today: renderToday, plan: renderPlan, learn: renderLearn, log: renderLog, skills: renderSkills, library: renderLibrary, schedule: renderSchedule };
function render() {
  if (!S) return;
  flushTyping(); // a note typed in the last moment is part of what gets drawn
  staleRender = false;
  $("loading").hidden = true;
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab));
  for (const k of Object.keys(RENDER)) $("p-" + k).hidden = k !== ui.tab;
  RENDER[ui.tab]();
}
function showTab(name) {
  ui.tab = RENDER[name] ? name : "today";
  try { sessionStorage.setItem("pb-tab", ui.tab); } catch (e) { /* ignore */ }
  render();
  window.scrollTo(0, 0);
}
// Re-render while keeping focus in a search box.
function rerenderKeepFocus(selector) {
  const el = document.querySelector(selector);
  const pos = el ? el.selectionStart : null;
  render();
  const again = document.querySelector(selector);
  if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* not text */ } }
}

/* =====================================================================
   Proof dialog
   ===================================================================== */
let draft = null;

function openProof({ evidence, item, skill } = {}) {
  if (evidence) {
    draft = {
      id: evidence.id, title: evidence.title, date: evidence.date, kind: evidence.kind, summary: evidence.summary,
      links: evidence.links.join("\n"), confidence: evidence.confidence, skills: new Set(evidence.skills),
      items: new Set(evidence.items), complete: true, files: evidence.files, removeFiles: new Set(), newFiles: [],
      skillQ: "", fromItem: null, uid: newId(8), fileEntries: new Map(),
    };
  } else {
    draft = {
      id: null, title: item ? item.text.slice(0, 200) : "",
      date: today(), kind: item ? KIND_FOR_TRACK[item.track] || "notes" : "notes", summary: "", links: "",
      confidence: 0, skills: new Set(item ? item.skills : skill ? [skill] : []), items: new Set(item ? [item.id] : []),
      complete: true, files: [], removeFiles: new Set(), newFiles: [], skillQ: "", fromItem: item ? item.id : null,
      evId: "e-" + newId(6), uid: newId(8), fileEntries: new Map(),
    };
  }
  $("proofDlgTitle").textContent = draft.id ? "Edit proof" : "Add proof";
  renderProofForm();
  $("proofDlg").showModal();
  const first = $("proofBody").querySelector("[data-pf=title]");
  if (first && !draft.id) first.focus();
}

function renderProofForm(errorMsg) {
  const d = draft;
  let h = `<p class="dlg-err" id="dlgErr"${errorMsg ? "" : " hidden"}>${esc(errorMsg || "")}</p>`;
  if (d.fromItem) {
    const recent = S.evidence.filter((e) => !e.items.includes(d.fromItem)).slice(0, 30);
    if (recent.length) {
      h += `<div class="card" style="padding:10px 12px"><label class="fld">Already have proof for this? Link it instead<select id="linkExisting"><option value="">Pick existing proof</option>${recent.map((e) => `<option value="${e.id}">${esc(fmt(e.date, { day: "numeric", month: "short" }))}: ${esc(e.title)}</option>`).join("")}</select></label><button type="button" class="btn small" data-act="linkexisting" style="margin-top:6px">Link and mark done</button></div>`;
    }
  }
  h += `<div class="grid2">`;
  h += `<label class="fld full">Title<input type="text" data-pf="title" maxlength="200" value="${esc(d.title)}" placeholder="For example: LRU cache template with tests" required></label>`;
  h += `<label class="fld">Date<input type="date" data-pf="date" value="${esc(d.date)}"></label>`;
  h += `<label class="fld">Kind of proof<select data-pf="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === d.kind ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`;
  h += `<label class="fld full">What you did, in your own words<textarea data-pf="summary" style="min-height:120px" placeholder="What you built or learned, the key idea, what you'd say in an interview. Any language.">${esc(d.summary)}</textarea></label>`;
  h += `<label class="fld full">Links, one per line (GitHub commit or repo, LeetCode, notes, video)<textarea data-pf="links" style="min-height:64px" placeholder="https://github.com/you/practice/commit/...">${esc(d.links)}</textarea></label>`;
  h += `<div class="fld full"><span>Files (PDF, images, audio, code; up to 25 MB each)</span><input type="file" id="pfFiles" multiple accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.log,.cpp,.hpp,.h,.py,.json,.csv,.mp3,.m4a,.wav,.ogg,.mp4,.webm,.mov,.zip,.docx,.pptx,.xlsx">`;
  if (d.files.length || d.newFiles.length) {
    h += `<ul class="filelist">`;
    for (const f of d.files) {
      const rm = d.removeFiles.has(f.id);
      h += `<li class="${rm ? "removed" : ""}"><span><a href="#" data-act="openfile" data-path="${esc(f.path)}" data-name="${esc(f.name)}">${esc(f.name)}</a> (${kb(f.size)})</span><button type="button" class="btn link" data-act="pfrm" data-id="${esc(f.id)}">${rm ? "Keep" : "Remove"}</button></li>`;
    }
    d.newFiles.forEach((f, k) => { h += `<li><span>${esc(f.name)} (${kb(f.size)}, new)</span><button type="button" class="btn link" data-act="pfdrop" data-k="${k}">Remove</button></li>`; });
    h += `</ul>`;
  }
  h += `</div>`;
  h += `<label class="fld">How well could you explain this in an interview?<select data-pf="confidence">${CONF.map((c, k) => `<option value="${k}"${k === d.confidence ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label><span></span>`;
  // skills
  h += `<div class="fld full"><span>Skills this proves (${d.skills.size})</span><div class="selchips">${[...d.skills].map((id) => `<span class="selchip">${esc(IX.skill[id] ? IX.skill[id].name : id)}<button type="button" data-act="pfskill" data-id="${esc(id)}" aria-label="Remove">×</button></span>`).join("")}</div>`;
  h += `<input class="inp" type="search" data-pf="skillQ" placeholder="Filter skills" value="${esc(d.skillQ)}" aria-label="Filter skills"><div class="pick" id="skillPick">${skillPickHtml()}</div></div>`;
  // items
  h += `<div class="fld full"><span>Plan items this finishes (${d.items.size})</span><ul class="filelist">${[...d.items].map((id) => IX.item[id]).filter(Boolean).map((i) => `<li><span>Week ${i.w}: ${esc(i.text)}</span><button type="button" class="btn link" data-act="pfitem" data-id="${esc(i.id)}">Remove</button></li>`).join("")}</ul>`;
  h += `<select class="inp" data-pf="additem" style="margin-top:6px" aria-label="Add plan item"><option value="">Add a plan item</option>${S.weeks.map((w) => `<optgroup label="Week ${w.n}: ${esc(w.title)}">${S.items.filter((i) => i.w === w.n && !d.items.has(i.id)).map((i) => `<option value="${i.id}">${i.done ? "(done) " : ""}${esc(i.text.slice(0, 90))}</option>`).join("")}</optgroup>`).join("")}</select>`;
  h += `<label class="row" style="gap:6px;margin-top:6px"><input type="checkbox" data-pf="complete"${d.complete ? " checked" : ""}> Mark these plan items as done</label></div>`;
  h += `</div>`;
  $("proofBody").innerHTML = h;
  $("proofFoot").innerHTML = `<button type="button" class="btn primary" data-act="pfsave">Save proof</button><button type="button" class="btn" data-act="dlgclose">Cancel</button>${d.id ? `<button type="button" class="btn danger" data-act="pfdelete" style="margin-left:auto">Delete proof</button>` : ""}`;
}

function skillPickHtml() {
  const q = draft.skillQ.trim().toLowerCase();
  let h = "";
  for (const c of S.cats) {
    const list = S.skills.filter((s) => s.cat === c.id && (!q || (s.name + " " + c.name).toLowerCase().includes(q)));
    if (!list.length) continue;
    h += `<h5>${esc(c.name)}</h5>` + list.map((s) => `<label><input type="checkbox" data-act="pfskillbox" value="${s.id}"${draft.skills.has(s.id) ? " checked" : ""}>${esc(s.name)}</label>`).join("");
  }
  return h || `<p class="empty">No skill matches.</p>`;
}

function readProofForm() {
  const b = $("proofBody");
  const v = (k) => b.querySelector(`[data-pf=${k}]`);
  draft.title = v("title").value;
  draft.date = v("date").value;
  draft.kind = v("kind").value;
  draft.summary = v("summary").value;
  draft.links = v("links").value;
  draft.confidence = +v("confidence").value;
  draft.complete = v("complete").checked;
}

async function saveProof() {
  readProofForm();
  const d = draft;
  const links = d.links.split(/\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
  const keptFiles = d.files.filter((f) => !d.removeFiles.has(f.id)).length + d.newFiles.length;
  let err = "";
  if (!d.title.trim()) err = "Give the proof a short title.";
  else if (!d.date) err = "Pick the date you did this.";
  else if (links.some((l) => !/^https?:\/\//i.test(l))) err = "Links must start with https:// or http://";
  else if (!links.length && !keptFiles && d.summary.trim().length < 40) err = "Proof needs a link, a file, or a few sentences in your own words about what you did.";
  else if (!d.skills.size && !d.items.size) err = "Pick at least one skill or plan item this proves.";
  if (err) { renderProofForm(err); return; }
  const meta = {
    title: d.title, date: d.date, kind: d.kind, summary: d.summary, links, confidence: d.confidence,
    skills: [...d.skills], items: [...d.items], complete: d.complete, removeFiles: [...d.removeFiles],
  };
  const files = d.newFiles.map((f) => {
    if (!d.fileEntries.has(f)) {
      const ext = safeExtension(f.name);
      d.fileEntries.set(f, { id: "f-" + newId(6), path: `files/${newId(12)}${ext ? "." + ext : ""}`, name: cleanFileName(f.name), size: f.size });
    }
    return d.fileEntries.get(f);
  });
  const at = new Date().toISOString();
  const op = d.id
    ? { type: "updateEvidence", id: d.id, meta, files, at, uid: d.uid }
    : { type: "addEvidence", id: d.evId, meta, files, at, uid: d.uid };
  const btn = $("proofFoot").querySelector("[data-act=pfsave]");
  btn.disabled = true; btn.textContent = files.length ? "Uploading…" : "Saving…";
  try {
    let result;
    if (files.length) {
      const bytes = await Promise.all(d.newFiles.map((f) => f.arrayBuffer()));
      result = await sync.commitWithFiles(op, files.map((f, k) => ({ path: f.path, bytes: new Uint8Array(bytes[k]) })));
    } else {
      result = sync.enqueue(op);
    }
    $("proofDlg").close();
    refreshView();
    render();
    toast(result && result.duplicate
      ? "This proof was already saved before the connection dropped. Open it from the library to change it."
      : "Proof saved");
  } catch (e) {
    renderProofForm(e.message);
  }
}

/* =====================================================================
   Events
   ===================================================================== */
// Typed notes become one change per pause in typing; sync.js spaces out the commits.
const quietly = (op) => { try { change(op, { urgent: false }); } catch (e) { toast(e.message, true); } };
const saveItemNote = debounce((id, text) => quietly({ type: "patchItem", id, body: { note: text } }), 700);
const saveSkillNote = debounce((id, text) => quietly({ type: "patchSkill", id, body: { note: text } }), 700);
// Turns typed notes into waiting changes now, which also stores them in the browser.
function flushTyping() {
  saveItemNote.flush();
  saveSkillNote.flush();
}
const scheduleEdited = () => !!(S && ui.schedDraft && JSON.stringify(ui.schedDraft) !== JSON.stringify(S.schedule));

document.addEventListener("click", async (e) => {
  const tabBtn = e.target.closest(".tab");
  if (tabBtn) { showTab(tabBtn.dataset.tab); return; }
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const a = el.dataset.act;
  const li = el.closest("[data-item]");
  const item = li ? IX.item[li.dataset.item] : null;
  const t = today();
  switch (a) {
    case "toggle":
      e.preventDefault();
      if (!item) return;
      if (item.done) {
        if (confirm("Mark this as not done? Its proof stays in the library.")) act(() => change({ type: "patchItem", id: item.id, body: { done: false } }));
      } else if (item.evidence.length) {
        act(() => change({ type: "patchItem", id: item.id, body: { done: true, doneOn: t } }), "Marked done");
      } else openProof({ item });
      break;
    case "addproof": openProof({ item }); break;
    case "showproof": ui.openProof[item.id] = !ui.openProof[item.id]; render(); break;
    case "note": {
      ui.openNotes[item.id] = !ui.openNotes[item.id];
      const ta = li.querySelector("textarea");
      ta.hidden = !ui.openNotes[item.id];
      el.setAttribute("aria-expanded", String(ui.openNotes[item.id]));
      if (!ta.hidden) ta.focus();
      break;
    }
    case "push": act(() => change({ type: "pushPlan", today: t }), "Plan pushed back. Nothing was skipped."); break;
    case "del": if (confirm("Remove this item?")) act(() => change({ type: "deleteItem", id: item.id })); break;
    case "ptrack": ui.planTrack = el.dataset.v; render(); break;
    case "additem": {
      const row = el.closest(".addrow");
      const text = row.querySelector("[data-add=text]").value.trim();
      if (!text) { row.querySelector("[data-add=text]").focus(); return; }
      const wn = +row.dataset.week;
      ui.openWeeks[wn] = true;
      act(() => change({ type: "addItem", id: "u-" + newId(6), body: { week: wn, track: row.querySelector("[data-add=track]").value, text, due: row.querySelector("[data-add=due]").value } }), "Item added");
      break;
    }
    case "openlog": {
      const date = el.dataset.date || t;
      const ex = S.log.find((x) => x.date === date);
      ui.logEdit = ex ? { date, hours: ex.hours, data: { ...ex.data } } : { date, hours: null, data: {} };
      if (ui.tab !== "log") showTab("log"); else render();
      const f = $("logform"); if (f) f.scrollIntoView({ block: "start" });
      break;
    }
    case "logcancel": ui.logEdit = null; render(); break;
    case "logsave": {
      const L = ui.logEdit;
      if (!L.date) { toast("Pick a date for the entry.", true); return; }
      const hours = L.hours === "" || L.hours == null ? null : Number(L.hours);
      if (act(() => change({ type: "putLog", date: L.date, body: { hours, data: L.data } }), "Log saved")) { ui.logEdit = null; render(); }
      break;
    }
    case "logdel":
      if (confirm("Delete this log entry?")) {
        const date = ui.logEdit.date;
        if (act(() => change({ type: "deleteLog", date }), "Entry deleted")) { ui.logEdit = null; render(); }
      }
      break;
    case "newproof": openProof({}); break;
    case "editproof": { const ev = IX.ev[el.dataset.id]; if (ev) openProof({ evidence: ev }); break; }
    case "skillopen": { const id = el.closest("[data-skill]").dataset.skill; ui.sk.open[id] = !ui.sk.open[id]; render(); break; }
    case "addproofskill": openProof({ skill: el.closest("[data-skill]").dataset.skill }); break;
    case "learnopen":
      ui.learn.topic = el.dataset.topic;
      if (ui.tab !== "learn") showTab("learn"); else { render(); window.scrollTo(0, 0); }
      break;
    case "learnback": ui.learn.topic = null; render(); window.scrollTo(0, 0); break;
    case "learnretry": LEARN.error = false; if (ui.learn.topic) delete LEARN.body[ui.learn.topic]; render(); break;
    case "schedview": ui.schedKey = el.dataset.v; render(); break;
    case "schedactivate": ui.schedDraft.active = ui.schedKey; render(); break;
    case "blockday": {
      const b = ui.schedDraft.sets[ui.schedKey].blocks[+el.closest("[data-block]").dataset.block];
      const dv = +el.dataset.v;
      b.days = b.days.includes(dv) ? b.days.filter((x) => x !== dv) : b.days.concat([dv]);
      render();
      break;
    }
    case "blockdel": ui.schedDraft.sets[ui.schedKey].blocks.splice(+el.closest("[data-block]").dataset.block, 1); render(); break;
    case "blockadd": ui.schedDraft.sets[ui.schedKey].blocks.push({ id: "b" + Date.now().toString(36), days: [1, 2, 3, 4, 5], start: "", end: "", label: "New block", track: "general" }); render(); break;
    case "schedsave": {
      const D = ui.schedDraft;
      if (act(() => change({ type: "putSchedule", body: D }), "Schedule saved")) { ui.schedDraft = null; render(); }
      break;
    }
    case "schedundo": ui.schedDraft = null; render(); break;
    // dialog
    case "dlgclose": $("proofDlg").close(); break;
    case "pfsave": saveProof(); break;
    case "pfdelete":
      if (confirm("Delete this proof and its files? Plan items with no other proof go back to not done.")) {
        const id = draft.id;
        $("proofDlg").close();
        act(() => change({ type: "deleteEvidence", id }), "Proof deleted");
      }
      break;
    case "pfrm": readProofForm(); { const id = el.dataset.id; if (draft.removeFiles.has(id)) draft.removeFiles.delete(id); else draft.removeFiles.add(id); } renderProofForm(); break;
    case "pfdrop": readProofForm(); draft.newFiles.splice(+el.dataset.k, 1); renderProofForm(); break;
    case "pfskill": readProofForm(); draft.skills.delete(el.dataset.id); renderProofForm(); break;
    case "pfitem": readProofForm(); draft.items.delete(el.dataset.id); renderProofForm(); break;
    case "linkexisting": {
      const sel = $("linkExisting");
      if (!sel.value) { sel.focus(); return; }
      const itemId = draft.fromItem;
      $("proofDlg").close();
      act(() => change({ type: "linkEvidence", evidence: sel.value, item: itemId, complete: true }), "Linked and marked done");
      break;
    }
    case "openfile": e.preventDefault(); openFile(el.dataset.path, el.dataset.name); break;
    case "retrysave": sync.flush().catch((err) => toast(err.message, true)); break;
    case "dismissrejected": sync.dismissRejected(); break;
    case "export": exportData(); break;
    case "forget": forgetDevice(); break;
    case "connect": {
      const repo = $("setupRepo").value.trim(), token = $("setupToken").value.trim();
      if (!repo || !token) { toast("Enter the repository and the token.", true); return; }
      try { localStorage.setItem(CONFIG_KEY, JSON.stringify({ repo, token })); } catch (err) { toast("This browser won't store the token. Private browsing may block it.", true); return; }
      el.disabled = true; el.textContent = "Connecting…";
      boot();
      break;
    }
    case "startroadmap": {
      el.disabled = true; el.textContent = "Creating…";
      try {
        const seed = await fetch("seed.json", { cache: "no-store" }).then((r) => r.json());
        await sync.initialize(seedToState(seed));
        showApp(true);
        refreshView();
        render();
        renderStatus();
        toast("Your plan is ready");
      } catch (err) {
        renderSetup({ empty: true, message: err.message });
      }
      break;
    }
    default: break;
  }
});

document.addEventListener("keydown", (e) => {
  const head = e.target.closest && e.target.closest(".skl-head");
  if (head && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); head.click(); }
});

document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.classList && d.classList.contains("week")) ui.openWeeks[+d.dataset.week] = d.open;
}, true);

document.addEventListener("change", (e) => {
  const el = e.target, a = el.dataset.act;
  const li = el.closest("[data-item]");
  if (a === "due" && li && el.value) { act(() => change({ type: "patchItem", id: li.dataset.item, body: { due: el.value } })); return; }
  if (a === "hidedone") { ui.hideDone = el.checked; render(); return; }
  if (a === "lateonly") { ui.lateOnly = el.checked; render(); return; }
  if (a === "pickday" && el.value) {
    const ex = S.log.find((x) => x.date === el.value);
    ui.logEdit = ex ? { date: el.value, hours: ex.hours, data: { ...ex.data } } : { date: el.value, hours: null, data: {} };
    render();
    return;
  }
  if (el.dataset.sk && el.dataset.sk !== "q") { ui.sk[el.dataset.sk] = el.value; render(); return; }
  const skf = el.dataset.skf;
  if (skf && skf !== "note") {
    const id = el.closest("[data-skill]").dataset.skill;
    act(() => change({ type: "patchSkill", id, body: { [skf]: el.value } }));
    return;
  }
  if (el.dataset.lib && el.dataset.lib !== "q") { ui.lib[el.dataset.lib] = el.value; render(); return; }
  if (el.dataset.blk === "track") { ui.schedDraft.sets[ui.schedKey].blocks[+el.closest("[data-block]").dataset.block].track = el.value; render(); return; }
  // dialog
  if (el.id === "pfFiles") {
    readProofForm();
    const tooBig = [];
    for (const f of el.files) { if (f.size > MAX_FILE) tooBig.push(f.name); else draft.newFiles.push(f); }
    renderProofForm(tooBig.length ? `Too large (over 25 MB): ${tooBig.join(", ")}` : undefined);
    return;
  }
  if (a === "pfskillbox") {
    if (el.checked) draft.skills.add(el.value); else draft.skills.delete(el.value);
    readProofForm();
    const pos = $("skillPick").scrollTop;
    renderProofForm();
    $("skillPick").scrollTop = pos;
    return;
  }
  if (el.dataset.pf === "additem" && el.value) {
    readProofForm();
    draft.items.add(el.value);
    const it = IX.item[el.value];
    if (it) for (const s of it.skills) draft.skills.add(s);
    renderProofForm();
  }
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.act === "notetext") { const id = el.closest("[data-item]").dataset.item; saveItemNote(id, el.value); return; }
  if (el.dataset.log && ui.logEdit) {
    if (el.dataset.log === "date") { ui.logEdit.date = el.value; return; }
    if (el.dataset.log === "hours") { ui.logEdit.hours = el.value; return; }
    if (el.value) ui.logEdit.data[el.dataset.log] = el.value; else delete ui.logEdit.data[el.dataset.log];
    return;
  }
  if (el.dataset.sk === "q") { ui.sk.q = el.value; rerenderKeepFocus("[data-sk=q]"); return; }
  if (el.dataset.lib === "q") { ui.lib.q = el.value; rerenderKeepFocus("[data-lib=q]"); return; }
  if (el.dataset.skf === "note") { saveSkillNote(el.closest("[data-skill]").dataset.skill, el.value); return; }
  if (el.dataset.blk && el.tagName === "INPUT") { ui.schedDraft.sets[ui.schedKey].blocks[+el.closest("[data-block]").dataset.block][el.dataset.blk] = el.value; refreshSchedButtons(); return; }
  if (el.dataset.sched === "name") { ui.schedDraft.sets[ui.schedKey].name = el.value; refreshSchedButtons(); return; }
  if (el.dataset.pf === "skillQ") { draft.skillQ = el.value; $("skillPick").innerHTML = skillPickHtml(); }
});

function refreshSchedButtons() {
  const changed = JSON.stringify(ui.schedDraft) !== JSON.stringify(S.schedule);
  for (const k of ["schedsave", "schedundo"]) { const b = document.querySelector(`[data-act=${k}]`); if (b) b.disabled = !changed; }
}

async function openFile(path, name) {
  const type = openableType(path);
  // Open the window during the click, or phones block it; fill it once the file has arrived.
  const win = type ? window.open("", "_blank") : null;
  if (win) win.opener = null;
  try {
    const bytes = await sync.client.fetchFile(path);
    const url = URL.createObjectURL(new Blob([bytes], { type: type || "application/octet-stream" }));
    if (win) {
      win.location.href = url;
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    if (win) win.close();
    toast(err.message, true);
  }
}

function exportData() {
  const blob = new Blob([JSON.stringify(sync.state, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `proofboard-export-${today()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function forgetDevice() {
  const n = sync ? sync.status.pending : 0;
  const warning = n
    ? `${n} change${n === 1 ? " is" : "s are"} not saved yet and will be lost. Forget this device anyway?`
    : "Remove the token and the saved copy from this browser? Your data stays in the repository.";
  if (!confirm(warning)) return;
  if (sync) sync.forget();
  try { localStorage.removeItem(CONFIG_KEY); } catch (e) { /* storage unavailable */ }
  location.reload();
}

window.addEventListener("beforeunload", (e) => {
  flushTyping();
  if (ui.logEdit || $("proofDlg").open || scheduleEdited() || (sync && sync.status.pending)) { e.preventDefault(); e.returnValue = ""; }
});
window.addEventListener("pagehide", flushTyping);

// Leaving the page saves now; coming back checks for changes from the other device.
document.addEventListener("visibilitychange", () => {
  if (!sync || !sync.state) return;
  if (document.visibilityState === "hidden") { flushTyping(); sync.flush().catch(() => {}); return; }
  if ($("proofDlg").open || ui.logEdit) return;
  sync.refreshIfChanged().catch(() => {});
});
window.addEventListener("online", () => { if (sync && sync.state) sync.flush().catch(() => {}); });

// A note field losing focus stores its text as a waiting change at once (sync.js still spaces the commits
// 15 seconds apart), and shows changes that arrived while typing.
document.addEventListener("focusout", () => {
  if (!sync || !sync.state) return;
  flushTyping();
  setTimeout(() => { if (staleRender && !typing() && !$("proofDlg").open && !ui.logEdit) render(); }, 0);
});

// Keep Today current if the page stays open past midnight or across blocks.
setInterval(() => {
  if (S && ui.tab === "today" && !$("proofDlg").open && !typing()) {
    if (today() !== viewFor) refreshView();
    renderToday();
  }
}, 5 * 60 * 1000);

$("proofForm").addEventListener("submit", (e) => e.preventDefault());

boot().catch((e) => { $("loading").textContent = e.message; });
