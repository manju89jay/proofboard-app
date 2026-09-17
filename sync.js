// Keeps this device and the GitHub repository in step without losing changes.
//
// Every change is an operation (see rules.js). Operations wait in a pending list that is kept in the
// browser's storage, so they survive a reload or a lost connection. Saving applies the pending operations
// to the newest data and commits the result. If another device saved first, the newest data is loaded
// and the same operations are applied again. An operation that no longer fits the newest data is listed
// in "rejected" with the reason, never dropped silently.
import { apply, clip, ValidationError, NotFound } from "./rules.js";
import { GitHubError } from "./github.js";

const TYPING_PAUSE_MS = 2000;       // wait this long after the last keystroke
const MIN_TYPING_GAP_MS = 15000;    // and at least this long after the last commit
const FIRST_RETRY_MS = 5000;
const MAX_RETRY_MS = 60000;
const MAX_ATTEMPTS = 4;

const isRuleError = (e) => e instanceof ValidationError || e instanceof NotFound;

// A short description of an operation, for commit messages and for changes that could not be saved.
export function describeOp(op) {
  const b = op.body ?? {};
  switch (op.type) {
    case "addItem": return `Add item "${b.text ?? ""}"`;
    case "patchItem":
      if (b.done === true) return `Mark item ${op.id} done`;
      if (b.done === false) return `Mark item ${op.id} not done`;
      if ("note" in b) return `Edit notes on item ${op.id}`;
      if ("due" in b) return `Move item ${op.id} to ${b.due}`;
      return `Edit item ${op.id}`;
    case "deleteItem": return `Remove item ${op.id}`;
    case "addEvidence": return `Add proof "${op.meta?.title ?? ""}"`;
    case "updateEvidence": return `Edit proof "${op.meta?.title ?? ""}"`;
    case "deleteEvidence": return `Delete proof ${op.id}`;
    case "linkEvidence": return `Link proof ${op.evidence} to item ${op.item}`;
    case "patchSkill": return `Update skill ${op.id}`;
    case "putLog": return `Save the log for ${op.date}`;
    case "deleteLog": return `Delete the log for ${op.date}`;
    case "putSchedule": return "Save the schedule";
    case "pushPlan": return `Push the plan back (today ${op.today})`;
    default: return "Unknown change";
  }
}

// At most 200 bytes, cut without breaking a character.
const commitMessage = (ops) => {
  const text = `Proofboard: ${ops.map(describeOp).join("; ")}`;
  const cut = clip(text, 197);
  return cut.length < text.length ? `${cut}...` : text;
};

export class Sync {
  #queue = Promise.resolve();
  #timer = null;
  #timerKind = null;
  #timerAt = 0;
  #lastCommitMs = -Infinity;
  #retryMs = FIRST_RETRY_MS;

  // newUid: returns a new random id for each change and for this page.
  constructor({ client, storage, storageKey, nowMs, setTimer, clearTimer, newUid, onChange = () => {} }) {
    Object.assign(this, { client, storage, nowMs, setTimer, clearTimer, newUid, onChange });
    // Each open page keeps its own list of waiting changes, so two tabs never overwrite each other's list.
    // A new page adopts the lists it finds; a change that ends up in two lists is saved once (see apply).
    this.pendingPrefix = `pb:${storageKey}:pending`;
    this.keys = { cache: `pb:${storageKey}:cache`, pending: `${this.pendingPrefix}:${newUid()}`, rejected: `pb:${storageKey}:rejected` };
    this.remote = null;   // {state, head, fileSha}: the last version known to be in the repository
    this.local = null;    // remote plus pending operations: what the page shows
    this.pending = [];
    this.rejected = [];   // [{what, why, op}]
    this.phase = "saved"; // "saved", "saving", "waiting", "offline" or "error"
    this.message = "";
  }

  get state() { return this.local; }

