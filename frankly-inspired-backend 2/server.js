
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
  recheckReminderEmail,
  checkinReminderEmail,
  feedbackNotificationEmail,
  feedbackThanksEmail,
  progressSavedEmail,
  progressReminderEmail,
} = require('./emailTemplates');
const { generateAssessmentNarrative, answerQuestion } = require('./aiNarrative');
const { getContent, setContent, countPage, pageCounts, purgeOld, exportAll, logLead, recentLeads, recentResponseCounts, durabilityRows, addFeedback, logAssessmentResponse, getBenchmarks, KNOWN_TOOLS, countResponses, addReminder, dueReminders, deleteReminder, saveProgress, getProgress, updateProgress, endProgress, dueProgress, markProgressReminded, checkupInsights } = require('./db');
const { makeScoreRef, verifyScoreRef } = require('./scoreRef');
const { pushFeedback, pushProspect, getGivingLandscape, osConfigured } = require('./osClient');
const { mapToHealthIndex, formatHealthIndex } = require('./healthIndex');
const { searchOrgs, orgSnapshot, fmtEin } = require('./org990');
const crypto = require('crypto');
const { textLead, smsConfigured } = require('./sms');
 
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
// Stage the visitor picked in the tool's results (Build / Fund / Sustain),
// which decides which diagnostic fits.
// Offer keys shared with the operations app (FIOS OFFERING_LABELS and
// pipeline tracks). The site's contact checkboxes map onto them so a lead
// arrives with the offer it asked about, and promoting it to Pipeline sets
// the right track and Diagnostic stage automatically.
const SUPPORT_AREA_TO_INTEREST = {
  'InstitutionalOS Diagnostic': 'institutionalos-diagnostic',
  'Advisory and Implementation Retainer': 'retainer',
  'Ongoing Advisory and Implementation': 'retainer', // older form label
  'Project Based Engagement': 'project',
  '1:1 Executive Coaching': 'coaching',
  'Speaking and Board Service': 'speaking',
};
const STAGE_FROM_SCORE = { BUILD: 'build', FUND: 'fund', SUSTAIN: 'sustain' };
// "What's happening right now?" on every free tool (website src/scripts/trigger.ts).
// Health Index dimension label -> the key FIOS and InstitutionalOS use.
const DIMENSION_KEYS = {
  'Strategy and Positioning': 'strategy', 'Program and Impact Evidence': 'program',
  'Revenue and Financial Health': 'revenue', 'Leadership and Organizational Capacity': 'leadership',
  'Operations and Infrastructure': 'operations', 'Partnerships and Ecosystem': 'partnerships',
  'Governance and Risk': 'governance',
};
/** {key: pct} from mapToHealthIndex rows: the visitor's self-assessment. */
function selfScoresFrom(rows) {
  const out = {};
  for (const r of rows || []) { const k = DIMENSION_KEYS[r.dimension]; if (k) out[k] = r.pct; }
  return Object.keys(out).length ? out : undefined;
}
// Plain words, as the visitor saw them (messaging system, Nov 2026).
const TRIGGER_LABELS = {
  expansion: 'Adding a site, city, or major program',
  funder: 'Going after bigger funding, or a major grant is ending',
  founder: 'Too much depends on one leader',
  strain: 'Growing, but staff and systems are stretched',
  transition: 'A leadership change is coming',
  checkup: 'No specific trigger, a check-up',
};

const REC_LABELS = {
  diagnostic: 'Diagnostic',
  debrief: 'Free debrief call',
  self: 'Free 90-day step, re-check in 90 days',
};

const STAGE_LABELS = {
  build: 'Build: get the foundation right ($2,000 Diagnostic)',
  fund: 'Fund: get ready for bigger money ($2,500 Diagnostic)',
  sustain: 'Sustain: make it last beyond one person ($2,500 Diagnostic)',
};
// The path a situation usually points to (same rule as the website's check-up).
const TRIGGER_PATH = { expansion: 'fund', funder: 'fund', strain: 'fund', founder: 'sustain', transition: 'sustain' };
const PATH_LABELS = { build: 'Build: get the foundation right', fund: 'Fund: get ready for bigger money', sustain: 'Sustain: make it last beyond one person' };
// Idea to Legacy (Nov 2026): the check-up's stage questions and Legacy Readiness.
const STAGE_OPTS = {
  budget: ['under $250K', '$250K to $1M', '$1M to $5M', 'over $5M'],
  staff: ['0-2 staff', '3-10 staff', '11-40 staff', '40+ staff'],
  years: ['under 3 years', '3-7 years', '8-15 years', '15+ years'],
  decide: ['founder/ED decides alone', 'ED plus one or two others', 'leadership team with written roles'],
};
function stageFacts(sa) {
  if (!sa || typeof sa !== 'object') return '';
  return Object.keys(STAGE_OPTS).map((k) => STAGE_OPTS[k][Number(sa[k])]).filter(Boolean).join(', ');
}
function cleanLegacy(l) {
  if (!l || typeof l !== 'object') return null;
  const met = Math.max(0, Math.min(6, Number(l.met) || 0));
  const missing = Array.isArray(l.missing) ? l.missing.slice(0, 6).map((m) => cleanText(String(m), 60)).filter(Boolean) : [];
  return { met, total: 6, missing };
}
const cleanText = (v, n) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, n) : '');

const TOOL_DISPLAY_NAMES = {
  'self-assessment': 'Sustainability Self-Assessment',
  'revenue-growth': 'Revenue & Growth',
  leadership: 'Leadership & Operations',
  sustainability: 'Sustainability Strategy',
  'institutional-advancement': 'Institutional Advancement',
  'health-index': 'InstitutionalOS Health Index',
  'candid-seal': 'Candid Seal Path',
};
 
if (!RESEND_API_KEY) {
  // Fail loudly at boot rather than silently dropping every email later.
  console.error('FATAL: RESEND_API_KEY is not set. Set it in the Render service\'s environment variables.');
  process.exit(1);
}
 
const resend = new Resend(RESEND_API_KEY);
 
