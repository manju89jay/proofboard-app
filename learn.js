// Learn pages: pure functions that turn the JSON written by tools/make_learn.py into HTML.
// Every string from the data is escaped, and only https:// links become links, so a mistake
// in the curriculum can never inject markup. Unknown block types render nothing.

export const LEARN_TRACKS = {
  cpp: "C++ and design patterns", dsa: "Algorithms and live coding",
  concepts: "System design, robotics and simulation", project: "Test Bench and open source",
};
const STEP_NAMES = { theory: "Theory", example: "Worked example", exercise: "Exercise", failure: "Failure cases",
  summary: "Summary", build: "Build", mock: "Mock" };
const LANG_NAMES = { cpp: "C++", sh: "Shell", text: "Text", cmake: "CMake", xml: "XML", yaml: "YAML", python: "Python" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

export function fmtMinutes(m) {
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// Minutes for full study: the cold check plus every step.
export function topicMinutes(t) {
  return (t.check ? t.check.minutes : 0) + t.subs.reduce((sum, s) => sum + s.steps.reduce((a, st) => a + st.minutes, 0), 0);
}

function run(r) {
  switch (r.t) {
    case "text": return esc(r.v);
    case "code": return `<code>${esc(r.v)}</code>`;
    case "b": return `<strong>${esc(r.v)}</strong>`;
    case "i": return `<em>${esc(r.v)}</em>`;
    case "a":
      return typeof r.href === "string" && r.href.startsWith("https://")
        ? `<a href="${esc(r.href)}" target="_blank" rel="noopener noreferrer">${esc(r.v)}</a>`
        : esc(r.v);
    default: return "";
  }
}
const runs = (list) => (Array.isArray(list) ? list.map(run).join("") : "");

// What the caption says about how the example was checked.
function caption(b) {
  if (b.lang !== "cpp") return esc(own(LANG_NAMES, b.lang) ?? b.lang);
  const expect = String(b.expect ?? ""), colon = expect.indexOf(":");
  const kind = expect.slice(0, colon), what = expect.slice(colon + 1);
  switch (b.tag) {
    case "run":
      if (!expect) return "C++ · compiled and run in CI with ASan and UBSan";
      if (kind === "asan") return `C++ · undefined behaviour: AddressSanitizer reports ${esc(what)}`;
      if (kind === "ubsan") return `C++ · undefined behaviour: UBSan reports ${esc(what)}`;
      return `C++ · ${esc(expect)}`;
    case "compile-fail": return `C++ · does not compile: ${esc(expect)}`;
    case "fragment": return "C++ fragment (not compiled)";
    case "ros": return "C++ · ROS 2 node, built in CI";
    default: return `C++ · ${esc(b.tag)}`;
  }
}

// A "#### Solution" heading hides the blocks after it, up to the next minor heading, until asked.
const isSolution = (b) => b.t === "h" && Array.isArray(b.c) && b.c.length === 1 && b.c[0].t === "text" && b.c[0].v === "Solution";

export function renderBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  let h = "", hidden = false;
  for (const b of blocks) {
    if (hidden && b.t === "h") { h += "</details>"; hidden = false; }
    if (isSolution(b)) { h += `<details class="lanswer"><summary>Show the solution</summary>`; hidden = true; continue; }
    h += renderBlock(b);
  }
  return hidden ? h + "</details>" : h;
}

function renderBlock(b) {
  switch (b.t) {
    case "p": return `<p>${runs(b.c)}</p>`;
    case "h": return `<h5>${runs(b.c)}</h5>`;
    case "ul": case "ol": {
      const start = b.t === "ol" && Number.isInteger(b.start) && b.start > 1 ? ` start="${b.start}"` : "";
      return `<${b.t}${start}>${(b.items || []).map((i) => `<li>${runs(i)}</li>`).join("")}</${b.t}>`;
    }
    case "note": return `<p class="lnote">${runs(b.c)}</p>`;
    case "table":
      return `<div class="ltable"><table><thead><tr>${(b.head || []).map((c) => `<th>${runs(c)}</th>`).join("")}</tr></thead>`
        + `<tbody>${(b.rows || []).map((r) => `<tr>${r.map((c) => `<td>${runs(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    case "code": return `<figure class="lcode"><figcaption>${caption(b)}</figcaption><pre><code>${esc(b.text)}</code></pre></figure>`;
    case "output": return `<figure class="lcode lout"><figcaption>Output</figcaption><pre><code>${esc(b.text)}</code></pre></figure>`;
    default: return "";
  }
}

const topicButton = (t) => `<button type="button" class="btn link ltitle" data-act="learnopen" data-topic="${esc(t.id)}">${esc(t.title)}</button>`;
const skillList = (t, names) => t.skills.map((k) => esc(own(names, k) ?? k)).join(", ");

// The Learn tab's front page: every track, its topics in study order.
export function renderLearnList(index, skillNames) {
  const byId = new Map(index.topics.map((t) => [t.id, t]));
  let h = `<h2>Learn</h2><p class="lede">Every topic in study order. Each one starts with a cold check, then works through its parts step by step. Times are for full study; a passed cold check skips the reading.</p>`;
  for (const [track, ids] of Object.entries(index.tracks)) {
    const topics = ids.map((id) => byId.get(id)).filter(Boolean);
    const ready = topics.filter((t) => !t.pending).length;
    h += `<section class="card ltrack"><h3>${esc(own(LEARN_TRACKS, track) ?? track)} <span class="lcount">${ready} of ${topics.length} written</span></h3><ol class="ltopics">`;
    for (const t of topics) {
      h += `<li>${topicButton(t)}<span class="lmeta">${fmtMinutes(topicMinutes(t))} · ${skillList(t, skillNames)} · `
        + `${t.pending ? `<span class="lsoon">Coming soon</span>` : `<span class="lready">Ready</span>`}</span></li>`;
    }
    h += `</ol></section>`;
  }
  return h;
}

// One topic. `body` is its Learn JSON, or null while it is still being written.
export function renderTopic(index, topic, body, skillNames) {
  const byId = new Map(index.topics.map((t) => [t.id, t]));
  let h = `<button type="button" class="btn link" data-act="learnback">All topics</button>`;
  h += `<h2 class="ltopic">${esc(topic.title)}</h2>`;
  h += `<p class="lede">${esc(own(LEARN_TRACKS, topic.track) ?? topic.track)} · ${esc(topic.priority)} · about ${fmtMinutes(topicMinutes(topic))} for full study`
    + `${topic.review ? ` · reviews take ${fmtMinutes(topic.review)}` : ""}</p>`;
  h += `<p class="lfacts"><span><strong>Trains:</strong> ${skillList(topic, skillNames)}</span>`;
  if (topic.requires.length) {
    h += `<span><strong>Needs first:</strong> ${topic.requires.map((r) => (byId.has(r) ? topicButton(byId.get(r)) : esc(r))).join(", ")}</span>`;
  }
  h += `</p>`;

  if (!body) {
    h += `<div class="card lsec"><p><strong>Coming soon.</strong> The Learn text for this topic is not written yet. This is what it will cover.</p>`;
    if (topic.check) h += `<h4>Cold check <span class="lmin">${fmtMinutes(topic.check.minutes)}</span></h4><p>${esc(topic.check.text)}</p>`;
    for (const s of topic.subs) {
      h += `<h4>${esc(s.title)}</h4><ul>${s.steps.map((st) => `<li>${esc(own(STEP_NAMES, st.kind) ?? st.kind)} · ${fmtMinutes(st.minutes)}</li>`).join("")}</ul>`;
    }
    return h + `<h4>Pass bar</h4><p>${esc(topic.pass)}</p></div>`;
  }

  if (body.check) {
    h += `<section class="card lsec"><h3>Cold check <span class="lmin">${topic.check ? fmtMinutes(topic.check.minutes) : ""}</span></h3>`;
    h += `<p class="hint">Do this first, without notes. Pass: go straight to the last exercise of each part. Partly: try the exercises first, then read. Fail: work through everything.</p>`;
    h += `${renderBlocks(body.check.task)}<details class="lanswer"><summary>Show the answer</summary>${renderBlocks(body.check.answer)}</details></section>`;
  }
  for (const s of body.subs || []) {
    h += `<section class="card lsec"><h3>${esc(s.title)}</h3>`;
    for (const st of s.steps || []) {
      h += `<h4>${esc(st.heading)} <span class="lmin">${fmtMinutes(st.minutes)}</span></h4>${renderBlocks(st.blocks)}`;
      if (st.faded) h += `<details class="lfaded"><summary>Faded example: fill in the gaps</summary>${renderBlocks(st.faded)}</details>`;
    }
    h += `</section>`;
  }
  h += `<section class="card lsec"><h3>Pass bar</h3><p>${esc(topic.pass)}</p></section>`;
  if (body.review) {
    h += `<section class="card lsec"><h3>Review prompts</h3><p class="hint">Answer these closed-book at each review: explain, then re-implement from a blank file, then compare.</p>${renderBlocks(body.review)}</section>`;
  }
  return h;
}
