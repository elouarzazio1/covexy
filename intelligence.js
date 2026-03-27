'use strict'

/**
 * Covexy V2 Deterministic Scorer
 *
 * No LLM calls. No profile keywords. Pure rule engine.
 * An insight either passes hard rules or it dies.
 */

const RELEVANCE_THRESHOLD = 7

const BLOCKED_ACTIVITIES = ['LEISURE', 'TRANSIT']

function extractProfileKeywords (profile) {
  if (!profile) return []
  const text = [
    profile.name || '',
    profile.profession || '',
    profile.projects || '',
    profile.ignore || ''
  ].join(' ').toLowerCase()
  const words = text.split(/[\s,.|;:\/\-()]+/).filter(w => w.length >= 4)
  return [...new Set(words)]
}

function scoreInsight (insightData, profile, aiChat) {
  const insight = insightData.insight || ''
  const whyNow = insightData.whyNow || ''
  const action = insightData.action || ''
  const category = (insightData.category || '').toUpperCase()
  const activityType = insightData.activityType || null
  const topicDomain = insightData.topicDomain || null
  const isWorkRelated = insightData.isWorkRelated

  const fullText = (insight + ' ' + whyNow + ' ' + action).toLowerCase()

  let score = 5
  let reasons = []

  // RULE 1: LEISURE and TRANSIT never produce insights
  if (activityType && BLOCKED_ACTIVITIES.includes(activityType)) {
    console.log('[Covexy] Score: 0 — activity type is ' + activityType)
    return Promise.resolve({ score: 0, reason: 'Activity type ' + activityType + ' never generates insights' })
  }

  // RULE 2: Profile keyword contamination
  const profileWords = extractProfileKeywords(profile)
  if (profileWords.length > 0 && topicDomain) {
    const topicWords = topicDomain.toLowerCase().split(/\W+/).filter(w => w.length >= 3)
    const insightWords = fullText.split(/\W+/).filter(w => w.length >= 4)

    const profileOnlyMatches = insightWords.filter(w =>
      profileWords.includes(w) && !topicWords.some(tw => w.includes(tw) || tw.includes(w))
    )

    const topicMatches = insightWords.filter(w =>
      topicWords.some(tw => w.includes(tw) || tw.includes(w))
    )

    if (profileOnlyMatches.length > 2 && topicMatches.length === 0) {
      console.log('[Covexy] Score: 0 — profile keyword contamination (' + profileOnlyMatches.slice(0, 3).join(', ') + ')')
      return Promise.resolve({ score: 0, reason: 'Insight connects to profile keywords only, not to screen content' })
    }
  }

  // RULE 2B: Cross-project contamination
  // If insight mentions multiple projects but screen activity only involves one, kill it
  const knownProjects = ['mention.ma', 'mention ma', 'inferencewatch', 'inference watch', 'covexy', 'geo platform', 'geo tracking']
  const insightProjects = knownProjects.filter(p => fullText.includes(p))
  const screenProjects = knownProjects.filter(p => (topicDomain || '').toLowerCase().includes(p) || (insightData.description || '').toLowerCase().includes(p))

  if (insightProjects.length >= 2 && screenProjects.length <= 1) {
    console.log('[Covexy] Score: 0 — cross-project contamination (' + insightProjects.join(', ') + ')')
    return Promise.resolve({ score: 0, reason: 'Insight forces connection between unrelated projects' })
  }

  // RULE 3: Screen description parroting
  if (topicDomain) {
    const domainWords = topicDomain.toLowerCase().split(/\W+/).filter(w => w.length >= 3)
    const insightSentence = insight.toLowerCase()
    const matchCount = domainWords.filter(w => insightSentence.includes(w)).length
    if (domainWords.length > 0 && matchCount >= domainWords.length * 0.8) {
      score -= 3
      reasons.push('Insight mostly describes what is already on screen')
    }
  }

  // RULE 4: Generic advice detection
  const genericPhrases = [
    'consider', 'you should', 'take a break', 'stay focused',
    'keep going', 'time management', 'productivity', 'work-life balance',
    'optimize your', 'leverage your', 'make sure to', "don't forget to",
    "it's important to", 'you might want to'
  ]
  const genericCount = genericPhrases.filter(p => fullText.includes(p)).length
  if (genericCount >= 2) {
    score -= 3
    reasons.push('Contains generic advice phrases')
  }

  // RULE 5: External information bonus
  const externalSignals = [
    'launched', 'announced', 'released', 'updated', 'changed',
    'raised', 'acquired', 'published', 'reported', 'filed',
    'deprecated', 'breached', 'surpassed', 'declined'
  ]
  const hasExternal = externalSignals.some(s => fullText.includes(s))
  if (hasExternal) {
    score += 3
    reasons.push('Contains external information signal')
  }

  // RULE 6: Specificity bonus
  const hasNumber = /\d{2,}/.test(fullText)
  const hasProperNoun = /[A-Z][a-z]{2,}/.test(insight)
  if (hasNumber) { score += 1; reasons.push('Contains specific data') }
  if (hasProperNoun) { score += 1; reasons.push('References specific entity') }

  // RULE 7: Time sensitivity bonus
  const timeSensitive = ['today', 'yesterday', 'this week', 'deadline', 'expires', 'ends', 'before', 'by tomorrow']
  const isTimeSensitive = timeSensitive.some(t => fullText.includes(t))
  if (isTimeSensitive) {
    score += 1
    reasons.push('Time-sensitive content')
  }

  // RULE 8: Cross-reference bonus
  const crossRef = ['earlier today', 'yesterday you', 'last week', 'this morning', 'on monday', 'on tuesday', 'on wednesday', 'on thursday', 'on friday', 'days ago', 'previously']
  const hasCrossRef = crossRef.some(c => fullText.includes(c))
  if (hasCrossRef) {
    score += 2
    reasons.push('Connects across different time contexts')
  }

  // RULE 9: Work relevance gate
  if (isWorkRelated === false) {
    score -= 2
    reasons.push('Screen activity is not work-related')
  }

  score = Math.max(0, Math.min(10, score))

  const reason = reasons.length > 0 ? reasons.join('; ') : 'Passed all rules with neutral score'
  console.log('[Covexy] Score: ' + score + '/10 — ' + reason)

  return Promise.resolve({ score, reason })
}

function shouldShowInsight (score) {
  return score >= RELEVANCE_THRESHOLD
}

module.exports = { scoreInsight, shouldShowInsight, RELEVANCE_THRESHOLD }