const app = express();
// Render puts one proxy in front of this server. Without this, every visitor
// looks like the same address, so the per-visitor limits below were shared by
// everyone (five contact or tool submissions in 15 minutes for the whole site).
app.set('trust proxy', 1);
// The AI relay carries documents (PDFs) for the Diagnostic first pass, so it
// gets a larger body limit than every other route.
app.use('/api/admin/ai', express.json({ limit: '32mb' }));
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
app.use(['/api/contact', '/api/assessment-lead', '/api/reminders', '/api/subscribe'], limiter);
// Saving progress emails the visitor, so it shares the strict form budget; later updates to a save don't.
app.post('/api/checkup-progress', limiter);
// The results assistant calls the AI model, so it gets its own budget:
// 10 questions per visitor per 15 minutes.
app.use('/api/ask', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'You\'ve asked a lot of questions in a short time. Please try again in a few minutes.' },
}));
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  // Server-to-server calls from the scorecard all come from one address and
  // are authenticated by a shared secret instead.
  skip: (req) => req.path === '/scorecard-results' || req.path === '/admin/ai',
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests. Please try again later.' },
}));
 
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'frankly-inspired-backend', textAlerts: smsConfigured() });
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
  const interest = supportArea.map((a) => SUPPORT_AREA_TO_INTEREST[a]).find(Boolean) || '';
  const orgStage = STAGE_LABELS[body.stage] ? body.stage
    : (scoreContext && STAGE_FROM_SCORE[String(scoreContext.stage || '').toUpperCase()]) || '';
  const osAdded = await pushProspect({
    name: String(fields.name).trim(),
    org: String(fields.organization || '').trim(),
    source: 'website contact form',
    notes: contactNotes + (orgStage ? `\nStage: ${STAGE_LABELS[orgStage]}` : '') + (TRIGGER_LABELS[body.trigger] ? `\nSituation: ${TRIGGER_LABELS[body.trigger]}` : ''),
    sourceRef: leadRef,
    interest,
    orgStage,
    trigger: TRIGGER_LABELS[body.trigger] ? body.trigger : '',
  });
  logLead({ ref: leadRef, kind: 'contact', pushed: osAdded });
  textLead({ kind: 'New contact form', name: fields.name, org: fields.organization, detail: fields.timeline ? `Timeline: ${fields.timeline}.` : '' });

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
/* POST /api/admin/ai: AI relay for the operations app. The Anthropic  */
/* key lives only here; the operations app sends a system prompt and   */
/* messages (text or PDF document blocks) with the shared admin secret */
/* and gets the text back. Nothing is stored.                          */
/* ------------------------------------------------------------------ */
app.get('/api/admin/ai', (req, res) => {
  const secret = process.env.REMINDER_SECRET || '';
  if (!secret || req.get('X-Reminder-Secret') !== secret) return res.status(401).json({ ok: false });
  res.json({ ok: true, configured: !!process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5' });
});
app.post('/api/admin/ai', async (req, res) => {
  const secret = process.env.REMINDER_SECRET || '';
  if (!secret || req.get('X-Reminder-Secret') !== secret) return res.status(401).json({ ok: false });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'AI is not set up on the website server (ANTHROPIC_API_KEY).' });
  const b = req.body || {};
  if (!Array.isArray(b.messages) || !b.messages.length) return res.status(400).json({ ok: false, error: 'messages required' });
  const models = [...new Set([process.env.ANTHROPIC_MODEL || 'claude-sonnet-5', 'claude-sonnet-5-5'])];
  const url = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
  let last = '';
  for (const model of models) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: Math.min(Math.max(Number(b.maxTokens) || 1500, 100), 8000), system: String(b.system || '').slice(0, 60000), messages: b.messages }),
        signal: AbortSignal.timeout(170000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 404 || (j.error && /model/i.test(String(j.error.message || '')) && r.status === 400)) { last = (j.error && j.error.message) || 'model not found'; continue; }
      if (!r.ok) return res.status(502).json({ ok: false, error: (j.error && j.error.message) || 'AI service returned ' + r.status });
      const text = (j.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('').trim();
      return res.json({ ok: true, text, model, usage: j.usage || null });
    } catch (err) { last = err.message; }
  }
  return res.status(502).json({ ok: false, error: last || 'AI service unavailable' });
});

/* ------------------------------------------------------------------ */
/* Field notes published from the operations app. It sends the whole    */
/* published list (replace-all); the Insights page reads it.            */
/* ------------------------------------------------------------------ */
app.post('/api/admin/field-notes', async (req, res) => {
  const secret = process.env.REMINDER_SECRET || '';
  if (!secret || req.get('X-Reminder-Secret') !== secret) return res.status(401).json({ ok: false });
  const notes = Array.isArray((req.body || {}).notes) ? req.body.notes.slice(0, 50) : null;
  if (!notes) return res.status(400).json({ ok: false, error: 'notes required' });
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  const clean = notes.map((x) => ({ id: s(x.id, 40).replace(/[^\w-]/g, ''), title: s(x.title, 160), signal: s(x.signal, 600), assumption: s(x.assumption, 600), constraint: s(x.constraint, 800), evidence: s(x.evidence, 800), action: s(x.action, 800), trigger: s(x.trigger, 20), publishedOn: s(x.publishedOn, 10) }));
  const ok = await setContent('field_notes', JSON.stringify(clean));
  if (!ok) return res.status(503).json({ ok: false, error: 'storage unavailable' });
  res.json({ ok: true, count: clean.length });
});
app.get('/api/field-notes', async (req, res) => {
  const row = await getContent('field_notes');
  res.set('Cache-Control', 'public, max-age=300');
  let notes = [];
  try { notes = row ? JSON.parse(row.value) : []; } catch (e) { notes = []; }
  res.json({ ok: true, notes });
});

