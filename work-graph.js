'use strict'

/**
 * Covexy V2 Work Graph
 *
 * Builds a behavioral model from structured activity data.
 * No API calls. Pure code logic. Zero cost.
 *
 * Updates every time the Observer logs an entry.
 * The Analyst reads from this instead of raw prose logs.
 */

const fs = require('fs')
const path = require('path')

// The behavioral model — rebuilt from activity data
let workGraph = {
  // Time patterns
  workHours: {},           // { "09": 12, "10": 15, ... } — count of work entries per hour
  leisureHours: {},        // { "22": 8, "23": 10, ... } — count of leisure entries per hour

  // App usage
  topApps: {},             // { "Chrome": 45, "VS Code": 30, ... }

  // Topic frequency
  topTopics: {},           // { "coding": 20, "email": 15, "football": 8, ... }

  // Project inference
  projectSignals: {},      // { "mention.ma": 12, "covexy": 8, "inferencewatch": 3 }
  currentPriority: null,   // inferred from last 3 days

  // Session tracking
  currentSession: null,    // { topic, activityType, startTime, lastSeen }
  unfinishedSessions: [],  // sessions that ended abruptly (switched away from DEEP_WORK)

  // Drift detection
  lastActivityType: null,
  lastActivityTime: null,
  driftEvents: [],         // { from, to, timestamp }

  // Daily summary
  todayStats: {
    deepWorkMinutes: 0,
    researchMinutes: 0,
    communicationMinutes: 0,
    adminMinutes: 0,
    leisureMinutes: 0,
    transitMinutes: 0,
    totalEntries: 0
  },

  // Meta
  lastUpdated: null,
  totalEntriesProcessed: 0
}

// How many days of history to analyze for priority inference
const PRIORITY_LOOKBACK_DAYS = 3

// Minimum minutes in a session before it counts as "unfinished" when abandoned
const MIN_SESSION_MINUTES = 10

// Interval between scans in minutes (used to estimate time spent)
const SCAN_INTERVAL_MINUTES = 3

function resetDailyStats () {
  workGraph.todayStats = {
    deepWorkMinutes: 0,
    researchMinutes: 0,
    communicationMinutes: 0,
    adminMinutes: 0,
    leisureMinutes: 0,
    transitMinutes: 0,
    totalEntries: 0
  }
}

/**
 * Process a single structured activity entry.
 * Called every time the Observer logs something.
 */
function processActivity (entry) {
  if (!entry || !entry.activityType) return

  const now = new Date(entry.timestamp || Date.now())
  const hour = now.getHours().toString().padStart(2, '0')
  const type = entry.activityType
  const app = entry.appName || 'unknown'
  const topic = (entry.topicDomain || 'unknown').toLowerCase()
  const isWork = entry.isWorkRelated

  // Update time patterns
  if (isWork) {
    workGraph.workHours[hour] = (workGraph.workHours[hour] || 0) + 1
  } else {
    workGraph.leisureHours[hour] = (workGraph.leisureHours[hour] || 0) + 1
  }

  // Update app usage
  if (app !== 'unknown') {
    workGraph.topApps[app] = (workGraph.topApps[app] || 0) + 1
  }

  // Update topic frequency
  const topicWords = topic.split(/[,;\/]+/).map(t => t.trim()).filter(t => t.length > 1)
  topicWords.forEach(t => {
    workGraph.topTopics[t] = (workGraph.topTopics[t] || 0) + 1
  })

  // Update project signals from description and topic
  const descLower = (entry.description || '').toLowerCase() + ' ' + topic
  const projectKeywords = {
    'mention.ma': ['mention.ma', 'mention ma', 'geo platform', 'geo tracking', 'generative engine'],
    'inferencewatch': ['inferencewatch', 'inference watch', 'ai pricing', 'model pricing', 'ai procurement'],
    'covexy': ['covexy', 'proactive ai', 'screen observer', 'work graph', 'deterministic scorer']
  }

  Object.entries(projectKeywords).forEach(([project, keywords]) => {
    if (keywords.some(kw => descLower.includes(kw))) {
      workGraph.projectSignals[project] = (workGraph.projectSignals[project] || 0) + 1
    }
  })

  // Update daily stats
  const minutesPerEntry = SCAN_INTERVAL_MINUTES
  switch (type) {
    case 'DEEP_WORK':      workGraph.todayStats.deepWorkMinutes += minutesPerEntry; break
    case 'RESEARCH':       workGraph.todayStats.researchMinutes += minutesPerEntry; break
    case 'COMMUNICATION':  workGraph.todayStats.communicationMinutes += minutesPerEntry; break
    case 'ADMIN':          workGraph.todayStats.adminMinutes += minutesPerEntry; break
    case 'LEISURE':        workGraph.todayStats.leisureMinutes += minutesPerEntry; break
    case 'TRANSIT':        workGraph.todayStats.transitMinutes += minutesPerEntry; break
  }
  workGraph.todayStats.totalEntries++

  // Session tracking
  updateSession(entry, now)

  // Drift detection
  detectDrift(entry, now)

  // Update meta
  workGraph.lastUpdated = now.toISOString()
  workGraph.totalEntriesProcessed++
}

