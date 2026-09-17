// Talks to one private GitHub repository that holds Proofboard's data.
// proofboard.json holds the data; files/<name> holds uploaded files.

export const DATA_PATH = "proofboard.json";
const API_VERSION = "2022-11-28";

// kind: "auth", "notFound", "empty", "conflict", "rateLimit", "network" or "other".
export class GitHubError extends Error {
  constructor(kind, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text.replace(/\s/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// Readable diffs in the repository history: one key per line.
const serialize = (data) => JSON.stringify(data, null, 1) + "\n";
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

// nowMs: the current time in milliseconds, used only to turn GitHub's rate-limit reset time into a wait.
export function createClient({ repo, token, apiBase = "https://api.github.com", fetch = (...a) => globalThis.fetch(...a), nowMs = () => Date.now() }) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo ?? ""))
    throw new GitHubError("notFound", "Write the repository as owner/name, for example your-name/proofboard-data.");
  const base = `${apiBase.replace(/\/+$/, "")}/repos/${repo}`;
  let branch = null;

  async function request(method, path, { body, accept = "application/vnd.github+json", raw = false } = {}) {
    const headers = { Accept: accept, Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": API_VERSION };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    } catch {
      throw new GitHubError("network", "Can't reach GitHub right now. Your changes stay on this device and are saved when the connection is back.");
    }
    if (res.ok) return raw ? res : res.status === 204 ? null : res.json();

    const status = res.status;
    let message = "";
    try { message = (await res.json()).message || ""; } catch { /* not JSON */ }
    if (status === 401)
      throw new GitHubError("auth", "GitHub did not accept the token. It may have expired: create a new one and enter it again.", { status });
    if (status === 403 || status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (status === 429 || retryAfter > 0 || res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)) {
        const retryAfterMs = retryAfter > 0 ? retryAfter * 1000 : reset > 0 ? Math.max(1000, reset * 1000 - nowMs()) : 60000;
        throw new GitHubError("rateLimit", "GitHub asked Proofboard to slow down. Your changes are kept and saved shortly.", { status, retryAfterMs });
      }
      throw new GitHubError("auth", "The token can't use this repository. Give it Contents: Read and write, for this repository only.", { status });
    }
    if (status === 404) throw new GitHubError("notFound", message || "Not found.", { status });
    if (status === 409 && /empty/i.test(message)) throw new GitHubError("empty", "The repository is empty.", { status });
    // Only these mean another device saved first: a file version that no longer matches, a missing file version,
    // or a branch that moved. Any other 422 is a real error and keeps GitHub's own message.
    if (status === 409 || (status === 422 && /fast.?forward|sha.*(wasn't supplied|does not match)/i.test(message)))
      throw new GitHubError("conflict", "Another device saved first.", { status });
    if (status === 422) throw new GitHubError("other", `GitHub refused the change: ${message || "validation failed"}.`, { status });
    if (status >= 500) throw new GitHubError("network", "GitHub had a problem. Your changes are kept and saved shortly.", { status });
    throw new GitHubError("other", `GitHub answered ${status}${message ? `: ${message}` : ""}.`, { status });
  }

  async function defaultBranch() {
    if (branch) return branch;
    try {
      branch = (await request("GET", "")).default_branch;
    } catch (e) {
      if (e.kind === "notFound")
        throw new GitHubError("notFound", `Repository ${repo} was not found, or the token can't see it.`, { status: 404 });
      throw e;
    }
    return branch;
  }

  // The commit the branch points at, or null for a repository without commits.
  async function headSha() {
    const b = await defaultBranch();
    try {
      return (await request("GET", `/git/ref/heads/${encodeURIComponent(b)}`)).object.sha;
    } catch (e) {
      if (e.kind === "empty") return null;
      throw e;
    }
  }

  return {
    headSha,

    // {head, fileSha, data}. data is null when the repository has no proofboard.json yet.
    async load() {
      const head = await headSha();
      if (!head) return { head: null, fileSha: null, data: null };
      const at = `/contents/${DATA_PATH}?ref=${head}`;
      let meta;
      try {
        meta = await request("GET", at, { accept: "application/vnd.github.object+json" });
      } catch (e) {
        if (e.kind === "notFound") return { head, fileSha: null, data: null };
        throw e;
      }
      // Files over 1 MB come without content; fetch those raw.
      const bytes = meta.encoding === "base64" && meta.content
        ? base64ToBytes(meta.content)
        : new Uint8Array(await (await request("GET", at, { accept: "application/vnd.github.raw+json", raw: true })).arrayBuffer());
      let data;
      try {
        data = JSON.parse(decoder.decode(bytes));
      } catch {
        throw new GitHubError("other", `${DATA_PATH} in the repository is not valid JSON.`);
      }
      return { head, fileSha: meta.sha, data };
    },

    // One commit that replaces proofboard.json. fileSha is the version it replaces (null to create it).
    async putJson(data, fileSha, message) {
      const body = { message, content: bytesToBase64(encoder.encode(serialize(data))), branch: await defaultBranch() };
      if (fileSha) body.sha = fileSha;
      const r = await request("PUT", `/contents/${DATA_PATH}`, { body });
      return { head: r.commit.sha, fileSha: r.content.sha };
    },

    // Uploads file contents once. Returns [{path, sha}] for commitTree.
    async uploadBlobs(files) {
      const out = [];
      for (const f of files) {
        const r = await request("POST", "/git/blobs", { body: { content: bytesToBase64(f.bytes), encoding: "base64" } });
        out.push({ path: f.path, sha: r.sha });
      }
      return out;
    },

    // One commit on top of baseHead with the new proofboard.json and the uploaded files.
    // Refuses to overwrite newer work: the branch only moves if baseHead is still its head.
    async commitTree({ baseHead, data, blobs, message }) {
      const b = await defaultBranch();
      const parent = await request("GET", `/git/commits/${baseHead}`);
      const tree = await request("POST", "/git/trees", { body: {
        base_tree: parent.tree.sha,
        tree: [
          { path: DATA_PATH, mode: "100644", type: "blob", content: serialize(data) },
          ...blobs.map((f) => ({ path: f.path, mode: "100644", type: "blob", sha: f.sha })),
        ],
      } });
      const commit = await request("POST", "/git/commits", { body: { message, tree: tree.sha, parents: [baseHead] } });
      await request("PATCH", `/git/refs/heads/${encodeURIComponent(b)}`, { body: { sha: commit.sha, force: false } });
      const entry = (tree.tree || []).find((e) => e.path === DATA_PATH);
      return { head: commit.sha, fileSha: entry ? entry.sha : null };
    },

    // The bytes of an uploaded file.
    async fetchFile(path) {
      const b = await defaultBranch();
      const res = await request("GET", `/contents/${encodePath(path)}?ref=${encodeURIComponent(b)}`,
        { accept: "application/vnd.github.raw+json", raw: true });
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

const LOCAL_HOSTS = ["127.0.0.1", "localhost"];

// The API address for a page at `location` ({hostname, search}). A different address from ?api= is only
// accepted while the page itself and that address are both on this computer, for local checks against a
// fake GitHub. Anywhere else the token only ever goes to GitHub.
export function apiBaseFor(location) {
  const asked = new URLSearchParams(location.search).get("api");
  if (!asked || !LOCAL_HOSTS.includes(location.hostname)) return "https://api.github.com";
  try {
    const url = new URL(asked);
    return url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname) ? asked : "https://api.github.com";
  } catch {
    return "https://api.github.com";
  }
}
