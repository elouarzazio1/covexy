'use strict'

/**
 * Covexy V2 Preparer
 *
 * Generates prepared content for the user based on behavioral patterns.
 * Runs once per day during idle detection (no DEEP_WORK for 30+ minutes).
 * Uses Claude Sonnet via OpenRouter.
 *
 * Six template types:
 * - SUMMARY: condense what you consumed today into key points
 * - BRIEFING: what changed overnight relevant to your Work Graph
 * - DRAFT: start a piece of writing based on research patterns
 * - REMINDER: something you started but did not return to
 * - CONNECTION: two things from different days that relate
 * - ALERT: something external changed that affects current task
 */

const PREPARER_MODEL = 'anthropic/claude-sonnet-4-20250514'

// Track whether preparer has run today
let lastPreparedDate = null
let preparerRunning = false

/**
 * Decide which template type to run based on Work Graph data.
 * Returns the most relevant template type for today.
 */
function selectTemplate (ctx, stats, unfinished) {
  // If there are unfinished deep work sessions, prioritize REMINDER
  if (unfinished && unfinished.length > 0) {
    return 'REMINDER'
  }

  // If deep work dominates today, prepare a SUMMARY of what was accomplished
  if (stats.deepWorkMinutes > 60) {
    return 'SUMMARY'
  }

  // If research dominates, prepare a DRAFT based on research topics
  if (stats.researchMinutes > 45) {
    return 'DRAFT'
  }

  // If communication dominates, prepare a BRIEFING for tomorrow
  if (stats.communicationMinutes > stats.deepWorkMinutes) {
    return 'BRIEFING'
  }

  // Default: SUMMARY
  return 'SUMMARY'
}

/**
 * Build the prompt for the selected template type.
 */
function buildPreparerPrompt (templateType, ctx, profile, unfinished) {
  const userName = profile?.name || 'the user'
  const style = profile?.style || 'direct and concise'
  const priority = ctx.currentPriority || 'their current work'

  const baseContext = [
    'Current priority project: ' + priority,
    'Today summary: ' + ctx.todaySummary,
    'Top topics: ' + ctx.topTopics,
    'Current session: ' + ctx.currentSession,
    'Communication style: ' + style
  ].join('\n')

  const templates = {
    SUMMARY: {
      system: 'You are Covexy, preparing an end-of-day summary for ' + userName + '. Write a concise summary of what they accomplished today based on the behavioral data. No generic advice. No filler. Just what happened and what it means.\n\n' + baseContext,
      user: 'Write a 3-5 line summary of today. What was accomplished. What took the most time. One observation about the day. Do not give advice unless something specific stands out.'
    },
    BRIEFING: {
      system: 'You are Covexy, preparing a morning briefing for ' + userName + '. Based on yesterday\'s activity patterns, write what they should know before starting today.\n\n' + baseContext,
      user: 'Write a 3-5 line briefing. What was left unfinished yesterday. What the priority should be today based on patterns. One thing to watch for. No generic productivity advice.'
    },
    DRAFT: {
      system: 'You are Covexy, preparing a content draft for ' + userName + '. They spent significant time researching today. Based on the topics they explored, draft the opening of a piece of content (LinkedIn post, article intro, or structured note) that captures what they learned.\n\n' + baseContext,
      user: 'Write a 4-6 line draft based on the research topics. Match their communication style. Make it specific to what they were actually reading about. This is a starting point they will edit, not a finished piece.'
    },
    REMINDER: {
      system: 'You are Covexy, reminding ' + userName + ' about unfinished work.\n\nUnfinished sessions:\n' + (unfinished || []).map(s => '- ' + s.topic + ' (' + s.durationMinutes + ' min, abandoned)').join('\n') + '\n\n' + baseContext,
      user: 'Write 2-3 lines about the most important unfinished work. What they were doing. How long they spent. Why it might be worth returning to. No generic advice. Be specific.'
    },
    CONNECTION: {
      system: 'You are Covexy, finding connections in ' + userName + '\'s work patterns.\n\n' + baseContext,
      user: 'Look at the top topics and find one non-obvious connection between two different topics or activities from today. Write 2-3 lines explaining the connection and why it might be useful. If no meaningful connection exists, say so in one line.'
    },
    ALERT: {
      system: 'You are Covexy, checking for external changes relevant to ' + userName + '\'s work.\n\n' + baseContext,
      user: 'Based on the current priority project, identify one thing that may have changed externally (tool update, competitor move, market shift) that the user should know. If nothing specific comes to mind, respond with SKIP. Do not invent information.'
    }
  }

  return templates[templateType] || templates.SUMMARY
}

