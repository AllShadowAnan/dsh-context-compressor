/**
 * Host-half unit tests for dsh-context-compressor.
 *
 * Everything here runs against fakes: the real `compaction` / `tokenMeter`
 * services live inside the agent preset's isolated cordis group and are only
 * reachable through a live agent, so the plugin's contract with them is
 * asserted here and the live wiring is asserted by booting a profile.
 *
 * Run: node --test test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import Schema from '@deepseek-ai/schemastery'
import { Config, SETTINGS_NS, apply, balancedBefore, selectRange } from '../lib/index.js'

/** Resolve a raw config the way cordis does before calling apply(). */
function resolve(raw) {
  const result = Config['~standard'].validate(raw)
  assert.equal(result.issues, undefined, `config rejected: ${JSON.stringify(result.issues)}`)
  return result.value
}

/** A surface event that answers `eventAt`. */
function assistantMessage(toolCalls) {
  return { type: 'assistant/message', data: { message: { content: Array.from({ length: toolCalls }, () => ({ type: 'tool-call' })) } } }
}

/**
 * Build a fake session over an event list; `surface` is every index by default.
 * The id is unique per call: the plugin keeps a bounded per-session ledger at
 * module scope, so sharing one id would leak counts between tests.
 */
let sessionCounter = 0
function fakeSession(events, surfaceIndexes = events.map((_, index) => index), id = `session-${++sessionCounter}`) {
  return {
    id,
    surface: { nodes: surfaceIndexes.map((index) => index + 1) },
    eventAt: (seq) => events[seq - 1],
  }
}

/** A token-meter fake whose measurement is derived from the session surface. */
function fakeMeter(prices, totalTokens, contextWindow) {
  return {
    measure: (session) => ({
      totalTokens,
      baseline: { contextWindow },
      nodes: session.surface.nodes.map((seq) => ({ seq, tokens: prices[seq - 1] ?? 0, heuristicTokens: 0 })),
    }),
  }
}

/** Capture every hook a fake context receives. */
function fakeCtx(rootServices = {}) {
  const hooks = new Map()
  const routes = []
  const ctx = {
    hooks,
    routes,
    effects: [],
    logger: { warn() {} },
    get: (name) => rootServices[name],
    on(name, callback) {
      hooks.set(name, callback)
      return () => hooks.delete(name)
    },
    inject(_names, callback) {
      return callback({ webServer: { register: (route) => { routes.push(route); return () => {} } } })
    },
    effect(factory) {
      const dispose = factory()
      ctx.effects.push(dispose)
      return dispose
    },
  }
  return ctx
}

/** Call a registered route's handler and decode its JSON body. */
function callRoute(route, { method = 'GET', host = '127.0.0.1:19387' } = {}) {
  let body
  route.handler({ method, headers: { host } }, { statusCode: 0, setHeader() {}, end: (text) => { body = text } })
  return JSON.parse(body)
}

/** A fake agent exposing the services the plugin resolves through `agent.ctx`. */
function fakeAgent(session, services) {
  return {
    session,
    ctx: { get: (name) => services[name] },
    runMaintenance: (operation) => operation(new AbortController().signal),
  }
}

/**
 * A fake agent whose scope cannot reach the compaction realm, as in the shipped
 * web composition: only the host-plane token meter resolves through `agent.ctx`.
 */
function fakePresetAgent(session, hostPlane) {
  return {
    session,
    ctx: { get: (name) => hostPlane[name] },
    runMaintenance: (operation) => operation(new AbortController().signal),
  }
}

test('config schema exposes every field as volatile and defaults are inert', () => {
  const resolved = resolve({})
  assert.equal(resolved.enabled.get(), true)
  assert.equal(resolved.contextLimit.get(), 0)
  assert.equal(resolved.retainTokens.get(), 16000)
  assert.equal(resolved.maxRounds.get(), 3)
  for (const field of ['enabled', 'contextLimit', 'retainTokens', 'maxRounds']) {
    assert.equal(Config.dict[field].meta.volatile, true, `${field} must be volatile so the settings page can write it live`)
  }
})

test('settings namespace is the profile patch row id', () => {
  assert.equal(SETTINGS_NS, 'context-compressor')
})

