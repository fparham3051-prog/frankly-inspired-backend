
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
  scorecardResultsEmail,
  scorecardLeadNotificationEmail,
} = require('./emailTemplates');
const { generateAssessmentNarrative } = require('./aiNarrative');
const { logAssessmentResponse, getBenchmarks, KNOWN_TOOLS } = require('./db');
const { makeScoreRef, verifyScoreRef } = require('./scoreRef');
const { pushProspect, getGivingLandscape, osConfigured } = require('./osClient');
const { mapToHealthIndex, formatHealthIndex } = require('./healthIndex');
const crypto = require('crypto');
 
const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Frankly Inspired <onboarding@resend.dev>';
const TO_EMAIL = process.env.TO_EMAIL || 'franklin@franklyinspired.associates';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
// A copy of every website lead notification also goes here, so the
// Frankly Inspired Operating System's lead-import automation can find them
// via Gmail search — the OS reads Franklin's Gmail, not this Google
// Workspace inbox, which the OS has no access to. Override or blank this
// out via the LEAD_COPY_EMAIL env var if that behavior isn't wanted.
const LEAD_COPY_EMAIL = process.env.LEAD_COPY_EMAIL || 'fparham3051@gmail.com';
 
// Display name for each of the five self-scoring tools, used as the
// score_ref token's "stage" field so the contact-page banner reads
// naturally ("Continuing from your Revenue & Growth scorecard: 62/100")
// even though these tools don't have an InstitutionalOS BUILD/FUND/SUSTAIN
// stage of their own.
const TOOL_DISPLAY_NAMES = {
  'self-assessment': 'Sustainability Self-Assessment',
  'revenue-growth': 'Revenue & Growth',
  leadership: 'Leadership & Operations',
  sustainability: 'Sustainability Strategy',
  'institutional-advancement': 'Institutional Advancement',
};
 
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
// Only the form submissions get the strict limit. The narrative and
// benchmark calls fire automatically on every tool result, so sharing one
// 5-per-15-minutes budget with them meant a visitor who finished two tools
// and then tried to email results or contact Franklin could be blocked.
app.use(['/api/contact', '/api/assessment-lead'], limiter);
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  // Server-to-server calls from the scorecard all come from one address and
  // are authenticated by a shared secret instead.
  skip: (req) => req.path === '/scorecard-results',
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please try again later.' },
}));
 
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'frankly-inspired-backend' });
});
 
