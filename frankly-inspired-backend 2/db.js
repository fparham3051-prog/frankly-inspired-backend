/**
 * Optional persistence for the site's five self-scoring diagnostic tools:
 * the Nonprofit Sustainability Self-Assessment ('self-assessment'), the
 * Revenue & Growth Score ('revenue-growth'), the Leadership & Operations
 * Score ('leadership'), the Sustainability Strategy Score ('sustainability'),
 * and the Institutional Advancement Score ('institutional-advancement').
 *
 * Every completed tool already POSTs its scores to /api/assessment-narrative
 * (to fetch its AI summary) — this hooks into that same call to log an
 * anonymized copy of the scores, tagged with which tool produced them. No
 * email, no name, no organization: just the tool, the numbers, and a
 * timestamp. That's what turns "one visitor's result" into a benchmark
 * dataset over time ("the average nonprofit scores X here, yours scores Y")
 * — a real, growing dataset nobody else has, instead of a one-off result.
 *
 * Responses are grouped by tool for benchmarking, since a Revenue & Growth
 * Score composite and a Leadership & Operations Score composite measure
 * different things on different question sets — averaging them together
 * would produce a meaningless number.
 *
 * Entirely optional: if DATABASE_URL isn't set, every function here is a
 * no-op and the rest of the site works exactly as it did before. Nothing
 * about any tool, the narrative, or either email flow depends on this.
 */

const DATABASE_URL = process.env.DATABASE_URL;

// The only tool names this file will ever write or query by — anything
// else gets coerced to 'self-assessment' by the caller in server.js. Kept
// here too as the single source of truth for what a "known tool" is.
const KNOWN_TOOLS = [
  'self-assessment',
  'revenue-growth',
  'leadership',
  'sustainability',
  'institutional-advancement',
  'health-index',
  'candid-seal',
];

