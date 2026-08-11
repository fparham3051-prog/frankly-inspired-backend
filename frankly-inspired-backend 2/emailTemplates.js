/**
 * Email templates for the Frankly Inspired backend.
 *
 * Keep the acknowledgement copy here in sync with the copy Franklin
 * approved (see the main site's README.md, "Automated acknowledgement
 * email"). Do not embellish or add claims not already on the site —
 * same content guardrails as the rest of the project.
 */

const BRAND = {
  navy: '#11233D',
  gold: '#B28E42',
  lightGray: '#F3F5F7',
};

function wrapEmail(bodyHtml) {
  return `
  <div style="background:${BRAND.lightGray};padding:32px 16px;font-family:Georgia,'Times New Roman',serif;color:#23282D;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-top:3px solid ${BRAND.gold};padding:32px;">
      <p style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.gold};margin:0 0 16px;">
        Frankly Inspired and Associates, LLC
      </p>
      ${bodyHtml}
    </div>
  </div>`;
}

/** Sent to the person who submitted the Contact form. */
function contactAcknowledgementEmail(fields) {
  const firstName = (fields.name || '').trim().split(/\s+/)[0] || 'there';
  const html = wrapEmail(`
    <h1 style="font-size:20px;color:${BRAND.navy};margin:0 0 20px;">Thank you for contacting Frankly Inspired</h1>
    <p>Hi ${escapeHtml(firstName)},</p>
    <p>Thank you for reaching out to Frankly Inspired and Associates, LLC.</p>
    <p>I appreciate the opportunity to learn more about your organization and the work you're navigating. Your inquiry has been received and will be reviewed shortly.</p>
    <p>If you have not already scheduled a conversation, you are welcome to select a convenient time for a 30 minute introductory conversation:</p>
    <p style="margin:24px 0;">
      <a href="https://calendly.com/fparham/30min" style="background:${BRAND.gold};color:${BRAND.navy};text-decoration:none;padding:12px 24px;border-radius:4px;font-family:Arial,sans-serif;font-weight:bold;font-size:14px;display:inline-block;">Schedule a Conversation</a>
    </p>
    <p>I look forward to learning more about your organization, your goals, and what a useful engagement could look like.</p>
    <p style="margin-top:28px;">In partnership,<br>Franklin D. Parham<br>Founder and Principal<br>Frankly Inspired and Associates, LLC</p>
  `);
  return {
    subject: 'Thank you for contacting Frankly Inspired',
    html,
  };
}

/** Sent to Franklin when a Contact form inquiry comes in. */
function contactNotificationEmail(fields) {
  const row = (label, value) => `
    <tr>
      <td style="padding:6px 12px 6px 0;color:#6b7480;font-family:Arial,sans-serif;font-size:13px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
      <td style="padding:6px 0;font-family:Arial,sans-serif;font-size:13px;">${escapeHtml(value || '—')}</td>
    </tr>`;
  const supportAreas = Array.isArray(fields.support_area) ? fields.support_area.join(', ') : (fields.support_area || '—');
  const html = wrapEmail(`
    <h1 style="font-size:18px;color:${BRAND.navy};margin:0 0 16px;">New inquiry from the website</h1>
    <table style="border-collapse:collapse;width:100%;">
      ${row('Name', fields.name)}
      ${row('Organization', fields.organization)}
      ${row('Title / Role', fields.title)}
      ${row('Email', fields.email)}
      ${row('Phone', fields.phone)}
      ${row('Org. website', fields.org_website)}
      ${row('Support area(s)', supportAreas)}
      ${row('Timeline', fields.timeline)}
      ${row('Referral', fields.referral)}
    </table>
    <p style="font-family:Arial,sans-serif;font-size:13px;color:#6b7480;margin-top:16px;">Challenge / opportunity:</p>
    <p style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;">${escapeHtml(fields.challenge)}</p>
  `);
  return {
    subject: `New inquiry: ${fields.organization || fields.name || 'Website contact form'}`,
    html,
  };
}

/** Sent to a visitor who asks to have their self-assessment results emailed. */
function assessmentResultsEmail(payload) {
  const bars = (payload.pillarScores || []).map(p => `
    <tr>
      <td style="padding:4px 0;font-family:Arial,sans-serif;font-size:13px;width:55%;">${escapeHtml(p.label)}</td>
      <td style="padding:4px 0;font-family:Arial,sans-serif;font-size:13px;color:${BRAND.gold};font-weight:bold;">${Math.round(p.pct)}%</td>
    </tr>`).join('');
  const html = wrapEmail(`
    <h1 style="font-size:20px;color:${BRAND.navy};margin:0 0 8px;">Your Nonprofit Sustainability Self-Assessment Results</h1>
    <p style="font-family:Arial,sans-serif;font-size:36px;font-weight:bold;color:${BRAND.gold};margin:16px 0 0;">${Math.round(payload.scorePct)}%</p>
    <p style="font-family:Arial,sans-serif;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:${BRAND.navy};font-weight:bold;margin:4px 0 20px;">${escapeHtml(payload.band || '')}</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:20px;">${bars}</table>
    ${payload.narrative ? `<p>${escapeHtml(payload.narrative)}</p>` : ''}
    <p>This is a directional self-assessment based on your own responses, not a formal audit or guarantee of any outcome. If you'd like to talk through what it means for your organization:</p>
    <p style="margin:24px 0;">
      <a href="https://calendly.com/fparham/30min" style="background:${BRAND.gold};color:${BRAND.navy};text-decoration:none;padding:12px 24px;border-radius:4px;font-family:Arial,sans-serif;font-weight:bold;font-size:14px;display:inline-block;">Schedule a Strategy Conversation</a>
    </p>
    <p style="margin-top:28px;">In partnership,<br>Franklin D. Parham<br>Founder and Principal<br>Frankly Inspired and Associates, LLC</p>
  `);
  return {
    subject: 'Your Nonprofit Sustainability Self-Assessment Results',
    html,
  };
}

/** Sent to Franklin when someone completes the assessment and asks for results by email. */
function assessmentLeadNotificationEmail(payload) {
  const bars = (payload.pillarScores || []).map(p => `${p.label}: ${Math.round(p.pct)}%`).join(' · ');
  const html = wrapEmail(`
    <h1 style="font-size:18px;color:${BRAND.navy};margin:0 0 16px;">New self-assessment lead</h1>
    <p style="font-family:Arial,sans-serif;font-size:13px;"><strong>Email:</strong> ${escapeHtml(payload.email)}</p>
    <p style="font-family:Arial,sans-serif;font-size:13px;"><strong>Composite score:</strong> ${Math.round(payload.scorePct)}% (${escapeHtml(payload.band || '')})</p>
    <p style="font-family:Arial,sans-serif;font-size:13px;"><strong>By pillar:</strong> ${escapeHtml(bars)}</p>
  `);
  return {
    subject: `New assessment lead: ${payload.email}`,
    html,
  };
}

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  contactAcknowledgementEmail,
  contactNotificationEmail,
  assessmentResultsEmail,
  assessmentLeadNotificationEmail,
};