/**
 * Track work sessions and detect unfinished ones.
 */
function updateSession (entry, now) {
  const type = entry.activityType
  const topic = (entry.topicDomain || 'unknown').toLowerCase()

  if (type === 'DEEP_WORK' || type === 'RESEARCH') {
    if (!workGraph.currentSession || workGraph.currentSession.topic !== topic) {
      // New session started
      if (workGraph.currentSession && workGraph.currentSession.activityType === 'DEEP_WORK') {
        // Previous session was deep work and we switched topic — mark as potentially unfinished
        const sessionMinutes = (now - new Date(workGraph.currentSession.startTime)) / 60000
        if (sessionMinutes >= MIN_SESSION_MINUTES) {
          workGraph.unfinishedSessions.push({
            topic: workGraph.currentSession.topic,
            activityType: workGraph.currentSession.activityType,
            startTime: workGraph.currentSession.startTime,
            endTime: now.toISOString(),
            durationMinutes: Math.round(sessionMinutes)
          })
          // Keep only last 10 unfinished sessions
          if (workGraph.unfinishedSessions.length > 10) {
            workGraph.unfinishedSessions = workGraph.unfinishedSessions.slice(-10)
          }
        }
      }
      workGraph.currentSession = {
        topic,
        activityType: type,
        startTime: now.toISOString(),
        lastSeen: now.toISOString()
      }
    } else {
      // Same session continues
      workGraph.currentSession.lastSeen = now.toISOString()
    }
  } else if (type === 'LEISURE' || type === 'TRANSIT') {
    // User left work — check if previous session was meaningful
    if (workGraph.currentSession && workGraph.currentSession.activityType === 'DEEP_WORK') {
      const sessionMinutes = (now - new Date(workGraph.currentSession.startTime)) / 60000
      if (sessionMinutes >= MIN_SESSION_MINUTES) {
        workGraph.unfinishedSessions.push({
          topic: workGraph.currentSession.topic,
          activityType: workGraph.currentSession.activityType,
          startTime: workGraph.currentSession.startTime,
          endTime: now.toISOString(),
          durationMinutes: Math.round(sessionMinutes)
        })
        if (workGraph.unfinishedSessions.length > 10) {
          workGraph.unfinishedSessions = workGraph.unfinishedSessions.slice(-10)
        }
      }
    }
    workGraph.currentSession = null
  }
}

/**
 * Detect drift: switching from work to leisure during work hours,
 * or other significant context switches.
 */
function detectDrift (entry, now) {
  const type = entry.activityType
  const prevType = workGraph.lastActivityType

  if (prevType && prevType !== type) {
    // Context switch detected
    const isWorkToLeisure = (prevType === 'DEEP_WORK' || prevType === 'RESEARCH') && type === 'LEISURE'
    const isLeisureToWork = prevType === 'LEISURE' && (type === 'DEEP_WORK' || type === 'RESEARCH')

    if (isWorkToLeisure || isLeisureToWork) {
      workGraph.driftEvents.push({
        from: prevType,
        to: type,
        timestamp: now.toISOString()
      })
      // Keep only last 20 drift events
      if (workGraph.driftEvents.length > 20) {
        workGraph.driftEvents = workGraph.driftEvents.slice(-20)
      }
    }
  }

  workGraph.lastActivityType = type
  workGraph.lastActivityTime = now.toISOString()
}

/**
 * Infer current priority project from recent activity data.
 * Reads activity files from the last PRIORITY_LOOKBACK_DAYS days.
 */
function inferPriority (dataDir, actFileFunc) {
  const signals = {}
  const projectKeywords = {
    'mention.ma': ['mention.ma', 'mention ma', 'geo platform', 'geo tracking', 'generative engine'],
    'inferencewatch': ['inferencewatch', 'inference watch', 'ai pricing', 'model pricing', 'ai procurement'],
    'covexy': ['covexy', 'proactive ai', 'screen observer', 'work graph', 'deterministic scorer']
  }

  for (let i = 0; i < PRIORITY_LOOKBACK_DAYS; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    const dateStr = d.toISOString().split('T')[0]
    try {
      const filePath = actFileFunc(dateStr)
      const dayData = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (!Array.isArray(dayData)) continue

      // Weight recent days more heavily: today = 3x, yesterday = 2x, 2 days ago = 1x
      const weight = PRIORITY_LOOKBACK_DAYS - i

      dayData.forEach(entry => {
        if (!entry.isWorkRelated) return
        const text = ((entry.description || '') + ' ' + (entry.topicDomain || '')).toLowerCase()
        Object.entries(projectKeywords).forEach(([project, keywords]) => {
          if (keywords.some(kw => text.includes(kw))) {
            signals[project] = (signals[project] || 0) + weight
          }
        })
      })
    } catch {
      // File might not exist for that day
    }
  }

  // Find project with highest signal
  const sorted = Object.entries(signals).sort((a, b) => b[1] - a[1])
  workGraph.currentPriority = sorted.length > 0 ? sorted[0][0] : null
  workGraph.projectSignals = signals

  return workGraph.currentPriority
}