let pool = null;
let ready = null;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  // This Postgres instance requires SSL on every connection (confirmed:
  // connecting without it returns "FATAL: SSL/TLS required"), so this
  // stays on unconditionally. connectionTimeoutMillis/query_timeout make
  // sure a bad connection fails fast with a logged error instead of
  // hanging a request forever.
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    query_timeout: 8000,
  });
  // Without this handler, an error on an idle pooled connection is an
  // uncaught exception that crashes the entire Node process — this is a
  // documented pg gotcha, not a hypothetical.
  pool.on('error', (err) => {
    console.error('Unexpected error on idle PG client:', err.message);
  });

  // ADD COLUMN IF NOT EXISTS handles the case where this table already
  // exists in production from before the "tool" column existed — existing
  // rows all get the default 'self-assessment', which is correct, since
  // that was the only tool logging responses before this change.
  ready = pool.query(`
    CREATE TABLE IF NOT EXISTS assessment_responses (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      tool TEXT NOT NULL DEFAULT 'self-assessment',
      score_pct INTEGER NOT NULL,
      band TEXT,
      pillar_scores JSONB NOT NULL
    );
    ALTER TABLE assessment_responses ADD COLUMN IF NOT EXISTS tool TEXT NOT NULL DEFAULT 'self-assessment';
    -- Answer scale the response was given on. 'agreement' = the original
    -- "how true is this" scale (all rows before Nov 2026); 'evidence' = the
    -- InstitutionalOS evidence rubric (not in place ... verified). Benchmarks
    -- only compare responses given on the same scale.
    ALTER TABLE assessment_responses ADD COLUMN IF NOT EXISTS scale TEXT NOT NULL DEFAULT 'agreement';
    -- The situation the visitor picked at the top of the tool ("What's
    -- happening right now?"): expansion, funder, founder, strain,
    -- transition, or checkup. NULL when skipped. Feeds the problem rate.
    ALTER TABLE assessment_responses ADD COLUMN IF NOT EXISTS trigger_key TEXT;
    -- Idea to Legacy results for every finished check-up (Nov 2026), still
    -- anonymous: a random reference (carried into the lead if the visitor
    -- later leaves an email), the measured path, the stage answers, the gap
    -- that will break first, and which Legacy markers are met.
    ALTER TABLE assessment_responses ADD COLUMN IF NOT EXISTS ref TEXT;
    ALTER TABLE assessment_responses ADD COLUMN IF NOT EXISTS path TEXT;
    ALTER TABLE assessment_responses ADD COLUMN IF NOT EXISTS stage_answers JSONB;
    ALTER TABLE assessment_responses ADD COLUMN IF NOT EXISTS gap TEXT;
    ALTER TABLE assessment_responses ADD COLUMN IF NOT EXISTS legacy_met INTEGER;
    ALTER TABLE assessment_responses ADD COLUMN IF NOT EXISTS legacy_markers JSONB;
    -- Check-ups saved part-way with an email ("save my progress"). The
    -- answers and the address are kept only until the visitor finishes or
    -- presses stop; then both are cleared and only the dates remain.
    -- Reminders go weekly until then (first one a day after saving).
    CREATE TABLE IF NOT EXISTS checkup_progress (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      email TEXT,
      fields JSONB,
      answered INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reminders_sent INTEGER NOT NULL DEFAULT 0,
      last_reminded_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      stopped_at TIMESTAMPTZ,
      result_ref TEXT
    );
    -- Opt-in 90-day re-check reminders. One row per request; the row (and
    -- with it the email address) is deleted as soon as the reminder is sent
    -- or cancelled. Nothing else is ever sent to these addresses.
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      email TEXT NOT NULL,
      tool TEXT NOT NULL DEFAULT 'health-index',
      due_at TIMESTAMPTZ NOT NULL,
      token TEXT NOT NULL UNIQUE
    );
    -- Client feedback from /feedback. "permission" is what the client
    -- allowed: 'named' (quote with name and organization), 'anonymous'
    -- (quote with role only), or 'private' (never published).
    -- One row per lead the site produced (contact form, emailed tool
    -- results, client feedback). The operations app's daily reconciliation
    -- compares these refs with its prospects to catch any that never
    -- arrived. Holds no personal data: a reference, a kind, and whether the
    -- direct push succeeded.
    CREATE TABLE IF NOT EXISTS page_counts (
      day DATE NOT NULL,
      path TEXT NOT NULL,
      event TEXT NOT NULL DEFAULT 'view',
      n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, path, event)
    );
    CREATE TABLE IF NOT EXISTS lead_log (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source_ref TEXT NOT NULL,
      kind TEXT NOT NULL,
      pushed BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT,
      organization TEXT,
      rating INTEGER,
      result TEXT,
      quote TEXT,
      permission TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE IF NOT EXISTS site_content (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `).catch(err => {
    console.error('DB init failed — persistence disabled for this run:', err.message);
    pool = null;
  });
} else {
  console.log('DATABASE_URL not set — assessment persistence disabled (everything else still works).');
}

/**
 * Races a promise against a manual timer. This is a deliberate backstop on
 * top of the Pool's own connectionTimeoutMillis/query_timeout: those cover
 * most hangs, but a stalled DNS lookup or TLS handshake can in rare cases
 * sit outside what those options catch. Nothing that touches the database
 * in this file is allowed to make an HTTP request wait longer than this.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fire-and-forget log of one completed tool response. Never throws, never
 * blocks the caller, and never affects what the visitor sees — a DB outage
 * should never break any assessment.
 */
const TRIGGER_KEYS = ['expansion', 'funder', 'founder', 'strain', 'transition', 'checkup'];