/**
 * Run the Preparer. Called from main.js.
 * Requires: aiChat function, profile, Work Graph context, and memory functions.
 */
async function runPreparer (deps) {
  const { axiosPost, openRouterUrl, apiKey, headers, profile, workGraphCtx, workGraphStats, unfinished, addMemoryEntry, push, getInsights } = deps

  // Only run once per day
  const today = new Date().toISOString().split('T')[0]
  if (lastPreparedDate === today) {
    console.log('[Covexy] 📋 Preparer: already ran today — skipping')
    return
  }

  if (preparerRunning) return
  preparerRunning = true

  console.log('[Covexy] 📋 Preparer running...')

  try {
    const ctx = workGraphCtx
    const stats = workGraphStats
    const unfinishedSessions = unfinished

    // Skip if very little activity today
    if (stats.totalEntries < 5) {
      console.log('[Covexy] 📋 Preparer: not enough activity today — skipping')
      preparerRunning = false
      return
    }

    // Select template based on behavioral data
    const templateType = selectTemplate(ctx, stats, unfinishedSessions)
    console.log('[Covexy] 📋 Preparer template:', templateType)

    // Build prompt
    const prompt = buildPreparerPrompt(templateType, ctx, profile, unfinishedSessions)

    // Call Claude Sonnet
    const res = await axiosPost(openRouterUrl, {
      model: PREPARER_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ]
    }, {
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', ...headers },
      timeout: 30000
    })

    const content = res.data.choices?.[0]?.message?.content?.trim() || ''

    if (!content || content.length < 20 || /^SKIP/i.test(content)) {
      console.log('[Covexy] 📋 Preparer: nothing worth preparing')
      preparerRunning = false
      return
    }

    // Save as a prepared insight
    const saved = addMemoryEntry({
      type: 'proactive_insight',
      content: content,
      category: templateType,
      action: '',
      whyNow: 'Prepared by Covexy based on your activity patterns',
      source: 'preparer',
      templateType: templateType,
      tags: [templateType.toLowerCase(), 'prepared'],
      confidence: 'HIGH'
    })

    if (saved) {
      lastPreparedDate = today
      push('insights-update', getInsights())
      console.log('[Covexy] 📋 Preparer delivered: [' + templateType + '] ' + content.slice(0, 80))
    }

  } catch (e) {
    console.log('[Covexy] 📋 Preparer error:', e.message)
  }

  preparerRunning = false
}

/**
 * Check if conditions are right for the Preparer to run.
 * Called from the Observer cycle in main.js.
 */
function shouldRunPreparer (stats, lastActivityType) {
  const today = new Date().toISOString().split('T')[0]

  // Already ran today
  if (lastPreparedDate === today) return false

  // Not enough data yet
  if (stats.totalEntries < 5) return false

  // Run when user is idle (not in DEEP_WORK) and has had a meaningful day
  const totalWorkMinutes = stats.deepWorkMinutes + stats.researchMinutes + stats.communicationMinutes
  if (totalWorkMinutes < 30) return false

  // Only trigger during non-deep-work moments
  if (lastActivityType === 'DEEP_WORK') return false

  return true
}

module.exports = {
  runPreparer,
  shouldRunPreparer,
  selectTemplate
}
