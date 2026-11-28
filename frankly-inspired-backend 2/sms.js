/**
 * Text-message alerts to Franklin's phone, through Twilio.
 *
 * Off until these are set on Render (Franklin enters them himself):
 *   TWILIO_ACCOUNT_SID   - from the Twilio console
 *   TWILIO_AUTH_TOKEN    - from the Twilio console
 *   TWILIO_FROM          - the Twilio number that sends, e.g. +12025550123
 *                          (or TWILIO_MESSAGING_SERVICE_SID instead)
 *   ALERT_SMS_TO         - the phone number(s) to text, comma-separated
 *
 * A text never blocks or fails a form: every error is logged and dropped.
 * Texts carry only who and what kind of lead. Scores and answers stay in
 * the email.
 */

const SID = () => process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = () => process.env.TWILIO_AUTH_TOKEN || '';
const FROM = () => process.env.TWILIO_FROM || '';
const SERVICE = () => process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const TO = () => String(process.env.ALERT_SMS_TO || '').split(',').map((s) => s.trim()).filter(Boolean);

function smsConfigured() {
  return Boolean(SID() && TOKEN() && (FROM() || SERVICE()) && TO().length);
}

// One line, plain text, no links that look like phishing; at most 300 chars.
function clean(s, n) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
}

function leadText({ kind, name, org, detail }) {
  const who = [clean(name, 60), clean(org, 80)].filter(Boolean).join(', ') || 'someone';
  const parts = [`Frankly Inspired: ${clean(kind, 40)} from ${who}.`];
  const d = clean(detail, 120);
  if (d) parts.push(/[.!?]$/.test(d) ? d : d + '.');
  parts.push('Details are in your email.');
  return parts.join(' ').slice(0, 300);
}

async function sendText(body, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!smsConfigured()) return { sent: 0, skipped: true };
  const auth = Buffer.from(`${SID()}:${TOKEN()}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(SID())}/Messages.json`;
  let sent = 0;
  for (const to of TO()) {
    const form = new URLSearchParams({ To: to, Body: body });
    if (SERVICE()) form.set('MessagingServiceSid', SERVICE()); else form.set('From', FROM());
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: ctrl.signal,
      });
      if (r.ok) sent++;
      else console.error('text alert failed:', r.status, (await r.text().catch(() => '')).slice(0, 200));
    } catch (err) {
      console.error('text alert failed:', err.message);
    } finally {
      clearTimeout(timer);
    }
  }
  return { sent, skipped: false };
}

// Fire-and-forget wrapper for the form routes.
function textLead(lead) {
  if (!smsConfigured()) return;
  sendText(leadText(lead)).catch(() => {});
}

module.exports = { smsConfigured, leadText, sendText, textLead };
