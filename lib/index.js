/**
 * Host half of dsh-context-compressor.
 *
 * One job: turn a user-chosen ABSOLUTE context ceiling into automatic
 * compaction. DeepSeek Harness already compacts on its own, but its policy is
 * relative — a fraction of whatever context window the routed model declares
 * (`compaction-basic`, 80% by default). This plugin adds the absolute knob the
 * built-in policy cannot express: "never let one session grow past N tokens",
 * independent of which model is routed and independent of that model's window.
 *
 * How it hooks in
 * ---------------
 * The compaction stack is mounted inside the agent preset's isolated cordis
 * group, and the web bundle DISABLES the profile-root rows of the same names
 * (`@deepseek-ai/dsh-web-app`'s `cordis.patch.yml` turns off `compaction-basic`,
 * `command-compact`, and `tool-result-pruner`). Two consequences a plugin must
 * respect:
 *
 *   - A profile-root plugin cannot `inject: ['compaction']` — there is no such
 *     service on the host plane.
 *   - `agent.ctx.get('compaction')` does NOT work either. `agent.ctx` is a
 *     scope of the root `agent-loop` row, so its isolate key is the ROOT
 *     symbol, under which the disabled row published nothing.
 *
 * The registry that mounts each preset is the one handle that can look inside
 * its own isolated realm, and it publishes `serviceFor(agent, name)` for
 * exactly this purpose — `dsh-api-session-controller` resolves `skills` the
 * same way. So every hook below resolves its services per agent through
 * {@link serviceFor}, never at apply time.
 *
 * The token meter is the exception that proves the rule: it deliberately STAYS
 * on the host plane (its projection table is process-wide), so it resolves from
 * the plugin's own context.
 *
 * `agent/pre-step` is a scope-filtered waterfall; an untagged listener on any
 * context is admitted for every agent, which is exactly the seam a
 * profile-root plugin wants. It is also the only safe moment: the engine's
 * region compaction requires an OPEN turn, and `agent/pre-step` runs inside one.
 *
 * What it does, in order, once a session is over the ceiling
 * ---------------------------------------------------------
 *   1. Prune over-budget tool results (`toolResultPruner`), the cheap,
 *      lossless-ish reduction the built-in engine also tries first. If that
 *      alone drops the session under the ceiling, no summary is written.
 *   2. Otherwise summarize everything older than a verbatim `retainTokens`
 *      tail, never splitting an assistant tool-call / tool-result pair, by
 *      calling the public `compaction.compactRegion(start, end, agent)`.
 *   3. Repeat up to `maxRounds` times, stopping as soon as the session is
 *      under the ceiling or a round makes no further progress.
 *
 * Every failure is contained: a compaction that cannot run (busy lock, no
 * balanced range, a summarizer error) is logged and the turn continues. A
 * context ceiling is an optimization, never a reason to fail a turn.
 *
 * @module dsh-context-compressor
 */

import Schema from '@deepseek-ai/schemastery'

/** Stable plugin id; matches the cordis.patch.yml row name and the bundle id. */
export const name = 'dsh-context-compressor'

/**
 * Settings namespace this plugin's page edits. It is the profile patch row id
 * from `cordis.patch.yml`, which is also what `ctx.settings.describe()` and
 * `ctx.configForms.get()` address.
 */
export const SETTINGS_NS = 'context-compressor'

/** Route serving the live readout the settings page shows. */
const STATUS_PATH = '/dsh-context-compressor/status'

/**
 * Plugin configuration. Every field is `.volatile()`, which is what makes it
 * editable from the Settings page without restarting the plugin: the loader
 * parses a volatile-only config change and commits it into the running
 * references in place (`cordis-plugin-loader`'s `_commitVolatile`). Read them
 * with `.get()` at the moment of use — never cache the value.
 */
