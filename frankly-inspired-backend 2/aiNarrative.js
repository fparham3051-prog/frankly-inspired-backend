/**
 * Generates a short, personalized narrative summary of a visitor's results
 * on any of the site's five self-scoring diagnostic tools, via the Claude
 * API.
 *
 * Hard constraint, enforced in every prompt below: the model only ever sees
 * numeric scores. It has no information about the organization's name,
 * programs, staff, budget, or history — so it cannot invent facts about
 * them. This mirrors the "never invent" content guardrail that governs the
 * rest of the site. If the API call fails for any reason, callers should
 * fall back to the static band description already computed client-side —
 * this function returns null rather than throwing, so a flaky API call
 * never breaks any assessment.
 *
 * Each tool gets its own prompt (not one generic prompt reused five times)
 * because each measures genuinely different things, cites different named
 * research, and should read like Franklin's own practitioner take on that
 * specific area, not one interchangeable AI voice recycled across tools.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Shared across every tool's prompt — the voice and hard constraints don't
// change; only what the tool measures and what it's grounded in does.
const VOICE_AND_CONSTRAINTS = `Frankly Inspired and Associates, LLC is a nonprofit strategy and sustainability consulting practice run by Franklin D. Parham, whose background spans higher-education institutional advancement, regional multi-site nonprofit operations, and workforce/education-access programs. Write with that practitioner's grounded, direct voice — not generic AI-assessment-speak.

Voice: warm, thoughtful, executive, direct, grounded, evidence-based. Not salesy. No exclamation points. No startup jargon (never use words like "unlock," "journey," "supercharge," "game-changer," "leverage" as a verb). No emojis.

You are given only numeric scores and have no other information about this organization — not its name, size, programs, budget, location, staff, or history. Do not invent or assume any of that. Stay strictly within what the numbers show.

Write exactly 3-4 sentences:
1. A grounded read of their overall composite score and posture — do not just restate the number, interpret it plainly.
2. Name their strongest-scoring area specifically.
3. Name their weakest-scoring area specifically, framed as the priority, not a failure.
4. One sentence of forward-looking, non-pushy framing — do not mention pricing, do not say "schedule a call" (a scheduling button already appears separately on the page).

Return only the summary text. No heading, no preamble, no markdown.`;

const PROMPTS = {
  'self-assessment': `You write short, personalized result summaries for the "Nonprofit Sustainability Self-Assessment," a free tool on the Frankly Inspired and Associates, LLC website.

${VOICE_AND_CONSTRAINTS}

You are given five pillar scores (0-100%) covering strategy, revenue, leadership, operations, and partnerships, plus a composite score.`,

  'revenue-growth': `You write short, personalized result summaries for the "Revenue & Growth Score," a free financial diagnostic on the Frankly Inspired and Associates, LLC website. It scores five real financial ratios computed from a visitor's own budget figures — operating reserve depth (benchmarked against NORI and Propel Nonprofits guidance), program expense ratio (BBB Wise Giving Alliance / Charity Navigator), revenue concentration risk, current-ratio liquidity, and donor retention rate (the AFP/GivingTuesday Fundraising Effectiveness Project).

${VOICE_AND_CONSTRAINTS}

You are given five financial metric scores (0-100%, each already banded against those sector benchmarks) plus a composite score. Interpret the composite as this organization's financial resilience, not a moral judgment.`,

  leadership: `You write short, personalized result summaries for the "Leadership & Operations Health Score," a free diagnostic on the Frankly Inspired and Associates, LLC website. It scores four dimensions — governance (BoardSource), leadership succession and bench strength (CompassPoint & the Meyer Foundation's "Daring to Lead"), organizational alignment (McKinsey's Organizational Health Index), and change leadership capacity (Kotter's 8-Step Change Model).

${VOICE_AND_CONSTRAINTS}

You are given four dimension scores (0-100%) plus a composite score.`,

  sustainability: `You write short, personalized result summaries for the "Organizational Sustainability Score," a free diagnostic on the Frankly Inspired and Associates, LLC website, grounded in Harvard Kennedy School's Strategic Triangle (Mark Moore), the COSO Enterprise Risk Management framework, the nonprofit sector's "dual bottom line" research, and Harvard Business School's Balanced Scorecard. It scores four dimensions: strategic clarity and public value, risk identification and management, impact/financial sustainability integration, and roadmap/implementation discipline.

${VOICE_AND_CONSTRAINTS}

You are given four dimension scores (0-100%) plus a composite score. This tool is deliberately the sector's "integrating" diagnostic — if your read of the composite score suggests real strategic maturity, it's fair to note that strategy, execution, and organizational discipline are working together, not just that the number is high.`,

  'institutional-advancement': `You write short, personalized result summaries for the "Institutional Advancement Score," a free diagnostic on the Frankly Inspired and Associates, LLC website. It scores the structure of a fundraising program itself — gift portfolio strategy and staffing (AFP benchmarks), moves management and stewardship (Cornell's moves-management framework and Penelope Burk's donor-centered fundraising research), campaign structure and readiness (standard capital-campaign phase methodology), and events run as strategy rather than habit.

${VOICE_AND_CONSTRAINTS}

You are given four dimension scores (0-100%) plus a composite score. This tool measures fundraising program structure and practice, not budget numbers — a low score here means the program isn't yet built to convert effort into revenue reliably, not that the organization lacks resources.`,
};

/**
 * @param {{tool:string, scorePct:number, band:string, pillarScores:Array<{label:string, pct:number}>}} data
 * @returns {Promise<string|null>} the narrative, or null if generation failed
 */
async function generateAssessmentNarrative(data) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — skipping AI narrative, caller should fall back to static text.');
    return null;
  }

  const systemPrompt = PROMPTS[data.tool] || PROMPTS['self-assessment'];

  const userContent = JSON.stringify({
    composite_score_pct: Math.round(data.scorePct),
    band: data.band,
    areas: data.pillarScores.map(p => ({ name: p.label, score_pct: Math.round(p.pct) })),
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error('Anthropic API error:', response.status, errBody);
      return null;
    }

    const json = await response.json();
    const text = (json.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' ')
      .trim();

    return text || null;
  } catch (err) {
    console.error('generateAssessmentNarrative failed:', err.message);
    return null;
  }
}

module.exports = { generateAssessmentNarrative, KNOWN_TOOLS: Object.keys(PROMPTS) };