/* ------------------------------------------------------------------ */
/* GET /api/score-ref?token=...                                        */
/* Decodes and verifies a score_ref token minted by grantpass-backend  */
/* when a visitor completes the free InstitutionalOS scorecard, so the */
/* consulting site's contact page can show a personalized "continuing  */
/* from your score" banner before the form is even submitted. Returns  */
/* 404 (not an error) for a missing, tampered, or expired token - the  */
/* frontend just skips the banner in that case.                        */
/* ------------------------------------------------------------------ */
app.get('/api/score-ref', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const payload = verifyScoreRef(token);
  if (!payload) {
    return res.status(404).json({ ok: false, error: 'Not found or expired.' });
  }
  return res.json({ ok: true, stage: payload.stage, score: payload.score, band: payload.band, source: payload.src || null });
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
 
  // If this visitor arrived carrying a score_ref (they completed the free
  // InstitutionalOS scorecard and clicked through to this form), verify it
  // server-side against the shared secret. An invalid, tampered, or expired
  // token is just treated as absent - it never blocks the submission.
  const scoreContext = typeof body.score_ref === 'string' ? verifyScoreRef(body.score_ref) : null;
 
  // Straight into the operations app's Prospecting view. Best-effort: if it
  // fails or isn't configured, the email below (with its lead reference)
  // lets the daily Gmail import add it instead, without duplicating.
  const leadRef = 'web-contact-' + crypto.randomUUID();
  const contactNotes = [
    fields.title && fields.title !== 'Not provided' && `Title: ${fields.title}`,
    `Email: ${fields.email}`,
    fields.phone && `Phone: ${fields.phone}`,
    fields.org_website && `Website: ${fields.org_website}`,
    supportArea.filter(a => a !== 'Not specified').length && `Support area(s): ${supportArea.filter(a => a !== 'Not specified').join(', ')}`,
    fields.timeline && `Timeline: ${fields.timeline}`,
    fields.referral && `Referral: ${fields.referral}`,
    scoreContext && `Arrived from ${scoreContext.stage || 'a free tool'}: ${scoreContext.score != null ? scoreContext.score + '/100' : ''} ${scoreContext.band ? '(' + scoreContext.band + ')' : ''}`.trim(),
    `Challenge: ${String(fields.challenge || '').trim()}`,
  ].filter(Boolean).join('\n');
  const osAdded = await pushProspect({
    name: String(fields.name).trim(),
    org: String(fields.organization || '').trim(),
    source: 'website contact form',
    notes: contactNotes,
    sourceRef: leadRef,
  });

  try {
    const ack = contactAcknowledgementEmail(fields);
    const notify = contactNotificationEmail(fields, scoreContext, leadRef, osAdded);
 
    // Sent as separate calls per recipient, not one call with an array of
    // "to" addresses. While this account is still sending from Resend's
    // shared onboarding@resend.dev sender (no verified custom domain — see
    // FROM_EMAIL above), Resend restricts delivery to the account's own
    // verified address; bundling a second recipient into the same call can
    // cause the whole send to silently fail delivery to both. Separate
    // calls mean each recipient succeeds or fails independently. Logged,
    // not thrown either way, so one bad address never blocks the others or
    // fails the visitor's form submission.
    const notifyTargets = [TO_EMAIL, LEAD_COPY_EMAIL].filter(Boolean);
    const sendResults = await Promise.all([
      resend.emails.send({
        from: FROM_EMAIL,
        to: fields.email,
        subject: ack.subject,
        html: ack.html,
      }),
      ...notifyTargets.map(addr => resend.emails.send({
        from: FROM_EMAIL,
        to: addr,
        replyTo: fields.email,
        subject: notify.subject,
        html: notify.html,
      })),
    ]);
    sendResults.forEach(r => {
      if (r && r.error) console.error('POST /api/contact: Resend reported a delivery error:', r.error);
    });
 
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
 
  const tool = KNOWN_TOOLS.includes(body.tool) ? body.tool : 'self-assessment';
  const healthIndex = mapToHealthIndex(tool, body.pillarScores);
  const payload = {
    email: body.email,
    scorePct: body.scorePct,
    band: body.band,
    pillarScores: body.pillarScores,
    narrative: typeof body.narrative === 'string' ? body.narrative : null,
    tool,
    toolName: TOOL_DISPLAY_NAMES[tool] || 'Sustainability Self-Assessment',
    healthIndex,
  };

  const leadRef = 'web-tool-' + crypto.randomUUID();
  const toolNotes = [
    `Tool: ${payload.toolName}`,
    `Composite score: ${Math.round(payload.scorePct)}%${payload.band ? ' (' + payload.band + ')' : ''}`,
    'By area: ' + payload.pillarScores.map(p => `${p.label} ${Math.round(p.pct)}%`).join(', '),
    formatHealthIndex(healthIndex),
  ].filter(Boolean).join('\n');
  const osAdded = await pushProspect({
    name: String(body.email).trim(),
    org: '',
    source: 'assessment tool',
    notes: toolNotes,
    sourceRef: leadRef,
  });

  try {
    const results = assessmentResultsEmail(payload);
    const notify = assessmentLeadNotificationEmail(payload, leadRef, osAdded);
 
    // See the matching comment in POST /api/contact: separate send() calls
    // per recipient, not one call with multiple "to" addresses.
    const notifyTargets = [TO_EMAIL, LEAD_COPY_EMAIL].filter(Boolean);
    const sendResults = await Promise.all([
      resend.emails.send({
        from: FROM_EMAIL,
        to: payload.email,
        subject: results.subject,
        html: results.html,
      }),
      ...notifyTargets.map(addr => resend.emails.send({
        from: FROM_EMAIL,
        to: addr,
        subject: notify.subject,
        html: notify.html,
      })),
    ]);
    sendResults.forEach(r => {
      if (r && r.error) console.error('POST /api/assessment-lead: Resend reported a delivery error:', r.error);
    });
 
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
 
  // Signed score_ref token, same mechanism the InstitutionalOS scorecard
  // uses: carries this result into the contact page so a visitor who
  // clicks through doesn't have to re-explain themselves. null (not an
  // error) if SCORE_REF_SECRET isn't configured.
  const score_ref = makeScoreRef({
    stage: TOOL_DISPLAY_NAMES[tool] || tool,
    score: Math.round(body.scorePct),
    band: typeof body.band === 'string' ? body.band : null,
    src: tool,
  });
 
  // narrative is null on any failure (missing key, API error, timeout) —
  // the frontend already has a static fallback description for this case,
  // so we return ok:true either way and just omit narrative when absent.
  return res.json({ ok: true, narrative, score_ref });
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
 
/* ------------------------------------------------------------------ */
/* POST /api/scorecard-results                                         */
/* Called by the InstitutionalOS scorecard service (not by browsers)   */
/* when a visitor leaves their email after a result. Emails the visitor */
/* their result and notifies Franklin. Requires the shared secret in    */
/* SCORECARD_MAIL_SECRET (same value set on grantpass-backend).        */
/* ------------------------------------------------------------------ */
const SCORECARD_MAIL_SECRET = process.env.SCORECARD_MAIL_SECRET || '';
app.post('/api/scorecard-results', async (req, res) => {
  const provided = req.get('X-Scorecard-Secret') || '';
  const ok = SCORECARD_MAIL_SECRET && provided.length === SCORECARD_MAIL_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(SCORECARD_MAIL_SECRET));
  if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const body = req.body || {};
  if (!isValidEmail(body.email) || typeof body.overall !== 'number' || !Array.isArray(body.dimensions)) {
    return res.status(400).json({ ok: false, error: 'email, overall and dimensions are required' });
  }
  const r = {
    stage: String(body.stage || ''),
    stageName: String(body.stageName || body.stage || ''),
    overall: body.overall,
    band: String(body.band || ''),
    decision: String(body.decision || ''),
    orgName: String(body.orgName || '').slice(0, 200),
    continueUrl: /^https:\/\/franklyinspired\.associates\//.test(String(body.continueUrl || '')) ? body.continueUrl : 'https://franklyinspired.associates/#contact',
    dimensions: body.dimensions.slice(0, 7).map(d => ({
      name: String((d && d.name) || ''),
      score: Number(d && d.score) || 0,
      note: String((d && d.note) || '').slice(0, 300),
      liftTarget: typeof (d && d.liftTarget) === 'number' ? d.liftTarget : undefined,
    })),
  };
  const leadRef = typeof body.leadRef === 'string' ? body.leadRef.slice(0, 80) : '';
  const osAdded = body.osAdded === true;

  try {
    const results = scorecardResultsEmail(r);
    const notify = scorecardLeadNotificationEmail(r, body.email, leadRef, osAdded);
    const notifyTargets = [TO_EMAIL, LEAD_COPY_EMAIL].filter(Boolean);
    const sendResults = await Promise.all([
      resend.emails.send({ from: FROM_EMAIL, to: body.email, subject: results.subject, html: results.html }),
      ...notifyTargets.map(addr => resend.emails.send({
        from: FROM_EMAIL, to: addr, replyTo: body.email, subject: notify.subject, html: notify.html,
      })),
    ]);
    const visitorError = sendResults[0] && sendResults[0].error;
    sendResults.forEach(x => { if (x && x.error) console.error('POST /api/scorecard-results: Resend error:', x.error); });
    return res.json({ ok: !visitorError, emailed: !visitorError });
  } catch (err) {
    console.error('POST /api/scorecard-results failed:', err);
    return res.status(502).json({ ok: false, error: 'Could not send email right now.' });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/giving-landscape                                           */
/* Recent public major gifts from the operations app's Giving           */
/* Landscape, for the website's Insights page. Only gifts marked public */
/* in the app are ever returned. Cached for an hour.                    */
/* ------------------------------------------------------------------ */
app.get('/api/giving-landscape', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 12);
  const gifts = await getGivingLandscape(limit);
  res.set('Cache-Control', 'public, max-age=900');
  res.json({ ok: true, gifts: gifts || [] });
});

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
 
app.listen(PORT, () => {
  console.log(`Frankly Inspired backend listening on port ${PORT}`);
  console.log(osConfigured()
    ? 'Operations app connection: on (leads go straight to Prospecting).'
    : 'Operations app connection: off (set OS_API_URL and OS_PROSPECTS_TOKEN); leads reach the app via the daily email import.');
});
