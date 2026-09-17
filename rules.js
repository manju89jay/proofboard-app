// Proofboard rules: every change to the data goes through apply(state, op).
// Pure functions only. Time, today's date and ids arrive inside the operation, so the same
// operation applied to the same state always gives the same result. Ported from the C++
// store (src/store.cpp) and helpers (src/util.cpp) that this replaces.

// ---------- errors ----------

// Bad input. The message is shown to the user as-is.
export class ValidationError extends Error {}
export class NotFound extends Error {}

// ---------- allowed values ----------

export const TRACKS = ["cpp", "dsa", "concepts", "project", "review", "apps", "general"];
export const KINDS = ["code", "leetcode", "notes", "doc", "recording", "design", "mock", "other"];
export const LEARNING_LADDER = ["Not started", "Studied", "Implemented with help",
  "Independent implementation", "Delayed re-test passed"];
export const CONTRIBUTION_LADDER = ["Not started", "Reproduced", "Patch/tests", "Submitted", "Review", "Accepted"];
export const OPEN_SOURCE_CATEGORY = "oss";
export const PRIORITIES = ["", "P0", "P1", "P2", "Awareness"];
export const LOG_FIELDS = ["cpp", "dsa", "concepts", "project", "apps", "notes", "stuck"];
export const MIN_SUMMARY_BYTES = 40;
export const FORMAT = "proofboard-2";
// Ids of the newest applied changes, so a change delivered twice has its effect once.
export const APPLIED_KEEP = 1000;

// ---------- text ----------

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const byteLength = (s) => encoder.encode(s).length;
const WHITESPACE = " \t\r\n";

// Trims spaces, tabs and line breaks, then cuts to at most `maxBytes` UTF-8 bytes
// without splitting a character.
export function clip(s, maxBytes) {
  let b = 0, e = s.length;
  while (b < e && WHITESPACE.includes(s[b])) b++;
  while (e > b && WHITESPACE.includes(s[e - 1])) e--;
  const bytes = encoder.encode(s.slice(b, e));
  if (bytes.length <= maxBytes) return s.slice(b, e);
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return decoder.decode(bytes.subarray(0, cut));
}