/**
 * Build the initial Work Graph from all of today's activity data.
 * Called once at startup.
 */
function buildFromTodayActivity (todayActivity) {
  resetDailyStats()
  if (!Array.isArray(todayActivity)) return

  todayActivity.forEach(entry => {
    if (entry.activityType) {
      processActivity(entry)
    }
  })

  console.log('[Covexy] Work Graph built from', workGraph.todayStats.totalEntries, 'entries')
  console.log('[Covexy] Today: DEEP_WORK', workGraph.todayStats.deepWorkMinutes + 'min,',
    'RESEARCH', workGraph.todayStats.researchMinutes + 'min,',
    'COMMUNICATION', workGraph.todayStats.communicationMinutes + 'min,',
    'LEISURE', workGraph.todayStats.leisureMinutes + 'min')
}

/**
 * Generate the structured context package that the Analyst reads.
 * This replaces the raw prose activity log.
 */
function getAnalystContext () {
  const stats = workGraph.todayStats
  const totalWorkMinutes = stats.deepWorkMinutes + stats.researchMinutes + stats.communicationMinutes + stats.adminMinutes
  const deepWorkRatio = totalWorkMinutes > 0 ? Math.round((stats.deepWorkMinutes / totalWorkMinutes) * 100) : 0

  // Top 5 apps
  const topApps = Object.entries(workGraph.topApps)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([app, count]) => app)
    .join(', ')

  // Top 5 topics
  const topTopics = Object.entries(workGraph.topTopics)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => topic)
    .join(', ')

  // Unfinished sessions (last 3)
  const unfinished = workGraph.unfinishedSessions
    .slice(-3)
    .map(s => s.topic + ' (' + s.durationMinutes + ' min)')
    .join(', ')

  // Recent drift events (last 3)
  const drifts = workGraph.driftEvents
    .slice(-3)
    .map(d => d.from + ' -> ' + d.to + ' at ' + new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    .join(', ')

  // Current session
  const session = workGraph.currentSession
    ? 'Currently in ' + workGraph.currentSession.activityType + ' on ' + workGraph.currentSession.topic + ' (started ' + new Date(workGraph.currentSession.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')'
    : 'No active work session'

  return {
    currentPriority: workGraph.currentPriority || 'No clear priority detected',
    todaySummary: 'Deep work: ' + stats.deepWorkMinutes + 'min | Research: ' + stats.researchMinutes + 'min | Communication: ' + stats.communicationMinutes + 'min | Leisure: ' + stats.leisureMinutes + 'min',
    deepWorkRatio: deepWorkRatio + '% of work time is deep work',
    topApps: topApps || 'No app data yet',
    topTopics: topTopics || 'No topic data yet',
    currentSession: session,
    unfinishedWork: unfinished || 'Nothing unfinished detected',
    recentDrifts: drifts || 'No context switches detected',
    projectSignals: Object.entries(workGraph.projectSignals || {})
      .sort((a, b) => b[1] - a[1])
      .map(([p, s]) => p + ': ' + s)
      .join(', ') || 'No project signals yet'
  }
}

/**
 * Get the raw Work Graph data for debugging or display.
 */
function getWorkGraph () {
  return workGraph
}

/**
 * Get drift events for the toast notification system.
 */
function getRecentDrifts () {
  return workGraph.driftEvents.slice(-5)
}

/**
 * Get unfinished sessions for the Preparer.
 */
function getUnfinishedSessions () {
  return workGraph.unfinishedSessions.slice(-5)
}

/**
 * Check if user is currently in a deep work session.
 */
function isInDeepWork () {
  return workGraph.currentSession && workGraph.currentSession.activityType === 'DEEP_WORK'
}

/**
 * Get today's stats for the UI or briefing.
 */
function getTodayStats () {
  return workGraph.todayStats
}

module.exports = {
  processActivity,
  buildFromTodayActivity,
  inferPriority,
  getAnalystContext,
  getWorkGraph,
  getRecentDrifts,
  getUnfinishedSessions,
  isInDeepWork,
  getTodayStats,
  resetDailyStats
}
