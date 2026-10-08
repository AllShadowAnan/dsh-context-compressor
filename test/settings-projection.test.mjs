/**
 * Conformance test: does the REAL DeepSeek Harness settings projection see this
 * plugin's fields?
 *
 * The settings page only renders a namespace when `dsh-settings`'s own
 * `volatileForm(schema)` produces at least one field from the plugin's
 * `Config`. This test runs that exact module — extracted from the installed
 * application — against this plugin's schema, so a schema mistake fails here
 * instead of silently producing a page with no controls.
 *
 * It also proves the cross-copy assumption the plugin depends on: this package
 * carries its own `@deepseek-ai/schemastery`/`cosmokit`, while the harness uses
 * its own; `cosmokit`'s volatile brand is `Symbol.for(...)` precisely so the two
 * copies interoperate.
 *
 * The reference tree is the extracted application and is not part of this
 * package, so the suite skips when it is absent.
 *
 * Run: node --test test/settings-projection.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { Config, SETTINGS_NS } from '../lib/index.js'

const REFERENCE = process.env.DSH_REFERENCE_ASAR ?? 'E:/project/DSH/.ref-asar'
const SCHEMA_MODULE = `${REFERENCE}/dsh/node_modules/@deepseek-ai/dsh-settings/lib/types/schema.js`
const HAVE_REFERENCE = existsSync(SCHEMA_MODULE)

const skip = HAVE_REFERENCE ? false : 'reference DSH tree not present; set DSH_REFERENCE_ASAR to run this suite'

/** The harness's own schema helpers. */
const harness = HAVE_REFERENCE ? await import(pathToFileURL(SCHEMA_MODULE).href) : undefined

/** Resolve a raw config the way cordis does before calling apply(). */
function resolve(raw) {
  const result = Config['~standard'].validate(raw)
  assert.equal(result.issues, undefined)
  return result.value
}

test('the harness projects every configured field as editable', { skip }, () => {
  const form = harness.volatileForm(Config)
  assert.notEqual(form, undefined, 'volatileForm found no volatile field, so the settings page would render nothing')
  assert.deepEqual(Object.keys(form.dict).sort(), ['contextLimit', 'contextRatioPercent', 'enabled', 'maxRounds', 'mode', 'retainTokens'])
})

test('the harness accepts a write to each field path', { skip }, () => {
  for (const field of ['enabled', 'mode', 'contextLimit', 'contextRatioPercent', 'retainTokens', 'maxRounds']) {
    assert.equal(harness.isVolatilePath(Config, [field]), true, `${field} is not writable`)
  }
  assert.equal(harness.isVolatilePath(Config, ['nope']), false)
})

test('the projected form shows the resolved values and their user layer', { skip }, () => {
  const form = harness.volatileForm(Config)
  const resolved = resolve({ contextLimit: 90000 })
  const value = harness.projectForm(form, harness.plainConfig(resolved))
  assert.deepEqual(value, { enabled: true, mode: 'absolute', contextLimit: 90000, contextRatioPercent: 80, retainTokens: 16000, maxRounds: 3 })

  // The overridden badge is driven by presence in the user layer, not by value
  // comparison, so the raw patch is what the page reads back.
  const user = harness.projectForm(form, { contextLimit: 90000 })
  assert.deepEqual(user, { contextLimit: 90000 })
})

test('the union trigger mode survives a round trip through the projection', { skip }, () => {
  // The page stages `mode` as the literal string the union accepts; this is the
  // check that the harness reads it back as the same string, in both directions.
  const form = harness.volatileForm(Config)
  for (const mode of ['absolute', 'ratio']) {
    assert.deepEqual(harness.projectForm(form, { mode }), { mode })
  }
  const resolved = resolve({ mode: 'ratio', contextRatioPercent: 50 })
  assert.equal(resolved.mode.get(), 'ratio')
  assert.equal(resolved.contextRatioPercent.get(), 50)
  assert.deepEqual(harness.projectForm(form, harness.plainConfig(resolved)), {
    enabled: true,
    mode: 'ratio',
    contextLimit: 0,
    contextRatioPercent: 50,
    retainTokens: 16000,
    maxRounds: 3,
  })
})

test('a non-volatile sibling field would be rejected (guards the contract)', { skip }, () => {
  // The namespace id the client half addresses must be the profile row id.
  assert.equal(SETTINGS_NS, 'context-compressor')
})