test('balancedBefore rejects a cut that leaves an assistant tool call unanswered', () => {
  const session = fakeSession([assistantMessage(1), { type: 'tool/result', data: {} }, assistantMessage(0)])
  const surface = session.surface.nodes
  assert.equal(balancedBefore(session, surface, 0), true)
  assert.equal(balancedBefore(session, surface, 1), false, 'cut between the call and its result')
  assert.equal(balancedBefore(session, surface, 2), true)
  assert.equal(balancedBefore(session, surface, 3), true)
})

test('selectRange keeps the retained tail and starts after a system head', () => {
  // system head, then four priced nodes of 10 tokens each
  const session = fakeSession([
    { type: 'system/message', data: {} },
    assistantMessage(0),
    assistantMessage(0),
    assistantMessage(0),
    assistantMessage(0),
  ])
  const measurement = {
    totalTokens: 40,
    baseline: { contextWindow: 1000 },
    nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 10, heuristicTokens: 0 })),
  }
  const range = selectRange(session, measurement, 20)
  assert.deepEqual(range, { start: 2, end: 3 }, 'system head (seq 1) is never inside the range; seqs 4-5 are retained')
})

test('selectRange returns null when the whole surface is the retained tail', () => {
  const session = fakeSession([assistantMessage(0), assistantMessage(0)])
  const measurement = {
    totalTokens: 20,
    baseline: { contextWindow: 1000 },
    nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 10, heuristicTokens: 0 })),
  }
  assert.equal(selectRange(session, measurement, 1000), null)
})

test('selectRange rejects a measurement that does not describe the current surface', () => {
  const session = fakeSession([assistantMessage(0), assistantMessage(0), assistantMessage(0)])
  const measurement = {
    totalTokens: 30,
    baseline: { contextWindow: 1000 },
    nodes: [{ seq: 1, tokens: 10 }, { seq: 9, tokens: 10 }, { seq: 3, tokens: 10 }],
  }
  assert.equal(selectRange(session, measurement, 0), null)
})

test('no compaction happens while the session is under the ceiling', async () => {
  const session = fakeSession([assistantMessage(0), assistantMessage(0), assistantMessage(0)])
  let compactions = 0
  const services = {
    tokenMeter: fakeMeter([10, 10, 10], 30, 1000),
    compaction: {
      compactRegion: () => { compactions += 1; return null },
      compactIfNeeded: () => { compactions += 1; return null },
    },
  }
  const ctx = fakeCtx()
  apply(ctx, resolve({ contextLimit: 100 }))
  await ctx.hooks.get('agent/pre-step')({ agent: fakeAgent(session, services), signal: new AbortController().signal }, () => {})
  assert.equal(compactions, 0)
})

test('a disabled ceiling never measures or compacts', async () => {
  const session = fakeSession([assistantMessage(0)])
  let measured = 0
  const services = {
    tokenMeter: { measure: () => { measured += 1; return { totalTokens: 9999, baseline: {}, nodes: [] } } },
    compaction: { compactRegion: () => null, compactIfNeeded: () => null },
  }
  const ctx = fakeCtx()
  apply(ctx, resolve({ enabled: false, contextLimit: 100 }))
  await ctx.hooks.get('agent/pre-step')({ agent: fakeAgent(session, services), signal: new AbortController().signal }, () => {})
  assert.equal(measured, 0)
})

test('crossing the ceiling compacts the region before the retained tail', async () => {
  const session = fakeSession([
    { type: 'system/message', data: {} },
    assistantMessage(0),
    assistantMessage(0),
    assistantMessage(0),
    assistantMessage(0),
  ])
  const calls = []
  let tokens = 400
  const services = {
    tokenMeter: {
      measure: (s) => ({
        totalTokens: tokens,
        baseline: { contextWindow: 1000 },
        nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 100, heuristicTokens: 0 })),
      }),
    },
    compaction: {
      compactRegion(start, end, agent, signal) {
        calls.push({ kind: 'region', start, end, signal })
        tokens = 40
        return { shadowedTokenCount: 360, shadowedSeqs: [2, 3, 4] }
      },
      compactIfNeeded() {
        calls.push({ kind: 'overflow' })
        return null
      },
    },
  }
  const ctx = fakeCtx()
  apply(ctx, resolve({ contextLimit: 200, retainTokens: 200 }))
  const signal = new AbortController().signal
  await ctx.hooks.get('agent/pre-step')({ agent: fakeAgent(session, services), signal }, () => {})

  assert.equal(calls.length, 1, 'one reduction is enough')
  assert.equal(calls[0].kind, 'region')
  assert.equal(calls[0].start, 2, 'the system head is never compacted')
  assert.equal(calls[0].end, 3)
  assert.equal(calls[0].signal, signal, 'the turn signal is forwarded')
})

