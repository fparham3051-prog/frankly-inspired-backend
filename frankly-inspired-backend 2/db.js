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
    ssl: { rejectUnauthorized: false },
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

async function logAssessmentResponse({ tool, scorePct, band, pillarScores, scale, trigger }) {
  if (!pool) return;
  const safeTool = KNOWN_TOOLS.includes(tool) ? tool : 'self-assessment';
  try {
    if (ready) await withTimeout(ready, 6000, 'DB init');
    await withTimeout(
      pool.query(
        'INSERT INTO assessment_responses (tool, score_pct, band, pillar_scores, scale, trigger_key) VALUES ($1, $2, $3, $4, $5, $6)',
        [safeTool, scorePct, band || null, JSON.stringify(pillarScores), scale === 'evidence' ? 'evidence' : 'agreement', TRIGGER_KEYS.includes(trigger) ? trigger : null]
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

module.exports = { durabilityRows, addFeedback, logAssessmentResponse, getBenchmarks, KNOWN_TOOLS, countResponses, addReminder, dueReminders, deleteReminder };