export const Config = Schema.object({
  /** Master switch. Off restores DSH's built-in relative policy untouched. */
  enabled: Schema.boolean().default(true).volatile(),
  /**
   * Absolute ceiling in estimated context tokens. `0` means "no ceiling":
   * the built-in relative threshold stays the only trigger.
   */
  contextLimit: Schema.number().step(1).min(0).default(0).volatile(),
  /**
   * How many of the most recent tokens stay verbatim after one compaction.
   * The summarized region is everything older than this tail.
   */
  retainTokens: Schema.number().step(1).min(0).default(16000).volatile(),
  /**
   * Consecutive reductions attempted in one step while still over the ceiling.
   * One reduction is usually enough; more covers a session that grew by
   * several large tool results at once.
   */
  maxRounds: Schema.number().step(1).min(1).max(10).default(3).volatile(),
})

/** How many recent sessions the status route reports. */
const STATUS_SESSIONS = 8

/** Per-session measurement ledger, most recent first. */
const ledger = new Map()

/** Most recent successful compaction, or null. */
let lastCompaction = null

/** Diagnostics from the most recent failed attempt, bounded. */
const recentErrors = []

/** Record one bounded diagnostic. */
function noteError(message) {
  recentErrors.unshift({ at: Date.now(), message: String(message) })
  if (recentErrors.length > 5) recentErrors.length = 5
}

/** Remember one measurement for the status readout. */
function noteMeasurement(sessionId, tokens, contextWindow, limit) {
  const previous = ledger.get(sessionId)
  ledger.set(sessionId, {
    sessionId: String(sessionId),
    tokens,
    contextWindow,
    limit,
    compactions: previous?.compactions ?? 0,
    at: Date.now(),
  })
  if (ledger.size <= STATUS_SESSIONS * 4) return
  const oldest = [...ledger.values()].sort((a, b) => a.at - b.at).slice(0, ledger.size - STATUS_SESSIONS * 2)
  for (const row of oldest) ledger.delete(row.sessionId)
}

/** Count how one surface event changes the in-progress tool-call count. */
function eventDelta(event) {
  if (event === undefined) return undefined
  if (event.type === 'assistant/message') {
    const content = event.data?.message?.content
    if (!Array.isArray(content)) return 0
    let count = 0
    for (const block of content) if (block !== null && typeof block === 'object' && block.type === 'tool-call') count += 1
    return count
  }
  if (event.type === 'tool/result') return -1
  return 0
}

/**
 * Whether the cut immediately before `surface[cutIndex]` leaves no unanswered
 * tool call crossing it.
 *
 * This mirrors `toolPairingBalancedBefore` from `@deepseek-ai/dsh-compaction`.
 * It is re-derived here rather than imported so this plugin keeps no runtime
 * dependency on a harness package whose module identity is owned by the app.
 * @param session - session owning the surface.
 * @param surface - current surface seqs.
 * @param cutIndex - position of the cut in `surface`.
 * @returns whether the cut is balanced.
 */
function balancedBefore(session, surface, cutIndex) {
  let pending = 0
  for (let index = 0; index < cutIndex; index += 1) {
    const delta = eventDelta(session.eventAt(surface[index]))
    if (delta === undefined) return false
    pending += delta
    if (pending < 0) return false
  }
  return pending === 0
}

/**
 * Choose the inclusive surface span one compaction should replace.
 *
 * Mirrors `selectCompactableRange` from `compaction-basic`: start at the first
 * non-system surface node, keep a verbatim tail priced at `retainTokens`, then
 * walk the cut back until no assistant tool call is left unanswered. Returns
 * `null` when there is nothing safe to compact — a single oversized retained
 * unit cannot be repaired by surface compaction.
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - token-meter measurement of that same surface.
 * @param retainTokens - minimum recent tail budget kept verbatim.
 * @returns the inclusive positional seq range, or `null`.
 */
