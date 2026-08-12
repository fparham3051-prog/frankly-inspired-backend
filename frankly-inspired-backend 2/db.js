/**
 * Optional persistence for the self-assessment tool.
 *
 * Every completed assessment already POSTs its scores to
 * /api/assessment-narrative (to fetch the AI summary) — this hooks into that
 * same call to log an anonymized copy of the scores. No email, no name, no
 * organization: just the numbers and a timestamp. That's what turns "one
 * visitor's result" into a benchmark dataset over time ("the average
 * nonprofit scores X on stewardship, yours scores Y").
 *
 * Entirely optional: if DATABASE_URL isn't set, every function here is a
 * no-op and the rest of the site works exactly as it did before. Nothing
 * about the assessment, the narrative, or either email flow depends on this.
 */

const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
let ready = null;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  ready = pool.query(`
    CREATE TABLE IF NOT EXISTS assessment_responses (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      score_pct INTEGER NOT NULL,
      band TEXT,
      pillar_scores JSONB NOT NULL
    );
  `).catch(err => {
    console.error('DB init failed — persistence disabled for this run:', err.message);
    pool = null;
  });
} else {
  console.log('DATABASE_URL not set — assessment persistence disabled (everything else still works).');
}

/**
 * Fire-and-forget log of one completed assessment. Never throws, never
 * blocks the caller, and never affects what the visitor sees — a DB outage
 * should never break the assessment itself.
 */
async function logAssessmentResponse({ scorePct, band, pillarScores }) {
  if (!pool) return;
  try {
    if (ready) await ready;
    await pool.query(
      'INSERT INTO assessment_responses (score_pct, band, pillar_scores) VALUES ($1, $2, $3)',
      [scorePct, band || null, JSON.stringify(pillarScores)]
    );
  } catch (err) {
    console.error('Could not log assessment response:', err.message);
  }
}

/**
 * Aggregate benchmark stats across every response logged so far: overall
 * average score, response count, and the average for each pillar (matched
 * by label). Returns null if persistence isn't configured or there's
 * nothing logged yet.
 */
async function getBenchmarks() {
  if (!pool) return null;
  try {
    if (ready) await ready;
    const countResult = await pool.query('SELECT COUNT(*)::int AS count, AVG(score_pct)::float AS avg_score FROM assessment_responses');
    const count = countResult.rows[0]?.count || 0;
    if (count === 0) return { count: 0, avgScore: null, pillarAverages: [] };

    const pillarResult = await pool.query(`
      SELECT pillar->>'label' AS label, AVG((pillar->>'pct')::float) AS avg_pct
      FROM assessment_responses, jsonb_array_elements(pillar_scores) AS pillar
      GROUP BY pillar->>'label'
      ORDER BY label
    `);

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

module.exports = { logAssessmentResponse, getBenchmarks };
