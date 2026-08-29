/**
 * Signs and verifies the score_ref token that carries a completed free
 * diagnostic into the contact form, so a visitor doesn't have to
 * re-explain themselves.
 *
 * Two sources mint this token now: grantpass-backend's auth.py
 * (make_score_ref), for the InstitutionalOS scorecard, and
 * makeScoreRef() below, for this site's own five self-scoring tools
 * (self-assessment, revenue-growth, leadership, sustainability,
 * institutional-advancement). Both sign with the same shared
 * SCORE_REF_SECRET env var and the same token shape, so the contact
 * page's single verification path (GET /api/score-ref, and the
 * verifyScoreRef() call inside POST /api/contact) handles a token from
 * either source identically - it only cares that the signature checks
 * out, not which service minted it.
 *
 * Token format: "<base64url(JSON payload, no padding)>.<hex HMAC-SHA256 sig>",
 * where the payload is {stage, score, band, src, exp}. This is the
 * integration piece from the August 2026 wealth-transfer research brief
 * ("the three touchpoints don't share state"). Keep this in sync with
 * auth.py's make_score_ref/verify_score_ref if the token format ever
 * changes on that side.
 */
const crypto = require('crypto');

const SCORE_REF_SECRET = process.env.SCORE_REF_SECRET || '';
const SCORE_REF_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days, matches auth.py

/**
 * Signs {stage, score, band, src} into a score_ref token. Returns null
 * (rather than throwing) if SCORE_REF_SECRET isn't configured, so a
 * missing env var quietly disables the CTA instead of breaking the
 * assessment result itself - same graceful-degradation approach as the
 * rest of this backend.
 */
function makeScoreRef({ stage, score, band, src }, ttlSeconds = SCORE_REF_TTL_SECONDS) {
  if (!SCORE_REF_SECRET) return null;
  const payload = {
    stage: stage || null,
    score: typeof score === 'number' ? score : null,
    band: band || null,
    src: src || 'assessment',
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64url')
    .replace(/=+$/, '');
  const sig = crypto.createHmac('sha256', SCORE_REF_SECRET).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

/**
 * Returns the decoded {stage, score, band, src, exp} payload if the token
 * is validly signed (by the shared secret) and unexpired, else null. Never
 * throws - a malformed, tampered, or expired token is just treated as
 * absent, the same graceful-degradation approach as the rest of this
 * backend.
 */
function verifyScoreRef(token) {
  if (!SCORE_REF_SECRET || typeof token !== 'string' || token.length === 0 || token.length > 2000) {
    return null;
  }
  const dot = token.lastIndexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', SCORE_REF_SECRET).update(payloadB64).digest('hex');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const padLen = (4 - (payloadB64.length % 4)) % 4;
    const padded = payloadB64 + '='.repeat(padLen);
    const json = Buffer.from(padded, 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

module.exports = { makeScoreRef, verifyScoreRef };