/* ------------------------------------------------------------------ */
/* POST /api/subscribe: the site-wide pop-up (name + email). Goes      */
/* straight into the operations app's Prospecting as a website lead,    */
/* logged for the daily reconciliation, and Franklin gets a short note. */
/* Nothing is emailed to the visitor.                                   */
/* ------------------------------------------------------------------ */
app.post('/api/subscribe', async (req, res) => {
  const body = req.body || {};
  if (body.hp_field) return res.json({ ok: true });
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().slice(0, 200);
  if (!name) return res.status(400).json({ ok: false, error: 'Please add your name.' });
  if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'Please provide a valid email address.' });
  const org = String(body.organization || '').trim().slice(0, 160);
  const page = String(body.page || '').replace(/[^\w\-/.]/g, '').slice(0, 120) || '/';
  const leadRef = 'web-popup-' + crypto.randomUUID();
  const osAdded = await pushProspect({
    name, org, source: 'website pop-up', sourceRef: leadRef,
    notes: [`Email: ${email}`, org && `Organization: ${org}`, `Signed up for field notes from the website pop-up on ${page}`].filter(Boolean).join('\n'),
  });
  logLead({ ref: leadRef, kind: 'popup', pushed: osAdded });
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  try {
    const r = await resend.emails.send({
      from: FROM_EMAIL, to: TO_EMAIL, replyTo: email,
      subject: `New website sign-up: ${name}`,
      html: `<p><strong>${esc(name)}</strong> (${esc(email)})${org ? ' from ' + esc(org) : ''} signed up for field notes on ${esc(page)}.</p><p>${osAdded ? 'Added to Prospecting in the operations app.' : 'Not yet in the operations app (it was unreachable); the reconciliation will flag it.'}</p><p style="color:#666;font-size:12px">Lead reference: ${leadRef}</p>`,
    });
    if (r && r.error) console.error('POST /api/subscribe: Resend reported a delivery error:', r.error);
  } catch (err) { console.error('POST /api/subscribe notify failed:', err.message); }
  return res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* POST /api/feedback: client testimonial and results form (/feedback). */
