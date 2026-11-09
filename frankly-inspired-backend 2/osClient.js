/**
 * Sends leads straight into the Frankly Inspired Operating System's
 * Prospecting view the moment they arrive, instead of waiting for the
 * daily Gmail import.
 *
 * Needs two environment variables on this Render service:
 *   OS_API_URL         e.g. https://frankly-inspired-os.onrender.com
 *   OS_PROSPECTS_TOKEN the operations app's prospects-scoped admin key
 * If either is missing this does nothing, and leads still reach the app
 * through the email + daily import path as before.
 *
 * Never throws and never delays the visitor for long: a failure here just
 * means the email fallback picks the lead up instead.
 */

const OS_API_URL = (process.env.OS_API_URL || '').replace(/\/+$/, '');
const OS_PROSPECTS_TOKEN = process.env.OS_PROSPECTS_TOKEN || '';

function osConfigured() {
  return Boolean(OS_API_URL && OS_PROSPECTS_TOKEN);
}

/**
 * @param {{name:string, org?:string, source:string, notes?:string, link?:string, sourceRef:string}} lead
 * @returns {Promise<boolean>} true if the app confirmed it (created or already present)
 */
async function pushProspect(lead) {
  if (!osConfigured()) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(OS_API_URL + '/api/admin/prospects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': OS_PROSPECTS_TOKEN },
      body: JSON.stringify({
        items: [{
          name: lead.name,
          org: lead.org || '',
          source: lead.source,
          status: 'new',
          link: lead.link || '',
          notes: lead.notes || '',
          sourceRef: lead.sourceRef,
        }],
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      console.error('pushProspect: operations app rejected the lead', res.status, data);
      return false;
    }
    return true;
  } catch (err) {
    console.error('pushProspect failed:', err.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Public Giving Landscape feed (read-only, cached) ----------
let givingCache = { at: 0, data: null };
const GIVING_TTL_MS = 60 * 60 * 1000;

async function getGivingLandscape(limit = 6) {
  if (!OS_API_URL) return null;
  if (givingCache.data && Date.now() - givingCache.at < GIVING_TTL_MS) {
    return givingCache.data.slice(0, limit);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(OS_API_URL + '/api/public/giving-landscape', { signal: controller.signal });
    if (!res.ok) return givingCache.data ? givingCache.data.slice(0, limit) : null;
    const data = await res.json();
    const gifts = Array.isArray(data.gifts) ? data.gifts : [];
    givingCache = { at: Date.now(), data: gifts };
    return gifts.slice(0, limit);
  } catch (err) {
    console.error('getGivingLandscape failed:', err.message);
    return givingCache.data ? givingCache.data.slice(0, limit) : null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { osConfigured, pushProspect, getGivingLandscape };
