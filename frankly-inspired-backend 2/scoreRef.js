/**
 * Verifies the score_ref token minted by grantpass-backend's auth.py
 * (make_score_ref) when a visitor completes the free InstitutionalOS
 * scorecard. Both services must share the same SCORE_REF_SECRET env var,
 * or every token will fail verification here even though it was minted
 * correctly.
 *
 * Token format: "<base64url(JSON payload, no padding)>.<hex HMAC-SHA256 sig>",
 * where the payload is {stage, score, band, src, exp}. This is the
 * integration piece from the August 2026 wealth-transfer research brief
 * ("the three touchpoints don't share state") - it's what lets a completed
 * scorecard follow a visitor into the contact form instead of them
 * re-explaining their diagnostic from scratch. Keep this in sync with
 * auth.py's make_score_ref/verify_score_ref if the token format ever
 * changes on that side.
 */
const crypto = require('crypto');

const SCORE_REF_SECRET = process.env.SCORE_REF_SECRET || '';

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

module.exports = { verifyScoreRef };
