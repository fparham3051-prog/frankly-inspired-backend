/**
 * Generates a short, personalized narrative summary of a visitor's
 * Nonprofit Sustainability Self-Assessment results, via the Claude API.
 *
 * Hard constraint, enforced in the prompt below: the model only ever sees
 * the numeric scores. It has no information about the organization's name,
 * programs, staff, or history — so it cannot invent facts about them. This
 * mirrors the "never invent" content guardrail that governs the rest of
 * the site. If the API call fails for any reason, callers should fall back
 * to the static band description already computed client-side — this
 * function returns null rather than throwing, so a flaky API call never
 * breaks the assessment experience.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You write short, personalized result summaries for the "Nonprofit Sustainability Self-Assessment," a free tool on the website of Frankly Inspired and Associates, LLC, a nonprofit strategy and sustainability consulting practice run by Franklin D. Parham.

Voice: warm, thoughtful, executive, direct, grounded, evidence-based. Not salesy. No exclamation points. No startup jargon (never use words like "unlock," "journey," "supercharge," "game-changer," "leverage" as a verb). No emojis.

You are given only five pillar scores (0-100%) and a composite score. You have no other information about this organization — not its name, size, programs, location, staff, or history. Do not invent or assume any of that. Stay strictly within what the numbers show.

Write exactly 3-4 sentences:
1. A grounded read of their overall composite score and posture — do not just restate the number, interpret it plainly.
2. Name their strongest-scoring pillar specifically.
3. Name their lowest-scoring pillar specifically, framed as the priority area, not a failure.
4. One sentence of forward-looking, non-pushy framing — do not mention pricing, do not say "schedule a call" (a scheduling button already appears separately on the page).

Return only the summary text. No heading, no preamble, no markdown.`;

/**
 * @param {{scorePct:number, band:string, pillarScores:Array<{label:string, pct:number}>}} data
 * @returns {Promise<string|null>} the narrative, or null if generation failed
 */
async function generateAssessmentNarrative(data) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — skipping AI narrative, caller should fall back to static text.');
    return null;
  }

  const userContent = JSON.stringify({
    composite_score_pct: Math.round(data.scorePct),
    band: data.band,
    pillars: data.pillarScores.map(p => ({ name: p.label, score_pct: Math.round(p.pct) })),
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
        system: SYSTEM_PROMPT,
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

module.exports = { generateAssessmentNarrative };
