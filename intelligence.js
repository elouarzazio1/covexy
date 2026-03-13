'use strict'

const RELEVANCE_THRESHOLD = 9

const SCORE_SYSTEM = `You are a relevance judge for a proactive AI assistant called Covexy. Covexy watches a user's screen and generates insights. Your job is to score each insight on a scale of 1 to 10 based on how genuinely useful it is RIGHT NOW for this specific person.

USER CONTEXT:
{{USER_CONTEXT}}

SCORING RULES:
10 = The user would stop what they are doing to act on this immediately
8-9 = Clearly useful, directly connected to what they are working on right now
6-7 = Somewhat relevant but they probably already know this or it can wait
4-5 = Generic, vague, or only loosely connected to their current screen
1-3 = Obvious, unhelpful, or something they definitely already know

PENALIZE HEAVILY (score 1-3) if the insight:
- Describes something already visible on screen
- Gives generic productivity advice
- Repeats common knowledge
- Has no connection to the user's specific projects or current activity

REWARD (score 8-10) if the insight:
- References something the user is actively working on right now
- Contains information the user likely does NOT already know
- Has a clear specific actionable next step
- Is time-sensitive or would change what the user does in the next 10 minutes
- Connects something the user actually did today with external information they have not seen
- Is specific enough that it could only apply to THIS person, not any founder
- Would make the user stop what they are doing and act on it immediately
- Generic AI news, GEO definitions, or funding advice scores 1 automatically regardless of relevance

Respond with ONLY a JSON object in this exact format, nothing else:
{"score": 7, "reason": "One sentence explaining the score."}`

async function scoreInsight (insight, profile, aiChat) {
  try {
    const userContext = [
      profile?.name       ? `Name: ${profile.name}`                    : null,
      profile?.profession ? `Role: ${profile.profession}`              : null,
      profile?.projects   ? `Current projects: ${profile.projects}`   : null,
    ].filter(Boolean).join('\n')

    const systemPrompt = SCORE_SYSTEM.replace('{{USER_CONTEXT}}', userContext)

    const insightText = [
      `INSIGHT: ${insight.insight   || ''}`,
      `WHY NOW: ${insight.whyNow    || ''}`,
      `ACTION:  ${insight.action    || ''}`,
      `CATEGORY: ${insight.category || ''}`,
    ].join('\n')

    const raw = await aiChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: insightText  }
      ],
      15000
    )

    const cleaned = raw.replace(/```json|```/g, '').trim()
    const parsed  = JSON.parse(cleaned)
    const score   = typeof parsed.score  === 'number' ? Math.round(parsed.score) : 5
    const reason  = typeof parsed.reason === 'string' ? parsed.reason            : ''

    console.log(`[Covexy] 🎯 Relevance score: ${score}/10 — ${reason}`)
    return { score, reason }

  } catch (e) {
    console.log('[Covexy] Scoring error (defaulting to 6):', e.message)
    return { score: 6, reason: 'Scoring unavailable' }
  }
}

function shouldShowInsight (score) {
  return score >= RELEVANCE_THRESHOLD
}

module.exports = { scoreInsight, shouldShowInsight, RELEVANCE_THRESHOLD }