  get status() {
    return { phase: this.phase, pending: this.pending.length, message: this.message,
      rejected: this.rejected.map(({ what, why }) => ({ what, why })) };
  }

  // Loads the data. Uses this browser's saved copy when GitHub can't be reached.
  // Returns {ready: false} when the repository has no data yet (see initialize).
  async start() {
    this.pending = this.#adoptPending();
    this.rejected = this.#read(this.keys.rejected, []);
    const cached = this.#read(this.keys.cache, null);
    try {
      const r = await this.client.load();
      if (r.data === null) {
        this.remote = null;
        this.local = null;
        return { ready: false };
      }
      this.remote = { state: r.data, head: r.head, fileSha: r.fileSha };
      this.#write(this.keys.cache, this.remote);
      this.#setPhase(this.pending.length ? "saving" : "saved", "");
    } catch (e) {
      if (!(e instanceof GitHubError) || !cached) throw e;
      this.remote = cached;
      this.#problem(e, { retry: false });
    }
    this.#recompute();
    this.onChange("remote");
    return { ready: true };
  }

  // Creates proofboard.json in an empty repository.
  initialize(state) {
    return this.#exclusive(async () => {
      if (this.remote) throw new Error("The repository already has data.");
      const r = await this.client.putJson(state, null, "Proofboard: start from the roadmap");
      this.remote = { state, head: r.head, fileSha: r.fileSha };
      this.#write(this.keys.cache, this.remote);
      this.#lastCommitMs = this.nowMs();
      this.#recompute();
      this.#setPhase("saved", "");
      this.onChange("remote");
    });
  }

  // Applies a change on this device at once and queues it for saving. Throws if the change is invalid,
  // and then nothing is queued. urgent: save now. Otherwise the save waits for a pause in typing.
  enqueue(op, { urgent = true } = {}) {
    if (!this.remote) throw new Error("Proofboard has not loaded its data yet.");
    if (!op.uid) op = { ...op, uid: this.newUid() };
    const { state, result } = apply(this.local, op);
    this.pending.push(op);
    this.#write(this.keys.pending, this.pending);
    this.local = state;
    if (this.phase === "saved") this.#setPhase("saving", "");
    this.onChange("local");
    this.#schedule(urgent ? "urgent" : "typing");
    return result;
  }

  // Saves everything pending now.
  flush() {
    return this.#exclusive(() => this.#flushAll());
  }

  // Resolves when no save is running or queued behind another.
  async whenIdle() {
    let q;
    do { q = this.#queue; await q; } while (q !== this.#queue);
  }

  // Checks whether another device saved something, with one small request. Reloads only if so.
  refreshIfChanged() {
    return this.#exclusive(async () => {
      if (!this.remote) return false;
      let head;
      try {
        head = await this.client.headSha();
      } catch (e) {
        if (e instanceof GitHubError) { this.#problem(e, { retry: false }); return false; }
        throw e;
      }
      if (head === this.remote.head) return false;
      await this.#reload();
      return true;
    });
  }

  // Saves a change that comes with files, in one commit together with the data.
  // Earlier pending changes are saved first. Throws if saving fails, so the caller can keep its form open.
  commitWithFiles(op, files) {
    return this.#exclusive(async () => {
      if (!this.remote) throw new Error("Proofboard has not loaded its data yet.");
      if (!op.uid) op = { ...op, uid: this.newUid() };
      if (!(await this.#flushAll()))
        throw new GitHubError("network", "Earlier changes are not saved yet, so this proof was not saved. Try again when the connection is back.");
      // Refuse invalid proof before uploading anything. A repeat of a save that already reached GitHub is done.
      if (apply(this.remote.state, op).result?.duplicate) return { duplicate: true };
      this.#setPhase("saving", "");
      try {
        const blobs = await this.client.uploadBlobs(files);
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          const { state, result } = apply(this.remote.state, op);
          if (result?.duplicate) return result; // the earlier attempt landed after all
          try {
            const r = await this.client.commitTree({ baseHead: this.remote.head, data: state, blobs, message: commitMessage([op]) });
            this.#saved(state, r);
            return result;
          } catch (e) {
            if (!(e instanceof GitHubError) || e.kind !== "conflict") throw e;
            await this.#reload();
          }
        }
        throw new GitHubError("other", "Saving kept clashing with changes from another device. Try again.");
      } finally {
        if (this.phase === "saving") this.#setPhase(this.pending.length ? "saving" : "saved", "");
      }
    });
  }

  dismissRejected() {
    this.rejected = [];
    this.#write(this.keys.rejected, this.rejected);
    this.onChange("status");
  }

  // Removes this page's saved copy, its waiting changes and the reported changes from this browser.
  // Waiting changes of other open pages stay, so a page opened later still saves them.
  forget() {
    if (this.#timer !== null) this.clearTimer(this.#timer);
    for (const k of Object.values(this.keys)) {
      try { this.storage.removeItem(k); } catch { /* storage unavailable */ }
    }
  }

  // ---------- internals ----------

  #exclusive(task) {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => {});
    return run;
  }

  #schedule(kind) {
    const now = this.nowMs();
    const at = kind === "typing" ? Math.max(now + TYPING_PAUSE_MS, this.#lastCommitMs + MIN_TYPING_GAP_MS) : now;
    if (this.#timer !== null) {
      // A save that is already due sooner covers this change too; typing only postpones typing saves.
      const keep = this.#timerKind !== "typing" && this.#timerAt <= at;
      if (keep) return;
      this.clearTimer(this.#timer);
    }
    this.#timerKind = kind;
    this.#timerAt = at;
    this.#timer = this.setTimer(() => {
      this.#timer = null;
      this.flush().catch(() => {});
    }, at - now);
  }

  #clearTimer() {
    if (this.#timer !== null) this.clearTimer(this.#timer);
    this.#timer = null;
  }

  // Returns true when nothing is left pending.
  async #flushAll() {
    this.#clearTimer();
    while (this.remote && this.pending.length) {
      if (!(await this.#flushOnce())) return false;
    }
    if (this.phase === "saving") this.#setPhase("saved", "");
    return true;
  }

  async #flushOnce() {
    this.#setPhase("saving", "");
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const applied = [];
      let next = this.remote.state;
      let changed = false;
      for (const op of [...this.pending]) {
        try {
          const r = apply(next, op);
          next = r.state;
          applied.push(op);
          if (!r.result?.duplicate) changed = true;
        } catch (e) {
          if (!isRuleError(e)) throw e;
          this.#reject(op, e);
        }
      }
      if (!changed) {
        // Nothing new: every waiting change is already in the repository.
        this.pending = this.pending.filter((op) => !applied.includes(op));
        this.#write(this.keys.pending, this.pending);
        this.#recompute();
        this.#setPhase(this.pending.length ? "saving" : "saved", "");
        this.onChange("status");
        return true;
      }
      try {
        const r = await this.client.putJson(next, this.remote.fileSha, commitMessage(applied));
        this.pending = this.pending.filter((op) => !applied.includes(op)); // changes made meanwhile stay
        this.#write(this.keys.pending, this.pending);
        this.#saved(next, r);
        return true;
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e;
        if (e.kind !== "conflict") { this.#problem(e); return false; }
        try {
          await this.#reload();
        } catch (e2) {
          if (!(e2 instanceof GitHubError)) throw e2;
          this.#problem(e2);
          return false;
        }
      }
    }
    this.#problem(new GitHubError("other", "Saving kept clashing with changes from another device. Trying again shortly."));
    return false;
  }

  #saved(state, r) {
    this.remote = { state, head: r.head, fileSha: r.fileSha };
    this.#write(this.keys.cache, this.remote);
    this.#lastCommitMs = this.nowMs();
    this.#retryMs = FIRST_RETRY_MS;
    this.#recompute();
    this.#setPhase(this.pending.length ? "saving" : "saved", "");
    this.onChange("saved");
  }

  async #reload() {
    const r = await this.client.load();
    if (r.data === null) throw new GitHubError("other", "proofboard.json is missing from the repository.");
    this.remote = { state: r.data, head: r.head, fileSha: r.fileSha };
    this.#write(this.keys.cache, this.remote);
    this.#recompute();
    this.onChange("remote");
  }

  // local = remote + pending. Pending changes that no longer fit are moved to rejected.
  #recompute() {
    let s = this.remote.state;
    const keep = [];
    for (const op of this.pending) {
      try {
        s = apply(s, op).state;
        keep.push(op);
      } catch (e) {
        if (!isRuleError(e)) throw e;
        this.#reject(op, e);
      }
    }
    if (keep.length !== this.pending.length) {
      this.pending = keep;
      this.#write(this.keys.pending, this.pending);
    }
    this.local = s;
  }

  #reject(op, e) {
    this.pending = this.pending.filter((p) => p !== op);
    this.#write(this.keys.pending, this.pending);
    // Other pages of this browser may have reported changes too: add to the stored list, once per change.
    const stored = this.#read(this.keys.rejected, []);
    const known = new Set([...stored, ...this.rejected].map((r) => r.op?.uid).filter(Boolean));
    const merged = [...stored, ...this.rejected.filter((r) => !stored.some((x) => x.op?.uid && x.op.uid === r.op?.uid))];
    if (!op.uid || !known.has(op.uid)) merged.push({ what: describeOp(op), why: e.message, op });
    this.rejected = merged;
    this.#write(this.keys.rejected, this.rejected);
  }

  #problem(e, { retry = true } = {}) {
    if (e.kind === "network") {
      this.#setPhase("offline", e.message);
      if (retry) this.#retryLater(this.#retryMs), (this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS));
    } else if (e.kind === "rateLimit") {
      this.#setPhase("waiting", e.message);
      if (retry) this.#retryLater(e.retryAfterMs ?? MAX_RETRY_MS);
    } else {
      this.#setPhase("error", e.message);
      if (retry && e.kind === "other") this.#retryLater(MAX_RETRY_MS);
    }
  }

  #retryLater(ms) {
    this.#clearTimer();
    this.#timerKind = "retry";
    this.#timerAt = this.nowMs() + ms;
    this.#timer = this.setTimer(() => {
      this.#timer = null;
      this.flush().catch(() => {});
    }, ms);
  }

  #setPhase(phase, message) {
    const changed = phase !== this.phase || message !== this.message;
    this.phase = phase;
    this.message = message;
    if (changed) this.onChange("status");
  }

  #pendingKeys() {
    const keys = [];
    try {
      for (let i = 0; i < this.storage.length; i += 1) {
        const k = this.storage.key(i);
        if (k === this.pendingPrefix || (k && k.startsWith(`${this.pendingPrefix}:`))) keys.push(k);
      }
    } catch { /* storage unavailable */ }
    return keys;
  }

  // Takes over the waiting changes of every earlier page, oldest list first, without repeats.
  #adoptPending() {
    const ops = [];
    const seen = new Set();
    for (const k of this.#pendingKeys()) {
      for (const op of this.#read(k, [])) {
        if (op && op.uid && seen.has(op.uid)) continue;
        if (op && op.uid) seen.add(op.uid);
        ops.push(op);
      }
      if (k !== this.keys.pending) {
        try { this.storage.removeItem(k); } catch { /* storage unavailable */ }
      }
    }
    this.#write(this.keys.pending, ops);
    return ops;
  }

  #read(key, fallback) {
    try {
      const text = this.storage.getItem(key);
      return text === null ? fallback : JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  #write(key, value) {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      if (key === this.keys.pending) this.#setPhase("error", "This browser's storage is full, so unsaved changes may not survive a reload.");
    }
  }
}