async function logAssessmentResponse({ tool, scorePct, band, pillarScores, scale, trigger, ref, path, stageAnswers, gap, legacy }) {
  if (!pool) return;
  const safeTool = KNOWN_TOOLS.includes(tool) ? tool : 'self-assessment';
  try {
    if (ready) await withTimeout(ready, 6000, 'DB init');
    await withTimeout(
      pool.query(
        'INSERT INTO assessment_responses (tool, score_pct, band, pillar_scores, scale, trigger_key, ref, path, stage_answers, gap, legacy_met, legacy_markers) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [safeTool, scorePct, band || null, JSON.stringify(pillarScores), scale === 'evidence' ? 'evidence' : 'agreement', TRIGGER_KEYS.includes(trigger) ? trigger : null,
          ref || null, path || null, stageAnswers ? JSON.stringify(stageAnswers) : null, gap || null,
          legacy ? legacy.met : null, legacy ? JSON.stringify(legacy.markers) : null]
      ),
      6000,
      'insert assessment response'
    );
  } catch (err) {
    console.error('Could not log assessment response:', err.message);
  }
}

/**
 * Aggregate benchmark stats across every response logged so far for ONE
 * tool: overall average score, response count, and the average for each
 * dimension/pillar (matched by label). Returns null if persistence isn't
 * configured, if there's nothing logged yet for this tool, or if the
 * database doesn't respond in time.
 */
async function getBenchmarks(tool, scale) {
  if (!pool) return null;
  const safeTool = KNOWN_TOOLS.includes(tool) ? tool : 'self-assessment';
  const safeScale = scale === 'evidence' ? 'evidence' : 'agreement';
  try {
    if (ready) await withTimeout(ready, 6000, 'DB init');
    const countResult = await withTimeout(
      pool.query(
        'SELECT COUNT(*)::int AS count, AVG(score_pct)::float AS avg_score FROM assessment_responses WHERE tool = $1 AND scale = $2',
        [safeTool, safeScale]
      ),
      6000,
      'count query'
    );
    const count = countResult.rows[0]?.count || 0;
    if (count === 0) return { count: 0, avgScore: null, pillarAverages: [] };

    const pillarResult = await withTimeout(
      pool.query(
        `
        SELECT pillar->>'label' AS label, AVG((pillar->>'pct')::float) AS avg_pct
        FROM assessment_responses, jsonb_array_elements(pillar_scores) AS pillar
        WHERE tool = $1 AND scale = $2
        GROUP BY pillar->>'label'
        ORDER BY label
      `,
        [safeTool, safeScale]
      ),
      6000,
      'pillar query'
    );

    return {
      count,
      avgScore: Math.round(countResult.rows[0].avg_score),
      pillarAverages: pillarResult.rows.map(r => ({ label: r.label, avgPct: Math.round(r.avg_pct) })),
    };
  } catch (err) {
    console.error('Could not fetch benchmarks:', err.message);
    return null;
  }
}

/** Total completed free-tool results (all tools, all scales), for the
 *  homepage proof counter. Null when the database is unavailable. */
async function countResponses() {
  if (!pool) return null;
  try {
    await ready;
    if (!pool) return null;
    const { rows } = await withTimeout(pool.query('SELECT COUNT(*)::int AS n FROM assessment_responses'), 9000, 'countResponses');
    return rows[0].n;
  } catch (err) {
    console.error('countResponses failed:', err.message);
    return null;
  }
}

/** Stores an opt-in re-check reminder. Returns the cancel token, or null. */
async function addReminder({ email, tool, days }) {
  if (!pool) return null;
  try {
    await ready;
    if (!pool) return null;
    const token = require('crypto').randomBytes(18).toString('base64url');
    const safeTool = KNOWN_TOOLS.includes(tool) ? tool : 'health-index';
    // One pending reminder per address and tool: a repeat request moves the date.
    await withTimeout(pool.query('DELETE FROM reminders WHERE lower(email) = lower($1) AND tool = $2', [email, safeTool]), 9000, 'addReminder');
    await withTimeout(pool.query(
      "INSERT INTO reminders (email, tool, due_at, token) VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)",
      [email, safeTool, String(Math.max(1, Math.min(365, days || 90))), token]
    ), 9000, 'addReminder');
    return token;
  } catch (err) {
    console.error('addReminder failed:', err.message);
    return null;
  }
}