// Lowercase hex from the given random bytes (the caller supplies the randomness).
export function hexId(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- dates: whole days since 1970-01-01, integers only ----------

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// True for YYYY-MM-DD with a month 1-12 and a day 1-31.
export function isDate(s) {
  if (typeof s !== "string" || !DATE_SHAPE.test(s)) return false;
  const month = Number(s.slice(5, 7)), dayOfMonth = Number(s.slice(8, 10));
  return month >= 1 && month <= 12 && dayOfMonth >= 1 && dayOfMonth <= 31;
}

// Day number for a real calendar date, or null for text like 2026-02-31.
export function parseDate(s) {
  if (!isDate(s)) return null;
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return ms / 86400000;
}

export function formatDate(dayNumber) {
  return new Date(dayNumber * 86400000).toISOString().slice(0, 10);
}

// Study days are Monday to Friday. There is no holiday calendar.
const isStudyDay = (dayNumber) => {
  const weekday = (((dayNumber + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0 is Sunday
  return weekday !== 0 && weekday !== 6;
};

// Moves forward `n` study days (n >= 0). A weekend date plus 1 is the next Monday.
export function addStudyDays(dayNumber, n) {
  let d = dayNumber;
  while (n > 0) {
    d += 1;
    if (isStudyDay(d)) n -= 1;
  }
  return d;
}

// The day itself if it is a study day, otherwise the following Monday.
export function nextStudyDay(dayNumber) {
  let d = dayNumber;
  while (!isStudyDay(d)) d += 1;
  return d;
}

// How many study days fall after `from`, up to and including `to`. 0 if `to` is not after `from`.
export function studyDaysBetween(from, to) {
  let count = 0;
  for (let d = from + 1; d <= to; d += 1) if (isStudyDay(d)) count += 1;
  return count;
}

// ---------- file names ----------

const isAsciiAlnum = (c) => /^[A-Za-z0-9]$/.test(c);

// Lowercase extension, letters and digits only, at most 8 characters. Empty if none.
export function safeExtension(filename) {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot + 1 >= filename.length) return "";
  let ext = "";
  for (const c of filename.slice(dot + 1)) {
    if (!isAsciiAlnum(c)) return "";
    ext += c.toLowerCase();
    if (ext.length > 8) return "";
  }
  return ext;
}

// Strips path parts and control characters from an uploaded file name.
export function cleanFileName(filename) {
  const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  let name = slash >= 0 ? filename.slice(slash + 1) : filename;
  name = Array.from(name).filter((c) => c.charCodeAt(0) >= 0x20 && c !== '"' && c !== "\x7f").join("");
  name = clip(name, 200);
  return name === "" ? "file" : name;
}

// True if the name only uses [A-Za-z0-9._-], has no "..", and is at most 80 characters.
export function isSafeStoredName(name) {
  return name.length > 0 && name.length <= 80 && !name.includes("..") && /^[A-Za-z0-9._-]+$/.test(name);
}

const MIME = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  cpp: "text/plain; charset=utf-8", hpp: "text/plain; charset=utf-8", h: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8", json: "application/json",
  csv: "text/csv; charset=utf-8", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function mimeFor(filename) {
  return MIME[safeExtension(filename)] || "application/octet-stream";
}

// The type a file may be shown with inside the page, or null when it must be downloaded.
// Only types that cannot run script: PDF, raster images, plain text and audio.
const OPENABLE = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "txt", "md", "cpp", "hpp", "h", "py", "log",
  "mp3", "m4a", "wav", "ogg"]);
export function openableType(filename) {
  const ext = safeExtension(filename);
  return OPENABLE.has(ext) ? MIME[ext] : null;
}

// ---------- input helpers (same messages as the C++ server) ----------

const has = (obj, key) => obj !== null && typeof obj === "object" && Object.hasOwn(obj, key) && obj[key] !== null && obj[key] !== undefined;

function str(obj, key, max, fallback = "") {
  if (!has(obj, key)) return fallback;
  if (typeof obj[key] !== "string") throw new ValidationError(`Field '${key}' must be text.`);
  return clip(obj[key], max);
}

function strList(obj, key, maxItems, maxLen) {
  if (!has(obj, key)) return [];
  if (!Array.isArray(obj[key])) throw new ValidationError(`Field '${key}' must be a list.`);
  const out = [];
  for (const v of obj[key]) {
    if (typeof v !== "string") throw new ValidationError(`Field '${key}' must be a list of text.`);
    const s = clip(v, maxLen);
    if (s !== "" && !out.includes(s)) out.push(s);
  }
  if (out.length > maxItems) throw new ValidationError(`Too many entries in '${key}'.`);
  return out;
}

const isHttpLink = (s) => s.startsWith("https://") || s.startsWith("http://");

function requireToday(today) {
  const d = parseDate(today);
  if (d === null) throw new ValidationError("Send today's date as YYYY-MM-DD.");
  return d;
}

function storedDate(text) {
  const d = parseDate(text);
  if (d === null) throw new Error(`stored date is not a real date: ${text}`);
  return d;
}

// ---------- state ----------

// The data kept in the repository. Array order is the stored position.
export function seedToState(seed) {
  return {
    format: FORMAT,
    plan: structuredClone(seed.plan),
    schedule: structuredClone(seed.schedule),
    cats: seed.cats.map((c) => ({ id: c.id, name: c.name })),
    skills: seed.skills.map((s) => ({
      id: s.id, cat: s.cat, name: s.skill, plain: s.plain ?? "", window: s.window ?? "",
      status: "Not started", priority: s.priority ?? "", note: "",
    })),
    weeks: seed.weeks.map((w) => ({ n: w.n, start: w.start, end: w.end, title: w.title })),
    items: seed.items.map((i) => ({
      id: i.id, w: i.w, track: i.track, text: i.text, due: i.due, done: false, doneOn: "", note: "",
      custom: false, skills: [...new Set(i.skills ?? [])],
    })),
    evidence: [],
    log: [],
    applied: [],
  };
}

const findItem = (s, id) => s.items.find((i) => i.id === id);
const findSkill = (s, id) => s.skills.find((k) => k.id === id);
const findEvidence = (s, id) => s.evidence.find((e) => e.id === id);
const itemHasProof = (s, itemId) => s.evidence.some((e) => e.items.includes(itemId));

// ---------- behind and push ----------

function behindOf(state, todayDay) {
  const today = formatDate(todayDay);
  const late = state.items.filter((i) => !i.done && i.due < today);
  if (!late.length) return { oldest: "", days: 0, items: 0 };
  const oldest = late.reduce((m, i) => (i.due < m ? i.due : m), late[0].due);
  return { oldest, days: studyDaysBetween(storedDate(oldest), nextStudyDay(todayDay)), items: late.length };
}

// {days, items}: how many study days the oldest late open item is behind, and how many open items are late.
export function behind(state, today) {
  const b = behindOf(state, requireToday(today));
  return { days: b.days, items: b.items };
}

function pushPlan(s, today) {
  const b = behindOf(s, requireToday(today));
  if (b.days === 0) return { days: 0, moved: 0 };
  const moved = (date) => formatDate(addStudyDays(storedDate(date), b.days));
  const shifted = (date) => (date < b.oldest ? date : moved(date));
  let count = 0;
  for (const i of s.items) {
    if (!i.done && i.due >= b.oldest) {
      i.due = moved(i.due);
      count += 1;
    }
  }
  // A week's end and the next week's start move together, and only when that next start is on or
  // after the oldest late date. The first week's start never moves, so today can't fall before the plan.
  const weeks = [...s.weeks].sort((a, c) => a.n - c.n);
  const updates = weeks.map((w, k) => {
    const last = k + 1 === weeks.length;
    const moveEnd = (last ? w.end : weeks[k + 1].start) >= b.oldest;
    const moveStart = k > 0 && w.start >= b.oldest;
    return { w, start: moveStart ? moved(w.start) : w.start, end: moveEnd ? moved(w.end) : w.end };
  });
  for (const u of updates) {
    u.w.start = u.start;
    u.w.end = u.end;
  }
  if (s.plan && typeof s.plan.end === "string") s.plan.end = shifted(s.plan.end);
  return { days: b.days, moved: count };
}

// ---------- plan items ----------

function addItem(s, op) {
  const body = op.body ?? {};
  const text = str(body, "text", 500);
  const track = str(body, "track", 20);
  const due = str(body, "due", 10);
  if (text === "") throw new ValidationError("Write what the item is.");
  if (!TRACKS.includes(track)) throw new ValidationError("Pick an area for the item.");
  if (parseDate(due) === null) throw new ValidationError("Pick a due date.");
  if (!Number.isInteger(body.week)) throw new ValidationError("Missing week.");
  if (!s.weeks.some((w) => w.n === body.week)) throw new ValidationError("That week doesn't exist.");
  const skills = strList(body, "skills", 30, 60);
  for (const k of skills) if (!findSkill(s, k)) throw new ValidationError(`Unknown skill: ${k}`);
  if (typeof op.id !== "string" || op.id === "" || findItem(s, op.id)) throw new ValidationError("The new item needs a fresh id.");
  s.items.push({ id: op.id, w: body.week, track, text, due, done: false, doneOn: "", note: "", custom: true, skills });
  return { id: op.id };
}

function patchItem(s, op) {
  const item = findItem(s, op.id);
  if (!item) throw new NotFound("Item not found.");
  const body = op.body ?? {};
  if (Object.hasOwn(body, "due")) {
    const due = str(body, "due", 10);
    if (parseDate(due) === null) throw new ValidationError("Pick a valid due date.");
    item.due = due;
  }
  if (Object.hasOwn(body, "note")) item.note = str(body, "note", 20000);
  if (Object.hasOwn(body, "text")) {
    const text = str(body, "text", 500);
    if (text === "") throw new ValidationError("The item text can't be empty.");
    item.text = text;
  }
  if (Object.hasOwn(body, "done")) {
    if (typeof body.done !== "boolean") throw new ValidationError("'done' must be true or false.");
    if (body.done) {
      if (!itemHasProof(s, item.id)) throw new ValidationError("Add proof before marking this done.");
      item.done = true;
      item.doneOn = str(body, "doneOn", 10, String(op.at ?? "").slice(0, 10));
    } else {
      item.done = false;
      item.doneOn = "";
    }
  }
  return {};
}

function deleteItem(s, op) {
  const item = findItem(s, op.id);
  if (!item) throw new NotFound("Item not found.");
  if (!item.custom) throw new ValidationError("Only items you added yourself can be removed.");
  s.items = s.items.filter((i) => i.id !== op.id);
  for (const e of s.evidence) e.items = e.items.filter((id) => id !== op.id);
  return {};
}

// ---------- proof ----------

function validateEvidence(meta, fileCountAfter) {
  if (str(meta, "title", 200) === "") throw new ValidationError("Give the proof a short title.");
  if (parseDate(str(meta, "date", 10)) === null) throw new ValidationError("Pick the date you did this.");
  if (!KINDS.includes(str(meta, "kind", 20))) throw new ValidationError("Pick what kind of proof this is.");
  const links = strList(meta, "links", 10, 1000);
  for (const l of links) {
    if (!isHttpLink(l)) throw new ValidationError(`Links must start with https:// or http://  (${l})`);
  }
  const summary = str(meta, "summary", 20000);
  if (links.length === 0 && fileCountAfter === 0 && byteLength(summary) < MIN_SUMMARY_BYTES)
    throw new ValidationError("Proof needs a link, a file, or a few sentences in your own words about what you did.");
  // Like the C++ server: a key that is present counts, even when its value is null.
  if (Object.hasOwn(meta, "confidence")) {
    if (!Number.isInteger(meta.confidence)) throw new ValidationError("Confidence must be a number.");
    if (meta.confidence < 0 || meta.confidence > 4) throw new ValidationError("Confidence must be between 0 and 4.");
  }
}

function checkFiles(files) {
  if (!Array.isArray(files)) throw new ValidationError("Files must be a list.");
  for (const f of files) {
    const name = typeof f?.path === "string" && f.path.startsWith("files/") ? f.path.slice(6) : "";
    if (!isSafeStoredName(name) || typeof f.id !== "string" || typeof f.name !== "string" || !Number.isInteger(f.size))
      throw new ValidationError("A file entry is not valid.");
  }
}

function writeEvidenceLinks(s, ev, meta, date) {
  const skills = strList(meta, "skills", 40, 60);
  const items = strList(meta, "items", 40, 60);
  for (const k of skills) if (!findSkill(s, k)) throw new ValidationError(`Unknown skill: ${k}`);
  ev.skills = skills;
  for (const i of items) if (!findItem(s, i)) throw new ValidationError(`Unknown plan item: ${i}`);
  ev.items = items;
  if (Object.hasOwn(meta, "complete") && typeof meta.complete !== "boolean") throw new ValidationError("'complete' must be true or false.");
  if (meta.complete === true) {
    for (const id of items) {
      const item = findItem(s, id);
      if (!item.done) {
        item.done = true;
        item.doneOn = date;
      }
    }
  }
}

function reopenItemsWithoutProof(s, itemIds) {
  for (const id of itemIds) {
    const item = findItem(s, id);
    if (item && !itemHasProof(s, id)) {
      item.done = false;
      item.doneOn = "";
    }
  }
}

const fileEntry = (f, at) => ({ id: f.id, path: f.path, name: cleanFileName(f.name), size: f.size, created: at });

function addEvidence(s, op) {
  const meta = op.meta ?? {};
  const files = op.files ?? [];
  checkFiles(files);
  validateEvidence(meta, files.length);
  if (typeof op.id !== "string" || op.id === "" || findEvidence(s, op.id)) throw new ValidationError("The new proof needs a fresh id.");
  const date = str(meta, "date", 10);
  const ev = {
    id: op.id, date, kind: str(meta, "kind", 20), title: str(meta, "title", 200), summary: str(meta, "summary", 20000),
    links: strList(meta, "links", 10, 1000), confidence: Object.hasOwn(meta, "confidence") ? meta.confidence : 0,
    created: op.at, updated: op.at, skills: [], items: [], files: files.map((f) => fileEntry(f, op.at)),
  };
  s.evidence.push(ev);
  writeEvidenceLinks(s, ev, meta, date);
  return { id: op.id };
}

function updateEvidence(s, op) {
  const ev = findEvidence(s, op.id);
  if (!ev) throw new NotFound("Proof not found.");
  const meta = op.meta ?? {};
  const files = op.files ?? [];
  checkFiles(files);
  const removeIds = strList(meta, "removeFiles", 50, 60);
  const kept = ev.files.filter((f) => !removeIds.includes(f.id));
  validateEvidence(meta, kept.length + files.length);
  const previousItems = [...ev.items];
  const date = str(meta, "date", 10);
  const removedFiles = ev.files.filter((f) => removeIds.includes(f.id)).map((f) => f.path);
  Object.assign(ev, {
    date, kind: str(meta, "kind", 20), title: str(meta, "title", 200), summary: str(meta, "summary", 20000),
    links: strList(meta, "links", 10, 1000), confidence: Object.hasOwn(meta, "confidence") ? meta.confidence : 0, updated: op.at,
    files: [...kept, ...files.map((f) => fileEntry(f, op.at))],
  });
  writeEvidenceLinks(s, ev, meta, date);
  reopenItemsWithoutProof(s, previousItems);
  return { removedFiles };
}

function deleteEvidence(s, op) {
  const ev = findEvidence(s, op.id);
  if (!ev) throw new NotFound("Proof not found.");
  s.evidence = s.evidence.filter((e) => e.id !== op.id);
  reopenItemsWithoutProof(s, ev.items);
  return { removedFiles: ev.files.map((f) => f.path) };
}

function linkEvidence(s, op) {
  const ev = findEvidence(s, op.evidence);
  if (!ev) throw new NotFound("Proof not found.");
  const item = findItem(s, op.item);
  if (!item) throw new NotFound("Item not found.");
  if (op.complete !== undefined && typeof op.complete !== "boolean")
    throw new ValidationError("'complete' must be true or false.");
  if (!ev.items.includes(item.id)) ev.items.push(item.id);
  // The proof also counts for the skills this item trains.
  for (const k of item.skills) if (!ev.skills.includes(k)) ev.skills.push(k);
  if (op.complete !== false && !item.done) {
    item.done = true;
    item.doneOn = ev.date;
  }
  return {};
}

// ---------- skills, log, schedule ----------

function patchSkill(s, op) {
  const skill = findSkill(s, op.id);
  if (!skill) throw new NotFound("Skill not found.");
  const body = op.body ?? {};
  if (Object.hasOwn(body, "status")) {
    const v = str(body, "status", 30);
    const ladder = skill.cat === OPEN_SOURCE_CATEGORY ? CONTRIBUTION_LADDER : LEARNING_LADDER;
    if (!ladder.includes(v)) throw new ValidationError("That status is not a step on this skill's ladder.");
    skill.status = v;
  }
  if (Object.hasOwn(body, "priority")) {
    const v = str(body, "priority", 10);
    if (!PRIORITIES.includes(v)) throw new ValidationError("Unknown priority.");
    skill.priority = v;
  }
  if (Object.hasOwn(body, "note")) skill.note = str(body, "note", 2000);
  return {};
}

function putLog(s, op) {
  if (parseDate(op.date) === null) throw new ValidationError("Pick a valid date.");
  const body = op.body ?? {};
  const data = {};
  if (Object.hasOwn(body, "data")) {
    if (body.data === null || typeof body.data !== "object" || Array.isArray(body.data))
      throw new ValidationError("Log data must be an object.");
    for (const [k, v] of Object.entries(body.data)) {
      if (!LOG_FIELDS.includes(k)) continue;
      if (typeof v !== "string") throw new ValidationError(`Log field '${k}' must be text.`);
      const text = clip(v, 20000);
      if (text !== "") data[k] = text;
    }
  }
  let hours = null;
  if (typeof body.hours === "number") {
    if (!(body.hours >= 0 && body.hours <= 24)) throw new ValidationError("Hours must be between 0 and 24.");
    hours = body.hours;
  }
  const entry = { date: op.date, hours, data, updated: op.at };
  const k = s.log.findIndex((e) => e.date === op.date);
  if (k >= 0) s.log[k] = entry;
  else s.log.push(entry);
  return {};
}

function deleteLog(s, op) {
  s.log = s.log.filter((e) => e.date !== op.date);
  return {};
}

function putSchedule(s, op) {
  const body = op.body;
  if (body === null || typeof body !== "object" || !has(body, "active") || !has(body, "sets") ||
      typeof body.sets !== "object" || Array.isArray(body.sets))
    throw new ValidationError("Schedule must have 'active' and 'sets'.");
  if (typeof body.active !== "string" || !Object.hasOwn(body.sets, body.active))
    throw new ValidationError("The active schedule doesn't exist.");
  for (const [key, set] of Object.entries(body.sets)) {
    if (set === null || typeof set !== "object" || !Array.isArray(set.blocks))
      throw new ValidationError(`Schedule '${key}' has no blocks.`);
    if (set.blocks.length > 60) throw new ValidationError("Too many blocks in one schedule.");
    for (const b of set.blocks) {
      if (b === null || typeof b !== "object" || !Array.isArray(b.days)) throw new ValidationError("Every block needs days.");
      if (!TRACKS.includes(b.track)) throw new ValidationError("Every block needs an area.");
    }
  }
  if (JSON.stringify(body).length > 200000) throw new ValidationError("Schedule is too large.");
  s.schedule = structuredClone(body);
  return {};
}

// ---------- apply ----------

const OPS = {
  addItem, patchItem, deleteItem, addEvidence, updateEvidence, deleteEvidence, linkEvidence,
  patchSkill, putLog, deleteLog, putSchedule,
  pushPlan: (s, op) => pushPlan(s, op.today),
};

// Applies one operation to a copy of `state`. Returns {state, result}. The given state is never changed,
// so a failed operation leaves nothing half done. An operation with a uid that was already applied
// changes nothing and returns {duplicate: true}: a save that is repeated after a lost answer, or by
// two pages of the same browser, still counts once.
export function apply(state, op) {
  const fn = op && Object.hasOwn(OPS, op.type) ? OPS[op.type] : null;
  if (!fn) throw new ValidationError("Unknown change.");
  if (op.uid !== undefined && (typeof op.uid !== "string" || op.uid === "")) throw new ValidationError("A change needs a valid id.");
  const next = structuredClone(state);
  if (op.uid && (next.applied ?? []).includes(op.uid)) return { state: next, result: { duplicate: true } };
  const result = fn(next, op);
  if (op.uid) next.applied = [...(next.applied ?? []), op.uid].slice(-APPLIED_KEEP);
  return { state: next, result };
}

// ---------- view ----------

// Everything the page renders, sorted the way the C++ server returned it.
// With `today`, also includes "behind".
export function view(state, today) {
  const itemEvidence = {};
  for (const e of state.evidence) for (const i of e.items) (itemEvidence[i] ||= []).push(e.id);
  const pos = new Map(state.items.map((i, k) => [i.id, k]));
  const items = state.items
    .map((i) => ({ ...i, skills: [...i.skills], evidence: itemEvidence[i.id] ?? [] }))
    .sort((a, b) => a.w - b.w || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || pos.get(a.id) - pos.get(b.id));
  const created = new Map(state.evidence.map((e, k) => [e.id, k]));
  const evidence = state.evidence
    .map((e) => ({ ...e, links: [...e.links], skills: [...e.skills], items: [...e.items], files: e.files.map((f) => ({ ...f })) }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      (a.created < b.created ? 1 : a.created > b.created ? -1 : 0) || created.get(b.id) - created.get(a.id));
  const out = {
    plan: structuredClone(state.plan),
    schedule: structuredClone(state.schedule),
    cats: state.cats.map((c) => ({ ...c })),
    skills: state.skills.map((k) => ({ ...k })),
    weeks: [...state.weeks].sort((a, b) => a.n - b.n).map((w) => ({ ...w })),
    items,
    evidence,
    log: [...state.log].sort((a, b) => (a.date < b.date ? 1 : -1)).map((l) => ({ ...l, data: { ...l.data } })),
  };
  if (today !== undefined) out.behind = behind(state, today);
  return out;
}
