/*
  Vercel serverless function behind the "Check for new data now" button.

  POST /api/check-now starts the same GitHub Actions job that runs every morning
  (.github/workflows/update-curve.yml). It does not download or change any data itself:
  the job applies exactly the same checks as a scheduled run and fails closed.

  Needs the environment variable GITHUB_DISPATCH_TOKEN on Vercel: a fine-grained GitHub token
  restricted to this repository with the single permission "Actions: Read and write".
  Protection against abuse: one check every COOLDOWN_MINUTES, and never while a check is running.
*/
const REPO = "giodiri12/progetto-fintech-adfh";
const WORKFLOW = "update-curve.yml";
const COOLDOWN_MINUTES = 5;
const ALLOWED_ORIGINS = ["https://progetto-fintech-adfh.vercel.app"];
const PREVIEW_ORIGIN = /^https:\/\/progetto-fintech-adfh-[a-z0-9-]+\.vercel\.app$/;

function send(res, status, body) {
  res.statusCode = status;
  if (body !== undefined) { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); }
  else res.end();
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  const allowed = !origin || ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN.test(origin);
  if (origin && allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return send(res, 204);
  if (req.method !== "POST") return send(res, 405, { ok: false, code: "method", message: "Use POST." });
  if (!allowed) return send(res, 403, { ok: false, code: "origin", message: "Requests are accepted only from the dashboard." });

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return send(res, 503, { ok: false, code: "not_configured", message: "The button is not active yet: the site owner has not configured the GitHub token." });

  const gh = (path, init) => fetch("https://api.github.com/repos/" + REPO + path, Object.assign({}, init, {
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "progetto-fintech-adfh-check-now", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000)
  }));

  try {
    const r = await gh("/actions/workflows/" + WORKFLOW + "/runs?per_page=5");
    if (!r.ok) return send(res, 502, { ok: false, code: "github", message: "GitHub did not answer (HTTP " + r.status + "). Try again later." });
    const runs = (await r.json()).workflow_runs || [];

    const active = runs.find((x) => x.status !== "completed");
    if (active) return send(res, 200, { ok: true, code: "already_running", message: "A check is already running.", run_id: active.id, run_url: active.html_url, created_at: active.created_at });

    const last = runs[0];
    if (last) {
      const ageMin = (Date.now() - Date.parse(last.created_at)) / 60000;
      if (ageMin < COOLDOWN_MINUTES) {
        return send(res, 429, { ok: false, code: "cooldown", message: "A check ran " + Math.max(0, Math.floor(ageMin)) + " minute(s) ago.", retry_after_s: Math.ceil((COOLDOWN_MINUTES - ageMin) * 60), run_id: last.id, run_url: last.html_url, created_at: last.created_at });
      }
    }

    const requestedAt = new Date().toISOString();
    const d = await gh("/actions/workflows/" + WORKFLOW + "/dispatches", { method: "POST", body: JSON.stringify({ ref: "main", inputs: { source: "button" } }) });
    if (d.status !== 204 && d.status !== 200) return send(res, 502, { ok: false, code: "github", message: "GitHub refused to start the check (HTTP " + d.status + ")." });
    return send(res, 202, { ok: true, code: "started", message: "Check started.", requested_at: requestedAt });
  } catch (e) {
    return send(res, 502, { ok: false, code: "error", message: "Could not reach GitHub: " + (e && e.message ? e.message : String(e)) });
  }
};