async function dueReminders(limit = 50) {
  if (!pool) return [];
  await ready;
  if (!pool) return [];
  const { rows } = await withTimeout(pool.query('SELECT id, email, tool, token FROM reminders WHERE due_at <= now() ORDER BY due_at LIMIT $1', [limit]), 9000, 'dueReminders');
  return rows;
}

async function deleteReminder({ id, token }) {
  if (!pool) return false;
  await ready;
  if (!pool) return false;
  const r = id
    ? await withTimeout(pool.query('DELETE FROM reminders WHERE id = $1', [id]), 9000, 'deleteReminder')
    : await withTimeout(pool.query('DELETE FROM reminders WHERE token = $1', [token]), 9000, 'deleteReminder');
  return r.rowCount > 0;
}

/** Stores one feedback submission. Returns the new id, or null if the DB is off. */
async function addFeedback(f) {
  if (!pool) return null;
  try {
    if (ready) await withTimeout(ready, 6000, 'DB init');
    const r = await withTimeout(pool.query(
      'INSERT INTO feedback (name, email, role, organization, rating, result, quote, permission) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [f.name, f.email, f.role || null, f.organization || null, f.rating, f.result || null, f.quote || null, f.permission]
    ), 6000, 'feedback insert');
    return r.rows[0].id;
  } catch (err) {
    console.error('addFeedback failed:', err.message);
    return null;
  }
}

/** Evidence-rubric responses for the Durability Index (anonymous: tool,
 * scores, and the situation picked, nothing else). Newest 5,000. */
async function durabilityRows() {
  if (!pool) return null;
  try {
    if (ready) await withTimeout(ready, 6000, 'DB init');
    const { rows } = await withTimeout(pool.query(
      "SELECT tool, score_pct, pillar_scores, trigger_key FROM assessment_responses WHERE scale = 'evidence' ORDER BY id DESC LIMIT 5000"
    ), 9000, 'durabilityRows');
    return rows;
  } catch (err) {
    console.error('durabilityRows failed:', err.message);
    return null;
  }
}