test('a session that cannot be reduced stops after one round instead of looping', async () => {
  const session = fakeSession([assistantMessage(0), assistantMessage(0), assistantMessage(0)])
  let rounds = 0
  const services = {
    tokenMeter: {
      measure: (s) => ({
        totalTokens: 500,
        baseline: { contextWindow: 1000 },
        nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 100, heuristicTokens: 0 })),
      }),
    },
    compaction: {
      compactRegion() {
        rounds += 1
        return { shadowedTokenCount: 0, shadowedSeqs: [] }
      },
      compactIfNeeded: () => null,
    },
  }
  const ctx = fakeCtx()
  apply(ctx, resolve({ contextLimit: 200, retainTokens: 0, maxRounds: 5 }))
  await ctx.hooks.get('agent/pre-step')({ agent: fakeAgent(session, services), signal: new AbortController().signal }, () => {})
  assert.equal(rounds, 1, 'no progress means no retry')
})

test('a compaction failure is contained and the step still proceeds', async () => {
  const session = fakeSession([assistantMessage(0), assistantMessage(0), assistantMessage(0)])
  const services = {
    tokenMeter: {
      measure: (s) => ({
        totalTokens: 500,
        baseline: { contextWindow: 1000 },
        nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 100, heuristicTokens: 0 })),
      }),
    },
    compaction: {
      compactRegion() { throw new Error('busy') },
      compactIfNeeded() { throw new Error('busy') },
    },
  }
  const ctx = fakeCtx()
  apply(ctx, resolve({ contextLimit: 200 }))
  let proceeded = false
  await ctx.hooks.get('agent/pre-step')(
    { agent: fakeAgent(session, services), signal: new AbortController().signal },
    () => { proceeded = true },
  )
  assert.equal(proceeded, true)
})

test('a missing compaction service is inert, not fatal', async () => {
  const session = fakeSession([assistantMessage(0)])
  const ctx = fakeCtx()
  apply(ctx, resolve({ contextLimit: 1 }))
  let proceeded = false
  await ctx.hooks.get('agent/pre-step')(
    { agent: fakeAgent(session, { tokenMeter: fakeMeter([0], 10, 100) }), signal: new AbortController().signal },
    () => { proceeded = true },
  )
  assert.equal(proceeded, true)
})

test('tool-result pruning that clears the ceiling skips summarization entirely', async () => {
  const session = fakeSession([assistantMessage(0), assistantMessage(0), assistantMessage(0)])
  let tokens = 500
  let prunes = 0
  let compactions = 0
  const services = {
    tokenMeter: {
      measure: (s) => ({
        totalTokens: tokens,
        baseline: { contextWindow: 1000 },
        nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 100, heuristicTokens: 0 })),
      }),
    },
    compaction: { compactRegion: () => { compactions += 1; return null }, compactIfNeeded: () => { compactions += 1; return null } },
    toolResultPruner: {
      pruneSession() {
        prunes += 1
        tokens = 100
        // PruneResult is `{ pruned, charsRemoved }`.
        return { pruned: [], charsRemoved: 4000 }
      },
    },
  }
  const ctx = fakeCtx()
  apply(ctx, resolve({ contextLimit: 200 }))
  await ctx.hooks.get('agent/pre-step')({ agent: fakeAgent(session, services), signal: new AbortController().signal }, () => {})
  assert.equal(prunes, 1)
  assert.equal(compactions, 0, 'pruning alone got the session under the ceiling')
})

