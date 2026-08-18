/**
 * Frankly Inspired and Associates, LLC — website backend
 *
 * Four jobs:
 *   POST /api/contact              — the Contact form on index.html
 *   POST /api/assessment-lead      — the "email my results" form on assessment.html
 *   POST /api/assessment-narrative — AI-generated personalized result summary,
 *                                    shared by all five self-scoring tools
 *                                    (self-assessment, revenue-growth,
 *                                    leadership, sustainability,
 *                                    institutional-advancement) via a `tool`
 *                                    field. Also logs an anonymized copy of
 *                                    the scores for benchmarking, if
 *                                    DATABASE_URL is set — see db.js.
 *   GET  /api/benchmarks           — aggregate stats for one tool
 *
 * All endpoints validate input and reject obvious spam via a honeypot field
 * where applicable. See README.md for deployment and environment variables.
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Resend } = require('resend');

const {
  contactAcknowledgementEmail,
  contactNotificationEmail,
  assessmentResultsEmail,
  assessmentLeadNotificationEmail,
} = require('./emailTemplates');
const { generateAssessmentNarrative } = require('./aiNarrative');
const { logAssessmentResponse, getBenchmarks, KNOWN_TOOLS } = require('./db');

const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Frankly Inspired <onboarding@resend.dev>';
const TO_EMAIL = process.env.TO_EMAIL || 'franklin@franklyinspired.associates';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!RESEND_API_KEY) {
  // Fail loudly at boot rather than silently dropping every email later.
  console.error('FATAL: RESEND_API_KEY is not set. Set it in the Render service\'s environment variables.');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map(s => s.trim()) }));

// Basic abuse protection: 5 submissions per 15 minutes per IP, shared across
// both endpoints. This is not sophisticated spam protection — it's a floor,
// not a ceiling. See README.md if this needs to be tightened later.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many submissions. Please try again later.' },
});
app.use('/api/', limiter);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'frankly-inspired-backend' });
});

/* ------------------------------------------------------------------ */
/* POST /api/contact                                                   */
/* ------------------------------------------------------------------ */
app.post('/api/contact', async (req, res) => {
  const body = req.body || {};

  // Honeypot: a real visitor never fills this field in (it's visually
  // hidden). A bot that fills every field will trip it. Reply success
  // without sending anything, so the bot doesn't learn it was caught.
  if (body.hp_field) {
    return res.json({ ok: true });
  }

  const required = ['name', 'organization', 'title', 'email', 'challenge'];
  const missing = required.filter(f => !String(body[f] || '').trim());
  if (missing.length) {
    return res.status(400).json({ ok: false, error: `Missing required field(s): ${missing.join(', ')}` });
  }
  if (!isValidEmail(body.email)) {
    return res.status(400).json({ ok: false, error: 'Please provide a valid email address.' });
  }
  const supportArea = Array.isArray(body.support_area) ? body.support_area : (body.support_area ? [body.support_area] : []);
  if (supportArea.length === 0) {
    return res.status(400).json({ ok: false, error: 'Please select at least one area under "How can I support your organization?"' });
  }

  const fields = { ...body, support_area: supportArea };

  try {
    const ack = contactAcknowledgementEmail(fields);
    const notify = contactNotificationEmail(fields);

    await Promise.all([
      resend.emails.send({
        from: FROM_EMAIL,
        to: fields.email,
        subject: ack.subject,
        html: ack.html,
      }),
      resend.emails.send({
        from: FROM_EMAIL,
        to: TO_EMAIL,
        replyTo: fields.email,
        subject: notify.subject,
        html: notify.html,
      }),
    ]);

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/contact failed:', err);
    return res.status(502).json({ ok: false, error: 'Could not send email right now. Please try again shortly, or email franklin@franklyinspired.associates directly.' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/assessment-lead                                           */
/* ------------------------------------------------------------------ */
app.post('/api/assessment-lead', async (req, res) => {
  const body = req.body || {};

  if (body.hp_field) {
    return res.json({ ok: true });
  }

  if (!isValidEmail(body.email)) {
    return res.status(400).json({ ok: false, error: 'Please provide a valid email address.' });
  }
  if (typeof body.scorePct !== 'number' || !Array.isArray(body.pillarScores)) {
    return res.status(400).json({ ok: false, error: 'Missing assessment results.' });
  }

  const payload = {
    email: body.email,
    scorePct: body.scorePct,
    band: body.band,
    pillarScores: body.pillarScores,
    narrative: typeof body.narrative === 'string' ? body.narrative : null,
  };

  try {
    const results = assessmentResultsEmail(payload);
    const notify = assessmentLeadNotificationEmail(payload);

    await Promise.all([
      resend.emails.send({
        from: FROM_EMAIL,
        to: payload.email,
        subject: results.subject,
        html: results.html,
      }),
      resend.emails.send({
        from: FROM_EMAIL,
        to: TO_EMAIL,
        subject: notify.subject,
        html: notify.html,
      }),
    ]);

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/assessment-lead failed:', err);
    return res.status(502).json({ ok: false, error: 'Could not send email right now. Please try again shortly.' });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/assessment-narrative                                      */
/* Shared by all five self-scoring tools. `tool` selects which system   */
/* prompt aiNarrative.js uses and which bucket db.js logs/benchmarks    */
/* against — an unrecognized or missing value safely falls back to      */
/* 'self-assessment' rather than erroring, same graceful-degradation    */
/* philosophy as the rest of this endpoint.                            */
/* ------------------------------------------------------------------ */
app.post('/api/assessment-narrative', async (req, res) => {
  const body = req.body || {};

  if (typeof body.scorePct !== 'number' || !Array.isArray(body.pillarScores) || body.pillarScores.length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing assessment results.' });
  }
  const pillarsValid = body.pillarScores.every(p => p && typeof p.label === 'string' && typeof p.pct === 'number');
  if (!pillarsValid) {
    return res.status(400).json({ ok: false, error: 'Malformed pillar scores.' });
  }

  const tool = KNOWN_TOOLS.includes(body.tool) ? body.tool : 'self-assessment';

  const narrative = await generateAssessmentNarrative({
    tool,
    scorePct: body.scorePct,
    band: typeof body.band === 'string' ? body.band : '',
    pillarScores: body.pillarScores,
  });

  // Anonymized log for the benchmark dataset — no email, no org, just the
  // tool, the scores, and a timestamp. Fire-and-forget: never awaited into
  // the response, never a reason for this endpoint to fail.
  logAssessmentResponse({
    tool,
    scorePct: body.scorePct,
    band: typeof body.band === 'string' ? body.band : '',
    pillarScores: body.pillarScores,
  });

  // narrative is null on any failure (missing key, API error, timeout) —
  // the frontend already has a static fallback description for this case,
  // so we return ok:true either way and just omit narrative when absent.
  return res.json({ ok: true, narrative });
});

/* ------------------------------------------------------------------ */
/* GET /api/benchmarks?tool=X                                          */
/* Aggregate stats across every logged response so far, scoped to one   */
/* tool (defaults to 'self-assessment' if omitted, for backward         */
/* compatibility with the original single-tool caller). Returns null    */
/* fields if persistence isn't configured or nothing has been logged    */
/* yet — never errors, since this is informational only.               */
/* ------------------------------------------------------------------ */
app.get('/api/benchmarks', async (req, res) => {
  const tool = KNOWN_TOOLS.includes(req.query.tool) ? req.query.tool : 'self-assessment';
  const benchmarks = await getBenchmarks(tool);
  res.json({ ok: true, benchmarks });
});

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

app.listen(PORT, () => {
  console.log(`Frankly Inspired backend listening on port ${PORT}`);
});