/** Small published content blobs (field notes from the operations app). */
async function getContent(key) {
  if (!pool) return null;
  try {
    if (ready) await withTimeout(ready, 6000, 'DB init');
    const { rows } = await withTimeout(pool.query('SELECT value, updated_at FROM site_content WHERE key = $1', [key]), 6000, 'getContent');
    return rows[0] || null;
  } catch (err) { console.error('getContent failed:', err.message); return null; }
}
async function setContent(key, value) {
  if (!pool) return false;
  try {
    if (ready) await withTimeout(ready, 6000, 'DB init');
    await withTimeout(pool.query('INSERT INTO site_content (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [key, value]), 6000, 'setContent');
    return true;
  } catch (err) { console.error('setContent failed:', err.message); return false; }
}

async function logLead({ ref, kind, pushed }) {
  if (!pool || !ref) return;
  try {
    if (ready) await withTimeout(ready, 6000, 'DB init');
    await withTimeout(pool.query('INSERT INTO lead_log (source_ref, kind, pushed) VALUES ($1, $2, $3)', [String(ref).slice(0, 120), kind, !!pushed]), 6000, 'logLead');
  } catch (err) {
    console.error('logLead failed:', err.message);
  }
}

// Completed tools by kind in the last N hours (anonymous; counts only).
async function recentResponseCounts(hours) {
  if (!pool) return null;
  try {
    if (ready) await withTimeout(ready, 6000, 'DB init');
    const { rows } = await withTimeout(pool.query(
      "SELECT tool, count(*)::int AS n FROM assessment_responses WHERE created_at > now() - ($1 || ' hours')::interval GROUP BY tool",
      [String(Math.max(1, Math.min(24 * 14, Number(hours) || 24)))]
    ), 9000, 'recentResponseCounts');
    return rows;
  } catch (err) {
    console.error('recentResponseCounts failed:', err.message);
    return null;
  }
}

async function recentLeads(hours) {
  if (!pool) return null;
  try {
    if (ready) await withTimeout(ready, 6000, 'DB init');
    const { rows } = await withTimeout(pool.query(
      "SELECT source_ref, kind, pushed, created_at FROM lead_log WHERE created_at > now() - ($1 || ' hours')::interval ORDER BY created_at DESC LIMIT 1000",
      [String(Math.max(1, Math.min(24 * 14, Number(hours) || 48)))]
    ), 9000, 'recentLeads');
    return rows;
  } catch (err) {
    console.error('recentLeads failed:', err.message);
    return null;
  }
}

// Full export of every table for the nightly backup the operations app
// collects (GET /api/admin/backup). Read-only.
async function exportAll() {
  if (!pool) return null;
  await ready;
  const t = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
  const tables = {};
  for (const { table_name } of t.rows) {
    const r = await pool.query(`SELECT * FROM "${table_name}"`);
    tables[table_name] = r.rows;
  }
  return { app: 'website-backend', exportedAt: new Date().toISOString(), tables };
}

// Data retention (see the operations app's docs/DATA-RETENTION.md): lead
// references are only needed for the daily reconciliation, so they're
// removed after 180 days. Anonymous scores are kept (no personal data).
async function purgeOld() {
  if (!pool) return null;
  await ready;
  const r = await pool.query("DELETE FROM lead_log WHERE created_at < now() - interval '180 days'");
  const pc = await pool.query("DELETE FROM page_counts WHERE day < CURRENT_DATE - 400");
  return { leadLogDeleted: r.rowCount, pageCountsDeleted: pc.rowCount };
}

// Cookie-free visit counting: page, day, and event name only. No IP, no
// visitor ID, nothing that identifies a person.
async function countPage(path, event) {
  if (!pool) return;
  await ready;
  await pool.query(
    "INSERT INTO page_counts (day, path, event, n) VALUES (CURRENT_DATE, $1, $2, 1) ON CONFLICT (day, path, event) DO UPDATE SET n = page_counts.n + 1",
    [path, event]);
}
async function pageCounts(days) {
  if (!pool) return null;
  await ready;
  const d = Math.min(Math.max(Number(days) || 31, 1), 400);
  const r = await pool.query("SELECT day::text AS day, path, event, n FROM page_counts WHERE day >= CURRENT_DATE - $1::int ORDER BY day", [d]);
  return r.rows;
}

// ---------- saved check-up progress ----------
const PROGRESS_ACTIVE = 'completed_at IS NULL AND stopped_at IS NULL AND email IS NOT NULL';
async function saveProgress({ email, fields, answered, total }) {
  if (!pool) return null;
  await ready;
  const token = require('crypto').randomBytes(18).toString('base64url');
  // One active save per address: a new save replaces the older one, so nobody gets two sets of reminders.
  await pool.query(`UPDATE checkup_progress SET stopped_at = now(), email = NULL, fields = NULL WHERE lower(email) = lower($1) AND ${PROGRESS_ACTIVE}`, [email]);
  await pool.query('INSERT INTO checkup_progress (token, email, fields, answered, total) VALUES ($1, $2, $3, $4, $5)', [token, email, JSON.stringify(fields), answered, total]);
  return token;
}
async function getProgress(token) {
  if (!pool) return null;
  await ready;
  const { rows } = await pool.query(`SELECT id, email, fields, answered, total, created_at, reminders_sent FROM checkup_progress WHERE token = $1 AND ${PROGRESS_ACTIVE}`, [token]);
  return rows[0] || null;
}
async function updateProgress(token, { fields, answered, total }) {
  if (!pool) return false;
  await ready;
  const r = await pool.query(`UPDATE checkup_progress SET fields = $2, answered = $3, total = $4, updated_at = now() WHERE token = $1 AND ${PROGRESS_ACTIVE}`, [token, JSON.stringify(fields), answered, total]);
  return r.rowCount > 0;
}
// Finished or stopped: the address and the answers are cleared at once.
async function endProgress(token, { completed, ref }) {
  if (!pool) return false;
  await ready;
  const r = await pool.query(`UPDATE checkup_progress SET ${completed ? 'completed_at' : 'stopped_at'} = now(), result_ref = COALESCE($2, result_ref), email = NULL, fields = NULL WHERE token = $1 AND completed_at IS NULL AND stopped_at IS NULL`, [token, ref || null]);
  return r.rowCount > 0;
}
// Due: a day after saving for the first reminder, then every seven days.
async function dueProgress(limit = 50) {
  if (!pool) return [];
  await ready;
  const { rows } = await pool.query(`SELECT id, token, email, answered, total, created_at, reminders_sent FROM checkup_progress
    WHERE ${PROGRESS_ACTIVE} AND ((last_reminded_at IS NULL AND created_at <= now() - interval '1 day') OR last_reminded_at <= now() - interval '7 days')
    ORDER BY created_at LIMIT $1`, [limit]);
  return rows;
}
async function markProgressReminded(id) {
  if (!pool) return;
  await pool.query('UPDATE checkup_progress SET reminders_sent = reminders_sent + 1, last_reminded_at = now() WHERE id = $1', [id]);
}
// For the morning brief: what finished check-ups showed, and saved progress.
async function checkupInsights(hours) {
  if (!pool) return null;
  await ready;
  const h = String(Math.max(1, Math.min(24 * 400, Number(hours) || 24)));
  const q = async (sql) => (await withTimeout(pool.query(sql, [h]), 9000, 'checkupInsights')).rows;
  const win = "created_at > now() - ($1 || ' hours')::interval";
  const [paths, gaps, legacy, prog] = await Promise.all([
    q(`SELECT COALESCE(path, 'unknown') AS k, count(*)::int AS n FROM assessment_responses WHERE tool = 'self-assessment' AND ${win} GROUP BY 1`),
    q(`SELECT gap AS k, count(*)::int AS n FROM assessment_responses WHERE tool = 'self-assessment' AND gap IS NOT NULL AND ${win} GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT avg(legacy_met)::float AS avg, count(legacy_met)::int AS n FROM assessment_responses WHERE tool = 'self-assessment' AND ${win}`),
    q(`SELECT
         count(*) FILTER (WHERE ${PROGRESS_ACTIVE})::int AS in_progress,
         count(*) FILTER (WHERE ${win})::int AS saved,
         count(*) FILTER (WHERE completed_at > now() - ($1 || ' hours')::interval)::int AS finished_after_saving,
         count(*) FILTER (WHERE last_reminded_at > now() - ($1 || ' hours')::interval)::int AS reminded
       FROM checkup_progress`),
  ]);
  const byPath = Object.fromEntries(paths.map((r) => [r.k, r.n]));
  return {
    byPath, gaps: gaps.map((r) => ({ gap: r.k, n: r.n })),
    legacyAvg: legacy[0] && legacy[0].n ? Math.round(legacy[0].avg * 10) / 10 : null,
    progress: { inProgress: prog[0].in_progress, saved: prog[0].saved, finishedAfterSaving: prog[0].finished_after_saving, reminded: prog[0].reminded },
  };
}

module.exports = { saveProgress, getProgress, updateProgress, endProgress, dueProgress, markProgressReminded, checkupInsights, getContent, setContent, countPage, pageCounts, purgeOld, exportAll, logLead, recentLeads, recentResponseCounts, durabilityRows, addFeedback, logAssessmentResponse, getBenchmarks, KNOWN_TOOLS, countResponses, addReminder, dueReminders, deleteReminder };