test('the status readout reports the logged context window from the projection', async () => {
  const session = fakeSession([assistantMessage(0), assistantMessage(0)], undefined, 'session-readout')
  const services = {
    tokenMeter: fakeMeter([10, 10], 20, undefined),
    compaction: { compactRegion: () => null, compactIfNeeded: () => null },
  }
  // `TokenMeasurement.baseline` carries no window, so the readout must take it
  // from the `contextPressure` projection instead.
  const ctx = fakeCtx({
    sessionProjections: { stateOf: (s, key) => (key === 'contextPressure' ? { contextWindow: 128000 } : undefined) },
  })
  apply(ctx, resolve({ contextLimit: 100 }))
  await ctx.hooks.get('agent/pre-step')({ agent: fakeAgent(session, services), signal: new AbortController().signal }, () => {})

  const payload = callRoute(ctx.routes[0])
  assert.equal(payload.ok, true)
  assert.equal(payload.data.contextLimit, 100)
  // The ledger is module-scope and shared with earlier tests, so address the row
  // this test produced rather than the whole list.
  const row = payload.data.sessions.find((entry) => entry.sessionId === 'session-readout')
  assert.notEqual(row, undefined)
  assert.equal(row.tokens, 20)
  assert.equal(row.contextWindow, 128000)
  assert.equal(row.compactions, 0)
})

test('the status route refuses a cross-site caller', () => {
  const ctx = fakeCtx()
  apply(ctx, resolve({ contextLimit: 1 }))
  let body
  ctx.routes[0].handler({ method: 'GET', headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }, { setHeader() {}, end: (text) => { body = text } })
  assert.equal(JSON.parse(body).ok, false)
})

test('the compaction realm is reached through the preset registry, not agent.ctx', async () => {
  const session = fakeSession([
    { type: 'system/message', data: {} },
    assistantMessage(0),
    assistantMessage(0),
    assistantMessage(0),
    assistantMessage(0),
  ])
  const calls = []
  let tokens = 400
  const engine = {
    compactRegion(start, end, agent, signal) {
      calls.push({ kind: 'region', start, end, signal })
      tokens = 40
      return { shadowedTokenCount: 360, shadowedSeqs: [2, 3, 4] }
    },
    compactIfNeeded() { calls.push({ kind: 'overflow' }); return null },
  }
  // The shipped web composition: the root rows are disabled, so only the preset
  // realm has an engine, and only the token meter sits on the host plane.
  const presets = { serviceFor: (agent, name) => (name === 'compaction' ? engine : undefined) }
  const ctx = fakeCtx({ tokenMeter: fakeMeter([100, 100, 100, 100, 100], 400, 1000), agentPresets: presets })
  const agent = fakePresetAgent(session, { tokenMeter: fakeMeter([100, 100, 100, 100, 100], 400, 1000) })
  apply(ctx, resolve({ contextLimit: 200, retainTokens: 200 }))
  await ctx.hooks.get('agent/pre-step')({ agent, signal: new AbortController().signal }, () => {})

  assert.equal(calls.length, 1, 'the preset-realm engine performed the reduction')
  assert.equal(calls[0].kind, 'region')
  assert.equal(calls[0].start, 2)
})

test('an unreachable preset registry falls back to the host plane', async () => {
  const session = fakeSession([assistantMessage(0), assistantMessage(0), assistantMessage(0)])
  let compactions = 0
  const services = {
    tokenMeter: fakeMeter([100, 100, 100], 500, 1000),
    compaction: { compactRegion: () => { compactions += 1; return { shadowedTokenCount: 1, shadowedSeqs: [] } }, compactIfNeeded: () => null },
  }
  const ctx = fakeCtx({
    agentPresets: { serviceFor() { throw new Error('registry unavailable') } },
    ...services,
  })
  apply(ctx, resolve({ contextLimit: 200, retainTokens: 0 }))
  let proceeded = false
  await ctx.hooks.get('agent/pre-step')(
    { agent: fakeAgent(session, services), signal: new AbortController().signal },
    () => { proceeded = true },
  )
  assert.equal(compactions, 1, 'the host-plane engine still ran')
  assert.equal(proceeded, true)
})

test('the status route is registered exactly once on the injected web server', () => {
  const routes = []
  const ctx = {
    logger: { warn() {} },
    on() { return () => {} },
    effect(factory) { factory(); return () => {} },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      return callback({ webServer: { register: (route) => { routes.push(route); return () => {} } } })
    },
  }
  apply(ctx, resolve({ contextLimit: 1234 }))
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/dsh-context-compressor/status')
  assert.equal(routes[0].kind, 'exact')
})

test('Schema is a real schemastery schema (the settings form needs toJSON)', () => {
  assert.equal(typeof Config.toJSON, 'function')
  assert.equal(Config['~standard'].vendor, 'schemastery')
  assert.ok(Schema !== undefined)
})