/* Saved, emailed to Franklin with a ready-to-paste site entry when the */
/* client gave permission, and acknowledged to the client.              */
/* ------------------------------------------------------------------ */
app.post('/api/feedback', async (req, res) => {
  const body = req.body || {};
  if (body.hp_field) return res.json({ ok: true });
  const clip = (v, n) => String(v || '').trim().slice(0, n);
  const f = {
    name: clip(body.name, 120),
    email: clip(body.email, 200),
    role: clip(body.role, 120),
    organization: clip(body.organization, 200),
    result: clip(body.result, 2000),
    quote: clip(body.quote, 1200),
    permission: ['named', 'anonymous', 'private'].includes(body.permission) ? body.permission : 'private',
  };
  const rating = Number(body.rating);
  f.rating = Number.isInteger(rating) && rating >= 0 && rating <= 10 ? rating : null;
  if (!f.name || !isValidEmail(f.email)) {
    return res.status(400).json({ ok: false, error: 'Please add your name and a valid email address.' });
  }
  if (!f.result && !f.quote) {
    return res.status(400).json({ ok: false, error: 'Please tell us a little about how it went.' });
  }
  const id = await addFeedback(f);
  const fbRef = 'feedback-' + (id || Date.now());
  pushFeedback(f, fbRef).then((ok) => logLead({ ref: fbRef, kind: 'feedback', pushed: ok }));
  textLead({ kind: 'Client feedback', name: f.name, org: f.organization, detail: f.rating != null ? `Rating ${f.rating} of 10.` : '' });
  try {
    const note = feedbackNotificationEmail(f, id);
    const thanks = feedbackThanksEmail(f);
    const targets = [TO_EMAIL, LEAD_COPY_EMAIL].filter(Boolean);
    const results = await Promise.all([
      ...targets.map((to) => resend.emails.send({ from: FROM_EMAIL, to, replyTo: f.email, subject: note.subject, html: note.html })),
      resend.emails.send({ from: FROM_EMAIL, to: f.email, subject: thanks.subject, html: thanks.html }),
    ]);
    results.forEach((r) => { if (r && r.error) console.error('POST /api/feedback: Resend error:', r.error); });
  } catch (err) {
    console.error('POST /api/feedback email failed:', err);
    if (!id) return res.status(502).json({ ok: false, error: 'Could not send right now. Please try again, or email franklin@franklyinspired.associates.' });
  }
  return res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* POST /api/assessment-lead                                           */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* GET /api/stats: homepage proof counter. Free-tool results logged here */
/* plus InstitutionalOS scorecard results, cached for an hour. Counts    */
/* only, nothing about any visitor.                                      */
/* ------------------------------------------------------------------ */
const GRANTPASS_API = (process.env.GRANTPASS_API_URL || 'https://grantpass-backend.onrender.com').replace(/\/+$/, '');
let statsCache = { at: 0, data: null };
app.get('/api/stats', async (req, res) => {
  if (!statsCache.data || Date.now() - statsCache.at > 60 * 60 * 1000) {
    const [own, scorecard] = await Promise.all([
      countResponses(),
      fetch(GRANTPASS_API + '/demo/benchmarks', { signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? r.json() : null)).then((d) => (d && Number.isFinite(d.count) ? d.count : null)).catch(() => null),
    ]);
    const parts = [own, scorecard].filter((n) => typeof n === 'number');
    if (parts.length) statsCache = { at: Date.now(), data: { assessments: parts.reduce((a, b) => a + b, 0) } };
  }
  res.set('Cache-Control', 'public, max-age=600');
  res.json({ ok: true, ...(statsCache.data || { assessments: null }) });
});

/* GET /api/admin/backup: every table, for the operations app's nightly   */
/* backup. Same secret as the reminder sender.                            */
app.get('/api/admin/backup', async (req, res) => {
  const secret = process.env.REMINDER_SECRET || '';
  if (!secret || req.get('X-Reminder-Secret') !== secret) return res.status(401).json({ ok: false });
  try {
    const data = await exportAll();
    if (!data) return res.status(503).json({ ok: false, error: 'database unavailable' });
    res.json(data);
  } catch (err) {
    console.error('backup export failed', err);
    res.status(500).json({ ok: false, error: 'export failed' });
  }
});

/* POST /api/pv: cookie-free page and event counter for the funnel.        */
/* Body: { p: "/path", e: "view" | an allowed event }. Counts only.        */
const PV_EVENTS = new Set(['view', 'tool_start', 'tool_complete', 'schedule_click', 'schedule_inline_open', 'contact_submit', 'quick_checkup_view']);
app.post('/api/pv', express.text({ type: '*/*', limit: '1kb' }), (req, res) => {
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (e) {}
  const p = String(body.p || '').slice(0, 120);
  const e = PV_EVENTS.has(body.e) ? body.e : 'view';
  if (!/^\/[\w\-\/.]*$/.test(p)) return res.status(204).end();
  countPage(p.replace(/\/+$/, '') || '/', e).catch(() => {});
  res.status(204).end();
});

/* GET /api/admin/page-counts?days=31: visits and events for the funnel.   */
app.get('/api/admin/page-counts', async (req, res) => {
  const secret = process.env.REMINDER_SECRET || '';
  if (!secret || req.get('X-Reminder-Secret') !== secret) return res.status(401).json({ ok: false });
  const rows = await pageCounts(req.query.days).catch(() => null);
  if (!rows) return res.status(503).json({ ok: false, error: 'database unavailable' });
  res.json({ ok: true, rows });
});

/* POST /api/admin/retention: apply the data-retention rule (called by the */
/* operations app's retention run). Same secret as the reminder sender.   */
app.post('/api/admin/retention', async (req, res) => {
  const secret = process.env.REMINDER_SECRET || '';
  if (!secret || req.get('X-Reminder-Secret') !== secret) return res.status(401).json({ ok: false });
  try {
    const out = await purgeOld();
    if (!out) return res.status(503).json({ ok: false, error: 'database unavailable' });
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('retention failed', err);
    res.status(500).json({ ok: false, error: 'retention failed' });
  }
});

/* GET /api/admin/checkup-counts?hours=24: how many free check-ups and   */
/* other tools were completed (anonymous included) and how many left an  */
/* email, for the operations app's morning brief. Counts only.           */
app.get('/api/admin/checkup-counts', async (req, res) => {
  const secret = process.env.REMINDER_SECRET || '';
  if (!secret || req.get('X-Reminder-Secret') !== secret) return res.status(401).json({ ok: false });
  const hours = Math.max(1, Math.min(24 * 14, Number(req.query.hours) || 24));
  const [done, leads] = await Promise.all([recentResponseCounts(hours), recentLeads(hours)]);
  if (!done) return res.status(503).json({ ok: false, error: 'database unavailable' });
  const byTool = {};
  for (const r of done) byTool[r.tool] = r.n;
  const completed = done.reduce((a, r) => a + r.n, 0);
  const insights = await checkupInsights(hours).catch((e) => { console.error('checkupInsights failed:', e.message); return null; });
  res.json({ ok: true, hours, completed, checkups: byTool['self-assessment'] || 0, byTool, leftEmail: (leads || []).filter((l) => l.kind === 'tool' || l.kind === 'scorecard').length, ...(insights || {}) });
});

/* GET /api/admin/lead-log?hours=48: lead references for the operations  */
/* app's daily reconciliation. Same secret as the reminder sender.        */
app.get('/api/admin/lead-log', async (req, res) => {
  const secret = process.env.REMINDER_SECRET || '';
  if (!secret || req.get('X-Reminder-Secret') !== secret) return res.status(401).json({ ok: false });
  const rows = await recentLeads(req.query.hours);
  if (!rows) return res.status(503).json({ ok: false, error: 'database unavailable' });
  res.json({ ok: true, leads: rows.map((r) => ({ ref: r.source_ref, kind: r.kind, pushed: r.pushed, at: r.created_at })) });
});

/* ------------------------------------------------------------------ */
/* GET /api/durability-index: what the free tools show across every     */
/* organization that answered on the evidence rubric. Anonymous         */
/* aggregates only, cached 1 hour, and withheld below 25 responses.     */
/* ------------------------------------------------------------------ */
const DURABILITY_MIN = 25;
let durabilityCache = { at: 0, data: null };
function computeDurability(rows) {
  const n = rows.length;
  if (n < DURABILITY_MIN) return { ready: false, responses: n, needed: DURABILITY_MIN };
  let hidden = 0;
  const lowest = {};
  const triggers = {};
  let withTrigger = 0;
  for (const r of rows) {
    const pillars = Array.isArray(r.pillar_scores) ? r.pillar_scores : [];
    const pcts = pillars.map((p) => p && p.pct).filter((v) => typeof v === 'number');
    if (pcts.length && r.score_pct >= 60 && Math.min(...pcts) < 40) hidden++;
    const dims = mapToHealthIndex(r.tool, pillars);
    if (dims.length) {
      const low = dims.reduce((m, d) => (d.pct < m.pct ? d : m), dims[0]);
      lowest[low.dimension] = (lowest[low.dimension] || 0) + 1;
    }
    if (r.trigger_key && r.trigger_key !== 'checkup') { withTrigger++; triggers[r.trigger_key] = (triggers[r.trigger_key] || 0) + 1; }
  }
  const share = (c, d) => Math.round((100 * c) / d);
  const lowTotal = Object.values(lowest).reduce((a, b) => a + b, 0);
  return {
    ready: true,
    responses: n,
    hiddenWeakSpotPct: share(hidden, n),
    weakestDimensions: Object.entries(lowest).sort((a, b) => b[1] - a[1]).map(([dimension, c]) => ({ dimension, pct: share(c, lowTotal) })),
    triggers: withTrigger >= 10 ? Object.entries(triggers).sort((a, b) => b[1] - a[1]).map(([key, c]) => ({ key, pct: share(c, withTrigger) })) : [],
    triggerResponses: withTrigger,
  };
}
app.get('/api/durability-index', async (req, res) => {
  if (!durabilityCache.data || Date.now() - durabilityCache.at > 60 * 60 * 1000) {
    const rows = await durabilityRows();
    if (rows) durabilityCache = { at: Date.now(), data: computeDurability(rows) };
  }
  res.set('Cache-Control', 'public, max-age=600');
  res.json({ ok: true, ...(durabilityCache.data || { ready: false, responses: null, needed: DURABILITY_MIN }) });
});

/* ------------------------------------------------------------------ */
/* POST /api/ask: "Ask about your results" on the Health Index page.    */
/* Body: {question, scores:[{label,pct}], seal?, stage?}. Scores only;  */
/* nothing is stored.                                                   */
/* ------------------------------------------------------------------ */
app.post('/api/ask', async (req, res) => {
  const b = req.body || {};
  const question = typeof b.question === 'string' ? b.question.trim().slice(0, 500) : '';
  const scores = Array.isArray(b.scores)
    ? b.scores.filter((s) => s && typeof s.label === 'string' && Number.isFinite(s.pct)).slice(0, 12)
        .map((s) => ({ dimension: s.label.slice(0, 60), score_pct: Math.max(0, Math.min(100, Math.round(s.pct))) }))
    : [];
  if (question.length < 3) return res.status(400).json({ ok: false, error: 'Please type a question.' });
  if (!scores.length) return res.status(400).json({ ok: false, error: 'Score at least one dimension first.' });
  const seal = ['bronze', 'silver', 'gold', 'platinum'].includes(b.seal) ? b.seal : null;
  const stage = STAGE_LABELS[b.stage] ? b.stage : null;
  const answer = await answerQuestion({ question, scores, seal, stage });
  if (!answer) return res.status(503).json({ ok: false, error: 'The assistant is unavailable right now. Please try again, or schedule a conversation.' });
  res.json({ ok: true, answer });
});

/* ------------------------------------------------------------------ */
/* Opt-in 90-day re-check reminder.                                     */
/*   POST /api/reminders {email, tool}  -> one reminder in 90 days      */
/*   GET  /api/reminders/cancel?token=  -> deletes it                   */
/*   POST /api/admin/send-reminders     -> sends due ones (daily task,  */
/*        X-Reminder-Secret header must match REMINDER_SECRET)          */
/* ------------------------------------------------------------------ */
const REMINDER_SECRET = process.env.REMINDER_SECRET || '';
const PUBLIC_API = (process.env.PUBLIC_API_URL || 'https://frankly-inspired-api.onrender.com').replace(/\/+$/, '');
app.post('/api/reminders', async (req, res) => {
  const b = req.body || {};
  if (b.hp_field) return res.json({ ok: true });
  if (!isValidEmail(b.email)) return res.status(400).json({ ok: false, error: 'Please provide a valid email address.' });
  const token = await addReminder({ email: String(b.email).trim(), tool: b.tool, days: 90 });
  if (!token) return res.status(503).json({ ok: false, error: 'Reminders are unavailable right now. Please try again later.' });
  res.json({ ok: true, cancelUrl: `${PUBLIC_API}/api/reminders/cancel?token=${token}` });
});
app.get('/api/reminders/cancel', async (req, res) => {
  const token = String(req.query.token || '');
  const done = /^[A-Za-z0-9_-]{10,64}$/.test(token) ? await deleteReminder({ token }).catch(() => false) : false;
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reminder cancelled</title><body style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#1f2933"><h1 style="font-size:20px;color:#0f1f3d">${done ? 'Reminder cancelled' : 'Nothing to cancel'}</h1><p>${done ? 'Your 90-day reminder and email address have been deleted.' : 'This reminder was already sent or cancelled.'}</p><p><a href="https://franklyinspired.associates/health-index">Back to your Health Index</a></p></body>`);
});
// ---------------------------------------------------------------------
// Messages approved in the operations app (Process Library). The operations
// app sends only after the owner approves each one. Plain text in, a simple
// branded HTML version out. X-Reminder-Secret, like the other admin routes.
// mail-status tells the app whether outside delivery works yet: while the
// sender is Resend's shared onboarding address, Resend delivers only to the
// account's own address, so the app offers "open in my email" instead.
// ---------------------------------------------------------------------
const SENDS_EXTERNAL = !/resend\.dev/i.test(FROM_EMAIL);
app.get('/api/admin/mail-status', (req, res) => {
  const secret = process.env.REMINDER_SECRET;
  if (!secret || req.get('X-Reminder-Secret') !== secret) return res.status(401).json({ ok: false });
  res.json({ ok: true, external: SENDS_EXTERNAL, from: FROM_EMAIL.replace(/^.*</, '').replace(/>.*$/, '') });
});
app.post('/api/admin/send-message', async (req, res) => {
  const secret = process.env.REMINDER_SECRET;
  if (!secret || req.get('X-Reminder-Secret') !== secret) return res.status(401).json({ ok: false });
  const b = req.body || {};
  const to = String(b.to || '').split(/[,;]\s*/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 25);
  const subject = String(b.subject || '').slice(0, 200).trim();
  const text = String(b.text || '').slice(0, 20000);
  if (!to.length || !subject || !text.trim()) return res.status(400).json({ ok: false, error: 'to, subject, and text are required' });
  if (!SENDS_EXTERNAL) return res.status(409).json({ ok: false, error: 'Outside delivery is not set up yet (the sender is Resend\'s shared test address). Verify your domain in Resend and set FROM_EMAIL.' });
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const linkify = (x) => esc(x).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#11233D">${u}</a>`);
  const html = `<div style="font:15px/1.6 Arial,Helvetica,sans-serif;color:#23282D;max-width:620px">${text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${linkify(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
  const results = await Promise.all(to.map((addr) => resend.emails.send({ from: FROM_EMAIL, to: addr, replyTo: b.replyTo || undefined, subject, text, html }).catch((e) => ({ error: e }))));
  const failed = results.filter((r) => r && r.error).length;
  if (failed) console.error('POST /api/admin/send-message: Resend errors:', results.filter((r) => r && r.error).map((r) => r.error));
  res.status(failed === to.length ? 502 : 200).json({ ok: failed < to.length, sent: to.length - failed, failed });
});

app.post('/api/admin/send-reminders', async (req, res) => {
  if (!REMINDER_SECRET || req.get('X-Reminder-Secret') !== REMINDER_SECRET) return res.status(401).json({ ok: false });
  let sent = 0, failed = 0;
  try {
    for (const r of await dueReminders(50)) {
      const mail = recheckReminderEmail({ toolName: TOOL_DISPLAY_NAMES[r.tool] || 'InstitutionalOS Health Index' });
      const out = await resend.emails.send({ from: FROM_EMAIL, to: r.email, subject: mail.subject, html: mail.html }).catch((e) => ({ error: e }));
      if (out && out.error) { failed++; console.error('reminder send failed:', out.error); continue; }
      await deleteReminder({ id: r.id });
      sent++;
    }
  } catch (err) {
    console.error('send-reminders failed:', err.message);
    return res.status(500).json({ ok: false, sent, failed });
  }
  res.json({ ok: true, sent, failed });
});

/* ------------------------------------------------------------------ */
/* POST /api/admin/send-checkin-reminders: emails each InstitutionalOS */
/* client whose weekly 90-day-plan check-in is due. InstitutionalOS     */
/* decides who is due (and on which weekday); this just sends and       */
/* reports back. Same secret as the re-check reminders.                 */
/* ------------------------------------------------------------------ */
const GRANTPASS_DASHBOARD = (process.env.GRANTPASS_DASHBOARD || 'https://grantpass-dashboard.onrender.com').replace(/\/+$/, '');
const GRANTPASS_INTEGRATION_KEY = process.env.GRANTPASS_INTEGRATION_KEY || '';
// InstitutionalOS sleeps on Render's free plan; while it wakes, the platform can
// answer 429 or 502-504 for a little while. Wait and try again before giving up.
async function iosCall(path, method = 'GET') {
  const waits = [0, 15000, 30000];
  let last;
  for (const w of waits) {
    if (w) await new Promise((ok) => setTimeout(ok, w));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 70000);
    try {
      const r = await fetch(GRANTPASS_API + path, { method, headers: { 'X-Integration-Key': GRANTPASS_INTEGRATION_KEY, 'Content-Type': 'application/json' }, signal: controller.signal });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return data;
      last = new Error(data.error || 'InstitutionalOS returned ' + r.status);
      if (![429, 502, 503, 504].includes(r.status)) throw last;
    } catch (e) {
      last = e;
      if (!(e && (e.name === 'AbortError' || /returned (429|50[234])|fetch failed|ECONN/.test(String(e.message))))) throw e;
    } finally { clearTimeout(timer); }
  }
  throw last;
}
app.post('/api/admin/send-checkin-reminders', async (req, res) => {
  if (!REMINDER_SECRET || req.get('X-Reminder-Secret') !== REMINDER_SECRET) return res.status(401).json({ ok: false });
  if (!GRANTPASS_INTEGRATION_KEY) return res.status(503).json({ ok: false, error: 'GRANTPASS_INTEGRATION_KEY is not set' });
  let sent = 0, failed = 0;
  try {
    const { due = [] } = await iosCall('/integration/checkins-due');
    for (const c of due.slice(0, 50)) {
      const portalUrl = `${GRANTPASS_DASHBOARD}/report.html?client=${encodeURIComponent(c.clientToken)}&api=${encodeURIComponent(GRANTPASS_API)}`;
      const mail = checkinReminderEmail({ contactName: c.contactName, orgName: c.name, portalUrl, nextAction: c.nextAction, actionsDone: c.actionsDone, actionsTotal: c.actionsTotal, target: c.target });
      const out = await resend.emails.send({ from: FROM_EMAIL, to: c.email, replyTo: TO_EMAIL || undefined, subject: mail.subject, html: mail.html }).catch((e) => ({ error: e }));
      if (out && out.error) { failed++; console.error('check-in reminder failed:', out.error); continue; }
      await iosCall(`/integration/orgs/${c.orgId}/reminded`, 'POST').catch((e) => console.error('mark reminded failed:', e.message));
      sent++;
    }
  } catch (err) {
    console.error('send-checkin-reminders failed:', err.message);
    return res.status(502).json({ ok: false, sent, failed, error: err.name === 'AbortError' ? 'InstitutionalOS timed out' : err.message });
  }
  res.json({ ok: true, sent, failed });
});

/* ------------------------------------------------------------------ */
/* The free check-up's full result, saved anonymously with every       */
/* finished check-up (through /api/assessment-narrative), and saved     */
/* progress for visitors who want a link to finish later.               */
/* ------------------------------------------------------------------ */
const CHECKUP_REF = /^[A-Za-z0-9-]{8,64}$/;
const LEGACY_KEYS = ['deputy', 'decisions', 'succession', 'reserves', 'concentration', 'candid'];
function checkupResult(b) {
  const out = {};
  if (CHECKUP_REF.test(String(b.ref || ''))) out.ref = String(b.ref);
  if (['build', 'fund', 'sustain'].includes(b.path)) out.path = b.path;
  const sa = b.stageAnswers;
  if (sa && typeof sa === 'object') {
    const clean = {};
    for (const k of ['budget', 'staff', 'years', 'decide']) if (Number.isInteger(sa[k]) && sa[k] >= -1 && sa[k] <= 9) clean[k] = sa[k];
    if (Object.keys(clean).length) out.stageAnswers = clean;
  }
  if (typeof b.gap === 'string' && b.gap.trim()) out.gap = cleanText(b.gap, 80);
  const lg = b.legacy;
  if (lg && Array.isArray(lg.markers)) {
    const markers = lg.markers.filter((k) => LEGACY_KEYS.includes(k));
    out.legacy = { met: markers.length, markers };
  }
  return out;
}
const SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://franklyinspired.associates').replace(/\/+$/, '');
const PROGRESS_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const progressLinks = (token) => ({
  resumeUrl: `${SITE_URL}/assessment?resume=${token}`,
  stopUrl: `${PUBLIC_API}/api/checkup-progress/${token}/stop`,
});
// Answers only: field names and short values, so a save can't carry anything else.
function cleanFields(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const out = {};
  for (const [k, v] of Object.entries(f).slice(0, 200)) {
    if (!/^[A-Za-z0-9_:-]{1,60}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 500);
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
const count = (n, max) => Math.max(0, Math.min(max, Math.round(Number(n) || 0)));
app.post('/api/checkup-progress', async (req, res) => {
  const b = req.body || {};
  if (b.hp_field) return res.json({ ok: true });
  if (!isValidEmail(b.email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  const fields = cleanFields(b.fields);
  if (!fields) return res.status(400).json({ ok: false, error: 'Nothing to save yet.' });
  const total = count(b.total, 200), answered = Math.min(total, count(b.answered, 200));
  let token;
  try { token = await saveProgress({ email: String(b.email).trim(), fields, answered, total }); } catch (e) { console.error('saveProgress failed:', e.message); }
  if (!token) return res.status(503).json({ ok: false, error: 'Saving is unavailable right now. Please try again shortly.' });
  const links = progressLinks(token);
  const mail = progressSavedEmail({ ...links, answered, total });
  const out = await resend.emails.send({ from: FROM_EMAIL, to: String(b.email).trim(), replyTo: TO_EMAIL || undefined, subject: mail.subject, html: mail.html }).catch((e) => ({ error: e }));
  if (out && out.error) console.error('progress saved email failed:', out.error);
  res.json({ ok: true, token, resumeUrl: links.resumeUrl, emailed: !(out && out.error) });
});
app.get('/api/checkup-progress/:token', async (req, res) => {
  const t = String(req.params.token || '');
  if (!PROGRESS_TOKEN.test(t)) return res.status(404).json({ ok: false });
  const row = await getProgress(t).catch(() => null);
  if (!row) return res.status(404).json({ ok: false, error: 'This link has already been used or stopped.' });
  res.json({ ok: true, fields: row.fields || {}, answered: row.answered, total: row.total });
});
app.post('/api/checkup-progress/:token', async (req, res) => {
  const t = String(req.params.token || '');
  const fields = cleanFields((req.body || {}).fields);
  if (!PROGRESS_TOKEN.test(t) || !fields) return res.status(400).json({ ok: false });
  const total = count(req.body.total, 200), answered = Math.min(total, count(req.body.answered, 200));
  const ok = await updateProgress(t, { fields, answered, total }).catch(() => false);
  res.status(ok ? 200 : 404).json({ ok });
});
app.post('/api/checkup-progress/:token/complete', async (req, res) => {
  const t = String(req.params.token || '');
  if (!PROGRESS_TOKEN.test(t)) return res.status(400).json({ ok: false });
  const ref = CHECKUP_REF.test(String((req.body || {}).ref || '')) ? String(req.body.ref) : null;
  const ok = await endProgress(t, { completed: true, ref }).catch(() => false);
  res.json({ ok });
});
app.get('/api/checkup-progress/:token/stop', async (req, res) => {
  const t = String(req.params.token || '');
  const done = PROGRESS_TOKEN.test(t) ? await endProgress(t, { completed: false }).catch(() => false) : false;
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reminders stopped</title><body style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#1f2933"><h1 style="font-size:20px;color:#0f1f3d">${done ? 'Reminders stopped' : 'Nothing to stop'}</h1><p>${done ? 'You won\'t get any more reminders about your check-up, and your saved answers and email address have been deleted.' : 'This check-up was already finished or its reminders were already stopped.'}</p><p><a href="${SITE_URL}/assessment">Start the free check-up again</a></p></body>`);
});
/* POST /api/admin/send-progress-reminders: weekly "finish your check-up" */
/* emails, a day after saving and then every seven days, until the visitor */
/* finishes or stops them. Run daily by the operations app's reminder task. */
app.post('/api/admin/send-progress-reminders', async (req, res) => {
  if (!REMINDER_SECRET || req.get('X-Reminder-Secret') !== REMINDER_SECRET) return res.status(401).json({ ok: false });
  let sent = 0, failed = 0;
  try {
    for (const r of await dueProgress(50)) {
      const mail = progressReminderEmail({ ...progressLinks(r.token), answered: r.answered, total: r.total });
      const out = await resend.emails.send({ from: FROM_EMAIL, to: r.email, replyTo: TO_EMAIL || undefined, subject: mail.subject, html: mail.html }).catch((e) => ({ error: e }));
      if (out && out.error) { failed++; console.error('progress reminder failed:', out.error); continue; }
      await markProgressReminded(r.id);
      sent++;
    }
  } catch (err) {
    console.error('send-progress-reminders failed:', err.message);
    return res.status(500).json({ ok: false, sent, failed });
  }
  res.json({ ok: true, sent, failed });
});

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
  // Opt-in: one 90-day re-check reminder, stored until it's sent.
  const reminderToken = body.remind === true ? await addReminder({ email: String(body.email).trim(), tool, days: 90 }) : null;
  const pathKey = STAGE_LABELS[body.stage] ? body.stage : (TRIGGER_PATH[body.trigger] || '');
  const payload = {
    email: body.email,
    name: cleanText(body.name, 80),
    orgName: cleanText(body.orgName, 120),
    path: PATH_LABELS[pathKey] || '',
    stageFacts: stageFacts(body.stageAnswers),
    gap: cleanText(body.gap, 80),
    legacy: cleanLegacy(body.legacy),
    // What their results page told them: the short answer to their own
    // question, and the one recommendation (website situation.ts).
    answer: cleanText(body.answer, 400),
    recommendation: REC_LABELS[body.recommendation] || '',
    scorePct: body.scorePct,
    band: body.band,
    pillarScores: body.pillarScores,
    narrative: typeof body.narrative === 'string' ? body.narrative : null,
    tool,
    toolName: TOOL_DISPLAY_NAMES[tool] || 'Sustainability Self-Assessment',
    healthIndex,
    stage: STAGE_LABELS[body.stage] || '',
    trigger: TRIGGER_LABELS[body.trigger] || '',
    org: cleanOrg(body.org),
    seal: cleanSeal(body.seal),
    toolsTaken: Array.isArray(body.toolsTaken) ? body.toolsTaken.filter((t) => typeof t === 'string').slice(0, 8).map((t) => t.slice(0, 60)) : [],
  };

  const leadRef = 'web-tool-' + crypto.randomUUID();
  const toolNotes = [
    `Email: ${String(body.email).trim()}`,
    payload.name && `Name: ${payload.name}`,
    `Tool: ${payload.toolName}`,
    payload.org && `Organization: ${payload.org.name} (EIN ${payload.org.ein}${payload.org.state ? ', ' + payload.org.state : ''})`,
    !payload.org && payload.orgName && `Organization (as typed): ${payload.orgName}`,
    payload.path && `Path: ${payload.path}`,
    payload.stageFacts && `Stage facts: ${payload.stageFacts}`,
    payload.gap && `Gap that will break first (check-up rule): ${payload.gap}`,
    payload.legacy && `Legacy Readiness: ${payload.legacy.met} of ${payload.legacy.total}${payload.legacy.missing.length ? ' (missing: ' + payload.legacy.missing.join('; ') + ')' : ''}`,
    payload.toolsTaken.length && `Tools taken: ${payload.toolsTaken.join(', ')}`,
    payload.seal && `Candid Seal path: ${payload.seal}`,
    payload.stage && `Stage: ${payload.stage}`,
    payload.trigger && `Situation: ${payload.trigger}`,
    payload.answer && `Short answer shown: ${payload.answer}`,
    payload.recommendation && `Recommendation shown: ${payload.recommendation}`,
    CHECKUP_REF.test(String(body.checkupRef || '')) && `Check-up reference: ${body.checkupRef}`,
    `Composite score: ${Math.round(payload.scorePct)}%${payload.band ? ' (' + payload.band + ')' : ''}`,
    'By area: ' + payload.pillarScores.map(p => `${p.label} ${Math.round(p.pct)}%`).join(', '),
    formatHealthIndex(healthIndex),
  ].filter(Boolean).join('\n');
  const osAdded = await pushProspect({
    name: payload.name || String(body.email).trim(),
    org: payload.org ? payload.org.name : payload.orgName,
    source: 'assessment tool',
    notes: toolNotes,
    sourceRef: leadRef,
    // Every tool's results recommend the InstitutionalOS Diagnostic for
    // the visitor's stage, so that's the offer a tool lead is about.
    interest: 'institutionalos-diagnostic',
    orgStage: pathKey,
    trigger: TRIGGER_LABELS[body.trigger] ? body.trigger : '',
    selfScores: selfScoresFrom(healthIndex),
    link: payload.org ? `https://projects.propublica.org/nonprofits/organizations/${payload.org.ein.replace('-', '')}` : '',
  });
  logLead({ ref: leadRef, kind: 'tool', pushed: osAdded });
  textLead({ kind: 'Check-up finished', name: payload.name || String(body.email).trim(), org: payload.org ? payload.org.name : payload.orgName, detail: [payload.path && `${payload.path} path`, payload.gap && `gap: ${payload.gap}`, payload.recommendation && `shown: ${payload.recommendation}`].filter(Boolean).join(', ') });

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
 
    return res.json({ ok: true, reminder: Boolean(reminderToken), cancelUrl: reminderToken ? `${PUBLIC_API}/api/reminders/cancel?token=${reminderToken}` : undefined });
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
 
  const scale = body.scale === 'evidence' ? 'evidence' : 'agreement';
  // narrative: false = the page shows only Franklin's own results text, so
  // don't draft an AI summary (the free check-up sends this).
  const narrative = body.narrative === false ? null : await generateAssessmentNarrative({
    tool,
    scorePct: body.scorePct,
    band: typeof body.band === 'string' ? body.band : '',
    pillarScores: body.pillarScores,
    scale,
  });
 
  // Anonymized log for the benchmark dataset — no email, no org, just the
  // tool, the scores, and a timestamp. Fire-and-forget: never awaited into
  // the response, never a reason for this endpoint to fail.
  logAssessmentResponse({
    tool,
    scorePct: body.scorePct,
    band: typeof body.band === 'string' ? body.band : '',
    pillarScores: body.pillarScores,
    scale,
    trigger: body.trigger,
    ...checkupResult(body),
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
  // scale=evidence compares only answers given on the evidence rubric.
  const benchmarks = await getBenchmarks(tool, req.query.scale);
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
  if (leadRef) logLead({ ref: leadRef, kind: 'scorecard', pushed: osAdded });
  textLead({ kind: 'InstitutionalOS scorecard lead', name: String(body.email || '').trim(), org: r.orgName, detail: r.stageName ? `${r.stageName}, ${Math.round(Number(r.overall) || 0)}/100.` : '' });

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

/* ------------------------------------------------------------------ */
/* GET /api/org-search?q=&state=   and   GET /api/org-990?ein=         */
/* Public IRS Form 990 lookup (ProPublica Nonprofit Explorer) so the    */
/* free tools can start from the same filing a funder reads. Read-only, */
/* no visitor data stored.                                              */
/* ------------------------------------------------------------------ */
app.get('/api/org-search', async (req, res) => {
  try {
    const results = await searchOrgs(req.query.q, String(req.query.state || '').toUpperCase());
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ ok: true, results });
  } catch (err) {
    console.error('GET /api/org-search failed:', err.message);
    res.status(502).json({ ok: false, error: 'Lookup is unavailable right now.' });
  }
});

app.get('/api/org-990', async (req, res) => {
  try {
    const snap = await orgSnapshot(req.query.ein);
    if (!snap) return res.status(404).json({ ok: false, error: 'No filings found for that EIN.' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ ok: true, ...snap });
  } catch (err) {
    console.error('GET /api/org-990 failed:', err.message);
    res.status(502).json({ ok: false, error: 'Lookup is unavailable right now.' });
  }
});

// Candid Seal level the visitor qualifies for and the next one, from the
// Candid Seal Path tool (self-reported).
const SEAL_NAMES = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
function cleanSeal(s) {
  if (!s || typeof s !== 'object') return '';
  const cur = SEAL_NAMES[s.current] || 'no Seal yet';
  const next = SEAL_NAMES[s.next];
  return next ? `${cur} now, next ${next} (self-reported)` : `${cur} (self-reported; keep current yearly)`;
}

// Organization the visitor picked from the 990 lookup, if any.
function cleanOrg(o) {
  if (!o || typeof o !== 'object') return null;
  const ein = String(o.ein || '').replace(/[^0-9]/g, '');
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 150) : '';
  if (ein.length !== 9 || !name) return null;
  return { ein: fmtEin(ein), name, state: typeof o.state === 'string' ? o.state.slice(0, 2) : '' };
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
 
app.listen(PORT, () => {
  console.log(`Frankly Inspired backend listening on port ${PORT}`);
  console.log(osConfigured()
    ? 'Operations app connection: on (leads go straight to Prospecting).'
    : 'Operations app connection: off (set OS_API_URL and OS_PROSPECTS_TOKEN); leads reach the app via the daily email import.');
});
