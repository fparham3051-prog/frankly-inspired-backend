/**
 * Public Form 990 lookup for the free tools, via ProPublica's Nonprofit
 * Explorer API (free, no key: https://projects.propublica.org/nonprofits/api).
 *
 * Two uses:
 *   searchOrgs(q, state)  -> name/EIN search so a visitor can find their org
 *   orgSnapshot(ein)      -> up to five years of filed 990 summary figures,
 *                            plus plain-language signals a funder would see
 *
 * This is what moves the free tools from pure self-report toward evidence:
 * the same public filing a grantmaker reads. Results are cached in memory
 * for 12 hours to stay well inside ProPublica's fair-use expectations.
 * Attribution ("IRS Form 990 data via ProPublica Nonprofit Explorer") is
 * shown wherever the data appears.
 */

const BASE = 'https://projects.propublica.org/nonprofits/api/v2';
const UA = 'FranklyInspiredWebsite/1.0 (+https://franklyinspired.associates)';
const TTL = 12 * 60 * 60 * 1000;
const cache = new Map();

async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ProPublica ${res.status}`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const fmtEin = (ein) => { const s = String(ein).padStart(9, '0'); return s.slice(0, 2) + '-' + s.slice(2); };
const STATE_RE = /^[A-Z]{2}$/;

async function searchOrgs(q, state) {
  const query = String(q || '').trim().slice(0, 100);
  if (query.length < 3) return [];
  // An EIN typed with or without the dash goes straight to the org.
  const digits = query.replace(/[^0-9]/g, '');
  if (digits.length === 9 && /^[0-9-\s]+$/.test(query)) {
    const snap = await getJson(`${BASE}/organizations/${digits}.json`);
    const o = snap && snap.organization;
    return o ? [{ ein: fmtEin(o.ein), name: o.name, city: o.city || '', state: o.state || '', ntee: o.ntee_code || '' }] : [];
  }
  let url = `${BASE}/search.json?q=${encodeURIComponent(query)}`;
  if (state && STATE_RE.test(state)) url += `&state%5Bid%5D=${state}`;
  const data = await getJson(url);
  return ((data && data.organizations) || []).slice(0, 8).map((o) => ({
    ein: fmtEin(o.ein), name: o.name, city: o.city || '', state: o.state || '', ntee: o.ntee_code || '',
  }));
}

function signalsFor(years) {
  const s = [];
  const [a, b] = years;
  if (!a) return s;
  if (a.revenue && a.expenses) {
    const margin = (a.revenue - a.expenses) / a.revenue;
    s.push(margin >= 0
      ? { tone: 'good', text: `Ended FY${a.year} with a surplus of ${Math.round(margin * 100)}% of revenue.` }
      : { tone: 'watch', text: `Ended FY${a.year} with a deficit of ${Math.round(-margin * 100)}% of revenue.` });
  }
  const deficits = years.filter((y) => y.revenue != null && y.expenses != null && y.expenses > y.revenue).length;
  if (years.length >= 3 && deficits >= 2) s.push({ tone: 'watch', text: `Expenses exceeded revenue in ${deficits} of the last ${years.length} filed years.` });
  if (b && a.revenue && b.revenue) {
    const g = (a.revenue - b.revenue) / b.revenue;
    s.push({ tone: g >= -0.05 ? 'good' : 'watch', text: `Revenue ${g >= 0 ? 'grew' : 'fell'} ${Math.abs(Math.round(g * 100))}% from FY${b.year} to FY${a.year}.` });
  }
  if (a.monthsNetAssets != null) {
    s.push({ tone: a.monthsNetAssets >= 3 ? 'good' : 'watch', text: `Net assets equal about ${a.monthsNetAssets} months of expenses. This counts all net assets, not just unrestricted cash, so true reserves are usually lower.` });
  }
  if (a.contributionShare != null) {
    s.push({ tone: a.contributionShare > 0.9 ? 'watch' : 'neutral', text: `${Math.round(a.contributionShare * 100)}% of revenue came from contributions and grants${a.contributionShare > 0.9 ? ', so nearly all funding depends on donors and grantmakers' : ''}.` });
  }
  return s;
}

async function orgSnapshot(einRaw) {
  const ein = String(einRaw || '').replace(/[^0-9]/g, '');
  if (ein.length !== 9) return null;
  const data = await getJson(`${BASE}/organizations/${ein}.json`);
  if (!data || !data.organization) return null;
  const o = data.organization;
  const years = (data.filings_with_data || [])
    .filter((f) => num(f.tax_prd_yr))
    .sort((x, y) => y.tax_prd_yr - x.tax_prd_yr)
    .slice(0, 5)
    .map((f) => {
      const revenue = num(f.totrevenue), expenses = num(f.totfuncexpns);
      const assets = num(f.totassetsend), liabilities = num(f.totliabend);
      const netAssets = num(f.totnetassetend) ?? (assets != null && liabilities != null ? assets - liabilities : null);
      const contributions = num(f.totcntrbgfts);
      return {
        year: f.tax_prd_yr,
        form: f.formtype === 1 ? '990-EZ' : f.formtype === 2 ? '990-PF' : '990',
        revenue, expenses, assets, liabilities, netAssets, contributions,
        programRevenue: num(f.totprgmrevnue),
        surplus: revenue != null && expenses != null ? revenue - expenses : null,
        monthsNetAssets: netAssets != null && expenses ? Math.round((netAssets / (expenses / 12)) * 10) / 10 : null,
        contributionShare: contributions != null && revenue ? Math.max(0, Math.min(1, contributions / revenue)) : null,
        pdfUrl: typeof f.pdf_url === 'string' && /^https:\/\//.test(f.pdf_url) ? f.pdf_url : null,
      };
    });
  return {
    org: { ein: fmtEin(o.ein), name: o.name, city: o.city || '', state: o.state || '', ntee: o.ntee_code || '' },
    years,
    signals: signalsFor(years),
    links: {
      propublica: `https://projects.propublica.org/nonprofits/organizations/${ein}`,
      candid: `https://www.guidestar.org/profile/${fmtEin(ein)}`,
    },
    source: 'IRS Form 990 data via ProPublica Nonprofit Explorer',
  };
}

module.exports = { searchOrgs, orgSnapshot, fmtEin };
