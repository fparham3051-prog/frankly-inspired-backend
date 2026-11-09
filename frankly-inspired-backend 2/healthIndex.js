/**
 * Maps each free tool's areas onto the seven InstitutionalOS Health Index
 * dimensions, so every lead arrives in the operations app speaking the
 * same language as the paid diagnostic.
 *
 * These are INDICATIVE, self-reported readings (each dimension is the
 * average of the tool areas that map to it, as a 0-100 percentage). They
 * are a starting point for the diagnostic conversation, not a verified
 * Health Index score: verified scores still require evidence.
 */

const DIMENSIONS = [
  'Strategy and Positioning',
  'Program and Impact Evidence',
  'Revenue and Financial Health',
  'Leadership and Organizational Capacity',
  'Operations and Infrastructure',
  'Partnerships and Ecosystem',
  'Governance and Risk',
];

// tool -> { area label (as the tool sends it) -> dimension }
const MAP = {
  'self-assessment': {
    'Sustainability Strategy': 'Strategy and Positioning',
    'Revenue Diversification': 'Revenue and Financial Health',
    'Leadership & Organizational Development': 'Leadership and Organizational Capacity',
    'Operations & Infrastructure': 'Operations and Infrastructure',
    'Partnership & Ecosystem Strategy': 'Partnerships and Ecosystem',
  },
  'revenue-growth': {
    'Operating Reserve': 'Revenue and Financial Health',
    'Program Expense Ratio': 'Revenue and Financial Health',
    'Revenue Diversification': 'Revenue and Financial Health',
    'Current Ratio (Liquidity)': 'Revenue and Financial Health',
    'Donor Retention Rate': 'Revenue and Financial Health',
  },
  'institutional-advancement': {
    'Gift Portfolio Strategy & Staffing': 'Revenue and Financial Health',
    'Moves Management & Stewardship': 'Revenue and Financial Health',
    'Campaign Structure & Readiness': 'Revenue and Financial Health',
    'Events as Strategy': 'Revenue and Financial Health',
    'Planned & Legacy Giving': 'Revenue and Financial Health',
  },
  leadership: {
    'Governance Health': 'Governance and Risk',
    'Leadership Succession & Bench Strength': 'Leadership and Organizational Capacity',
    'Organizational Alignment & Execution': 'Leadership and Organizational Capacity',
    'Change Leadership Capacity': 'Leadership and Organizational Capacity',
  },
  sustainability: {
    'Strategic Clarity & Public Value': 'Strategy and Positioning',
    'Risk Identification & Management': 'Governance and Risk',
    'Impact & Financial Sustainability Integration': 'Program and Impact Evidence',
    'Roadmap & Implementation Discipline': 'Strategy and Positioning',
  },
};

/** Returns [{dimension, pct, areas}] for the dimensions this tool touches. */
function mapToHealthIndex(tool, pillarScores) {
  const toolMap = MAP[tool] || MAP['self-assessment'];
  const buckets = {};
  for (const p of pillarScores || []) {
    if (!p || typeof p.label !== 'string' || typeof p.pct !== 'number') continue;
    const dim = toolMap[p.label.trim()];
    if (!dim) continue;
    (buckets[dim] = buckets[dim] || []).push(p);
  }
  return DIMENSIONS.filter(d => buckets[d]).map(d => ({
    dimension: d,
    pct: Math.round(buckets[d].reduce((s, p) => s + p.pct, 0) / buckets[d].length),
    areas: buckets[d].map(p => p.label),
  }));
}

function formatHealthIndex(rows) {
  if (!rows.length) return '';
  return 'Indicative Health Index (self-reported, unverified):\n' +
    rows.map(r => `- ${r.dimension}: ${r.pct}%`).join('\n');
}

module.exports = { DIMENSIONS, mapToHealthIndex, formatHealthIndex };
