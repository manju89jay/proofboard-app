// Proofboard scheduler: lays the curriculum out on study days, block by block.
// Pure: the same index and plan always give the same forecast. Whole minutes and whole
// day numbers only. The rules are in docs/adr-003-guided-learning.md (phase 1 spec).

import { parseDate, formatDate, addStudyDays, nextStudyDay } from "./rules.js";

// Study days between a topic's last step and its first review, then between reviews.
export const REVIEW_GAPS = [1, 5, 17, 50];
export const MAX_REVIEWS_PER_BLOCK = 2;
export const MAX_STUDY_DAYS = 2600;

// Steps kept when the cold check passes, besides the last exercise of each sub-topic.
const KEPT_ON_PASS = new Set(["failure", "summary", "build", "mock"]);

const weekday = (dayNumber) => (((dayNumber + 4) % 7) + 7) % 7; // 0 is Sunday

function clock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// A block's length in minutes; 0 for blocks without times, like "Evening".
function blockMinutes(b) {
  const start = clock(b.start), end = clock(b.end);
  return start !== null && end !== null && end > start ? end - start : 0;
}

// The steps one topic takes under the assumed cold-check result.
function stepsFor(topic, assume) {
  if (topic.kind !== "learn") return topic.subs.flatMap((s) => s.steps.map((st) => ({ ...st })));
  const out = [{ kind: "check", minutes: topic.check.minutes }];
  for (const s of topic.subs) {
    if (assume === "fail") {
      out.push(...s.steps.map((st) => ({ ...st })));
      continue;
    }
    let lastExercise = -1;
    s.steps.forEach((st, i) => { if (st.kind === "exercise") lastExercise = i; });
    s.steps.forEach((st, i) => { if (i === lastExercise || KEPT_ON_PASS.has(st.kind)) out.push({ ...st }); });
  }
  return out;
}

// {end, tracks, topics, calendar}: see the phase 1 spec in ADR-003.
export function forecast(index, plan) {
  const start = parseDate(plan.start);
  if (start === null) throw new Error(`The plan start is not a date: ${plan.start}`);
  if (plan.assume !== "fail" && plan.assume !== "pass") throw new Error(`assume must be "fail" or "pass", not ${plan.assume}`);

  const off = new Set(plan.off ?? []);
  const byId = new Map(index.topics.map((t) => [t.id, t]));
  const kept = index.topics.filter((t) => !off.has(t.id));
  for (const t of kept) {
    for (const r of t.requires) if (off.has(r)) throw new Error(`${t.id} needs ${r}, which is left out.`);
  }

  const blocks = plan.blocks
    .map((b) => ({ ...b, minutes: blockMinutes(b) }))
    .filter((b) => b.minutes > 0)
    .sort((a, b) => clock(a.start) - clock(b.start));
  for (const t of kept) {
    const mine = blocks.filter((b) => b.track === t.track && b.days.some((d) => d >= 1 && d <= 5));
    if (!mine.length) throw new Error(`There is no study block for track ${t.track}.`);
    if (t.kind === "learn" && !mine.some((b) => b.minutes >= t.review))
      throw new Error(`The review of ${t.id} (${t.review} min) is longer than every ${t.track} block.`);
  }

  const tracks = {};
  for (const track of Object.keys(index.tracks)) {
    const ids = index.tracks[track].filter((id) => byId.has(id) && !off.has(id));
    tracks[track] = { end: "", work: 0, reviews: 0, topics: ids.length, queue: ids, current: null };
  }
  const topics = {};
  const finished = new Set(); // topics done so far; blocks run in time order, so this includes earlier blocks today
  const reviews = []; // {topic, track, minutes, due, k, seq}
  let reviewSeq = 0;
  let left = kept.length;
  const calendar = [];

  let d = nextStudyDay(start);
  for (let count = 0; left > 0; count += 1, d = addStudyDays(d, 1)) {
    if (count >= MAX_STUDY_DAYS) throw new Error(`The plan does not finish within ${MAX_STUDY_DAYS} study days.`);
    const today = [];
    for (const b of blocks) {
      if (!b.days.includes(weekday(d))) continue;
      const tr = tracks[b.track];
      if (!tr) continue;
      let room = b.minutes;
      const used = [];

      // The oldest due reviews that fit, at most two; a review too long for this block waits.
      const due = reviews.filter((r) => r.track === b.track && r.due <= d).sort((x, y) => x.due - y.due || x.seq - y.seq);
      let done = 0;
      for (const r of due) {
        if (done === MAX_REVIEWS_PER_BLOCK) break;
        if (r.minutes > room) continue;
        done += 1;
        room -= r.minutes;
        tr.reviews += r.minutes;
        used.push({ topic: r.topic, kind: "review", minutes: r.minutes });
        r.k += 1;
        if (r.k < REVIEW_GAPS.length) r.due = addStudyDays(d, REVIEW_GAPS[r.k]);
        else reviews.splice(reviews.indexOf(r), 1);
      }

      let startedHere = false;
      while (room > 0) {
        if (!tr.current) {
          if (startedHere) break;
          const ready = tr.queue.findIndex((id) => byId.get(id).requires.every((r) => finished.has(r)));
          if (ready < 0) break;
          const topic = byId.get(tr.queue[ready]);
          tr.queue.splice(ready, 1);
          const steps = stepsFor(topic, plan.assume);
          tr.current = { topic, steps, i: 0, rest: steps[0].minutes };
          topics[topic.id] = { start: formatDate(d), end: "", minutes: steps.reduce((sum, s) => sum + s.minutes, 0) };
          startedHere = true;
        }
        const cur = tr.current;
        const take = Math.min(room, cur.rest);
        used.push({ topic: cur.topic.id, kind: cur.steps[cur.i].kind, minutes: take });
        room -= take;
        cur.rest -= take;
        tr.work += take;
        if (cur.rest > 0) continue;
        cur.i += 1;
        if (cur.i < cur.steps.length) {
          cur.rest = cur.steps[cur.i].minutes;
          continue;
        }
        const id = cur.topic.id;
        finished.add(id);
        topics[id].end = formatDate(d);
        tr.end = formatDate(d);
        if (cur.topic.kind === "learn")
          reviews.push({ topic: id, track: b.track, minutes: cur.topic.review, due: addStudyDays(d, REVIEW_GAPS[0]), k: 0, seq: reviewSeq++ });
        tr.current = null;
        left -= 1;
      }
      if (used.length) today.push({ track: b.track, start: b.start, steps: used });
    }
    if (today.length) calendar.push({ date: formatDate(d), blocks: today });
  }

  const out = {};
  for (const [track, t] of Object.entries(tracks)) out[track] = { end: t.end, work: t.work, reviews: t.reviews, topics: t.topics };
  const end = Object.values(out).reduce((latest, t) => (t.end > latest ? t.end : latest), "");
  return { end, tracks: out, topics, calendar };
}