function selectRange(session, measurement, retainTokens) {
  const priced = measurement.nodes
  if (!Array.isArray(priced) || priced.length === 0) return null
  const surface = session.surface.nodes
  if (!Array.isArray(surface) || surface.length !== priced.length) return null
  for (let index = 0; index < surface.length; index += 1) {
    if (surface[index] !== priced[index]?.seq) return null
  }
  const head = session.eventAt(surface[0])
  const firstIdx = head !== undefined && head.type === 'system/message' ? 1 : 0
  if (surface.length <= firstIdx + 1) return null
  let accumulated = 0
  let keepFromIdx = priced.length
  for (let index = priced.length - 1; index >= 0; index -= 1) {
    accumulated += Number(priced[index].tokens) || 0
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null
  while (keepFromIdx > firstIdx) {
    if (balancedBefore(session, surface, keepFromIdx)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  return { start: surface[firstIdx], end: surface[keepFromIdx - 1] }
}

/**
 * The routed model's context window for one session, when it has logged one.
 *
 * `TokenMeasurement.baseline` deliberately carries no window, so the readout
 * takes it from the `contextPressure` projection the token meter folds from
 * `request/context` events. Display-only: a composition without that projection
 * simply reports no window.
 * @param ctx - the plugin's own context.
 * @param session - session whose logged request context is read.
 * @returns the positive window, or `undefined`.
 */
function contextWindowOf(ctx, session) {
  try {
    const state = ctx.get?.('sessionProjections')?.stateOf?.(session, 'contextPressure')
    const window = Number(state?.contextWindow)
    return Number.isFinite(window) && window > 0 ? window : undefined
  } catch {
    return undefined
  }
}

/** Read a volatile config reference defensively. */
function readRef(ref, fallback) {
  if (ref === undefined || ref === null) return fallback
  const value = typeof ref.get === 'function' ? ref.get() : ref
  return value === undefined || value === null ? fallback : value
}

/**
 * Resolve one service for one agent.
 *
 * Prefers the agent's own preset realm through the registry that mounted it,
 * and falls back to the host plane (which is where the token meter lives, and
 * where a non-preset composition such as a headless profile mounts the whole
 * compaction stack directly).
 *
 * Every lookup is defensive: an unreadable registry must degrade to "no
 * service", never to a thrown turn.
 * @param ctx - the plugin's own context.
 * @param agent - the agent whose composition is queried.
 * @param name - cordis service name.
 * @returns the service, or `undefined` when this composition has none.
 */
function serviceFor(ctx, agent, name) {
  try {
    const scoped = ctx.get?.('agentPresets')?.serviceFor?.(agent, name)
    if (scoped !== undefined) return scoped
  } catch {
    // A preset registry that cannot answer leaves the host plane as the fallback.
  }
  try {
    return ctx.get?.(name) ?? agent.ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * Enforce the ceiling for one agent, once, at a step boundary.
 * @param ctx - plugin context, for logging.
 * @param agent - agent about to take a step.
 * @param config - resolved plugin config (volatile references).
 * @param signal - the turn's cancellation signal.
 */
async function enforceCeiling(ctx, agent, config, signal) {
  if (readRef(config.enabled, true) === false) return
  const limit = Math.floor(Number(readRef(config.contextLimit, 0)))
  if (!Number.isFinite(limit) || limit <= 0) return
  if (signal?.aborted === true) return
  if (agent.ctx === undefined) return
  const compaction = serviceFor(ctx, agent, 'compaction')
  const meter = serviceFor(ctx, agent, 'tokenMeter')
  if (compaction === undefined || meter === undefined) return
  const session = agent.session
  const sessionId = session?.id
  const rounds = Math.max(1, Math.min(10, Math.floor(Number(readRef(config.maxRounds, 3)))))
  const retain = Math.max(0, Math.floor(Number(readRef(config.retainTokens, 0))))

  /** Current measurement, or undefined when the meter cannot price the surface. */
  const measure = () => {
    try {
      return meter.measure(session)
    } catch (error) {
      noteError(`token measurement failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  let measurement = measure()
  if (measurement === undefined) return
  let tokens = Number(measurement.totalTokens) || 0
  const contextWindow = contextWindowOf(ctx, session)
  noteMeasurement(sessionId, tokens, contextWindow, limit)
  if (tokens < limit) return

  // Cheapest first: drop over-budget tool-result middles. When that alone gets
  // the session under the ceiling, no summary is written at all.
  // `PruneResult` is `{ pruned, charsRemoved }`.
  const pruner = serviceFor(ctx, agent, 'toolResultPruner')
  if (pruner !== undefined && typeof pruner.pruneSession === 'function') {
    try {
      const pruned = pruner.pruneSession(session)
      if ((Number(pruned?.charsRemoved) || 0) > 0) {
        measurement = measure()
        if (measurement === undefined) return
        tokens = Number(measurement.totalTokens) || 0
        noteMeasurement(sessionId, tokens, contextWindow, limit)
        if (tokens < limit) return
      }
    } catch (error) {
      noteError(`tool-result pruning failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (let round = 0; round < rounds; round += 1) {
    if (signal?.aborted === true) return
    const before = tokens
    let result
    try {
      const range = selectRange(session, measurement, retain)
      result = range === null
        // Nothing safe to cut at this retention: fall back to the engine's own
        // overflow recovery, which forces one useful balanced reduction.
        ? await compaction.compactIfNeeded(agent, 'context-overflow', signal)
        : await compaction.compactRegion(range.start, range.end, agent, signal)
    } catch (error) {
      noteError(`compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      if (ctx?.logger?.warn !== undefined) ctx.logger.warn(`context-compressor: ${error instanceof Error ? error.message : String(error)}; continuing the turn`)
      return
    }
    if (result === null || result === undefined) return
    const shadowed = Number(result.shadowedTokenCount) || 0
    measurement = measure()
    if (measurement === undefined) return
    tokens = Number(measurement.totalTokens) || 0
    const previous = ledger.get(sessionId)
    ledger.set(sessionId, {
      sessionId: String(sessionId),
      tokens,
      contextWindow,
      limit,
      compactions: (previous?.compactions ?? 0) + 1,
      at: Date.now(),
    })
    lastCompaction = {
      sessionId: String(sessionId),
      at: Date.now(),
      before,
      after: tokens,
      shadowedTokens: shadowed,
      shadowedNodes: Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0,
      limit,
    }
    if (tokens < limit) return
    if (tokens >= before) return
  }
}

// Exported for the host-half unit tests. Both are pure functions over a
// session and a measurement, so nothing here widens the plugin's contract.
export { balancedBefore, selectRange }

/** Whether a request may read this plugin's same-origin status route. */
function isTrustedRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    if (origin === 'null') return false
    try {
      if (new URL(origin).host !== hostUrl.host) return false
    } catch {
      return false
    }
  }
  const hostname = hostUrl.hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
}

/** Write one JSON response. */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Apply the plugin.
 * @param ctx - host context.
 * @param config - resolved plugin config with schema defaults filled.
 */
export function apply(ctx, config) {
  // The ceiling is enforced at a step boundary, which is the only point where
  // the surface is stable enough to select a balanced cut from.
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      await enforceCeiling(ctx, payload.agent, config, payload.signal)
    } catch (error) {
      noteError(`ceiling enforcement failed: ${error instanceof Error ? error.message : String(error)}`)
      if (ctx?.logger?.warn !== undefined) ctx.logger.warn(`context-compressor: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })

  // Live readout for the settings page: the browser half cannot measure a
  // session itself, and the numbers here are the ones the policy actually used.
  ctx.inject(['webServer'], (webServerCtx) => {
    ctx.effect(
      () =>
        webServerCtx.webServer.register({
          kind: 'exact',
          path: STATUS_PATH,
          handler: (req, res) => {
            if (!isTrustedRequest(req)) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            sendJson(res, 200, {
              ok: true,
              data: {
                enabled: readRef(config.enabled, true) !== false,
                contextLimit: Math.max(0, Math.floor(Number(readRef(config.contextLimit, 0))) || 0),
                retainTokens: Math.max(0, Math.floor(Number(readRef(config.retainTokens, 0))) || 0),
                maxRounds: Math.max(1, Math.floor(Number(readRef(config.maxRounds, 3))) || 3),
                sessions: [...ledger.values()].sort((a, b) => b.at - a.at).slice(0, STATUS_SESSIONS),
                lastCompaction,
                errors: recentErrors,
              },
            })
          },
        }),
      'dsh-context-compressor: status route',
    )
  })
}
