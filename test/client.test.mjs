/**
 * Client-half tests for dsh-context-compressor.
 *
 * The browser bundle is the half that cannot be exercised by importing it: it
 * is an IIFE that talks to DSH's `window.__ModuleLoader__` and resolves
 * everything through the module loader's `require`. This file supplies the two
 * platform seeds the bundle actually asks for — the REAL React, and a faithful
 * stand-in for `@deepseek-ai/dsh-client-ui-primitives` built to the contracts
 * verified in the shipped bundle — then:
 *
 *   1. captures the factory registration and asserts its id and exports,
 *   2. runs `apply(ctx)` against a fake client context and asserts the exact
 *      slot registration (the settings page) and locale dictionaries,
 *   3. renders the section component with real React and asserts the whole
 *      surface renders, that every `t()` key resolves in BOTH dictionaries, and
 *      that the staged form drives the switch and the numeric fields.
 *
 * Run: node --test test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** The bundle's source, read as text so each test can re-register it. */
const BUNDLE_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const BUNDLE_SOURCE = readFileSync(BUNDLE_PATH, 'utf8')

/** The plugin's package name; the loader keys the bundle registration by it. */
const PACKAGE_NAME = 'dsh-context-compressor'

/** Settings namespace, matching cordis.patch.yml's row id. */
const SETTINGS_NS = 'context-compressor'

/** Dictionary namespace the page registers under. */
const LOCALE_NS = 'settings.contextCompressor'

// ---------------------------------------------------------------------------
// The primitives stand-in, written to the verified contracts.
// ---------------------------------------------------------------------------

/** The real `settingsNumberField` (verified shape: `{field, format, parse}`). */
function settingsNumberField(field) {
  return {
    field,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/** A snapshot store, as `SettingsFormModel.bind` returns. */
function createStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** The real `SettingsFormModel` contract, reduced to what the page uses. */
class SettingsFormModel {
  constructor(scope, specs) {
    this.scope = scope
    this.specs = new Map(specs.map((spec) => [spec.field, spec]))
    this.staged = new Map()
    this.listeners = new Set()
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  bind(project) {
    const store = createStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  shell() {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      invalid: false,
      saving: false,
      failed: false,
    }
  }

  field(field) {
    const spec = this.specs.get(field)
    const staged = this.staged.get(field)
    const snapshot = this.scope.getSnapshot()
    if (staged === undefined) {
      return { text: spec.format(snapshot.value?.[field]), overridden: Object.hasOwn(snapshot.user ?? {}, field), invalid: false }
    }
    return { text: staged, overridden: true, invalid: spec.parse(staged) === undefined }
  }

  actions() {
    return {
      edit: (field, text) => { this.staged.set(field, text); this.publish() },
      resetField: (field) => { this.staged.delete(field); this.publish() },
      save: () => { this.saved = true },
      discard: () => { this.staged.clear(); this.publish() },
    }
  }

  dispose() { this.unsubscribe() }
  publish() { for (const listener of [...this.listeners]) listener() }
}

/** `SettingsForm` — renders its children, or the unavailable line. */
function SettingsForm(props) {
  if (!props.state.available) return React.createElement('p', null, props.labels.unavailable)
  return React.createElement(
    'div',
    null,
    props.children,
    React.createElement('button', { type: 'button', disabled: !props.state.dirty, onClick: props.onSave }, props.state.saving ? props.labels.saving : props.labels.save),
  )
}

/** `SettingsValueField` — label, staged text, overridden badge and reset. */
function SettingsValueField(props) {
  return React.createElement(
    'div',
    null,
    React.createElement('label', { htmlFor: props.id }, props.label),
    props.overridden ? React.createElement('span', null, props.overriddenLabel) : null,
    props.overridden ? React.createElement('button', { type: 'button', disabled: props.disabled, onClick: props.onReset }, props.resetLabel) : null,
    React.createElement('input', { id: props.id, type: 'text', value: props.text, disabled: props.disabled, onChange: (event) => { props.onEdit(event.target.value) } }),
    props.invalid ? React.createElement('p', null, props.invalidLabel) : null,
    props.hint !== undefined ? React.createElement('p', null, props.hint) : null,
  )
}

/** `Switch` — a controlled `role="switch"` button. */
function Switch(props) {
  return React.createElement(
    'button',
    { type: 'button', role: 'switch', 'aria-checked': props.checked, 'aria-label': props.label, disabled: props.disabled, onClick: () => { props.onChange(!props.checked) } },
    'switch',
  )
}

/** `SegmentedControl` — a `role="tablist"` of `role="tab"` buttons. */
function SegmentedControl(props) {
  return React.createElement(
    'div',
    { role: 'tablist', 'aria-label': props.label, className: props.className },
    props.options.map((option) =>
      React.createElement(
        'button',
        {
          key: option.value,
          id: `${props.id}-${option.value}`,
          type: 'button',
          role: 'tab',
          'aria-selected': option.value === props.value,
          disabled: props.disabled || option.disabled === true,
          onClick: () => { if (option.value !== props.value) props.onChange(option.value) },
        },
        option.label,
      ),
    ),
  )
}

const PRIMITIVES = { SegmentedControl, SettingsForm, SettingsFormModel, SettingsValueField, settingsNumberField, Switch }

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * The browser globals the bundle touches: the module-loader registration queue
 * and the `<style>` host. They stay installed for the whole file because
 * `apply()` injects a stylesheet, not only because evaluating the bundle
 * registers a factory.
 */
const styleHost = { styles: [] }
globalThis.window = { __ModuleLoader__: { load() {} } }
globalThis.document = {
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
  head: { appendChild: (node) => styleHost.styles.push(node) },
}

/** Evaluate the bundle exactly as the browser would and return its registration. */
function loadBundle() {
  let registration
  const queue = globalThis.window.__ModuleLoader__
  const previousLoad = queue.load
  queue.load = (value) => { registration = value }
  styleHost.styles = []
  try {
    // eslint-disable-next-line no-new-func -- the bundle is an IIFE, evaluated exactly as the browser would
    new Function(BUNDLE_SOURCE)()
  } finally {
    queue.load = previousLoad
  }
  assert.notEqual(registration, undefined, 'the bundle did not call window.__ModuleLoader__.load')
  return { registration, styles: styleHost.styles }
}

/** The `require` the loader would hand the factory. */
function makeRequire() {
  return (specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return PRIMITIVES
    throw new Error(`unexpected require(${specifier}) — not a platform seed word`)
  }
}

/** A fake `ctx.configForms` scope over one section. */
function fakeScope(section, user = {}) {
  const listeners = new Set()
  const snapshot = { status: 'ready', writable: true, value: section, base: section, user, revision: 3, mode: 'host' }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    mutate: async () => true,
  }
}

/** A fake client context capturing every registration `apply` makes. */
function fakeClientCtx() {
  const locales = []
  const sections = []
  const effects = []
  const ctx = {
    locales,
    sections,
    effects,
    locale: {
      register: (ns, dictionaries) => { locales.push({ ns, dictionaries }); return () => {} },
      bind: (ns) => (key, params) => {
        const dictionaries = locales.find((entry) => entry.ns === ns)?.dictionaries
        const text = dictionaries?.zh?.[key] ?? dictionaries?.en?.[key]
        if (text === undefined) throw new Error(`missing translation key "${key}" in ${ns}`)
        return params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      },
    },
    configForms: {
      get: (ns) => {
        ctx.requestedNamespace = ns
        return fakeScope({ enabled: true, mode: 'absolute', contextLimit: 90000, contextRatioPercent: 80, retainTokens: 16000, maxRounds: 3 })
      },
    },
    slots: {
      inject: (name, register) => { ctx.injectedSlot = name; return register() },
      register: (options, component) => { sections.push({ options, component }); return () => {} },
    },
    effect: (factory) => { const dispose = factory(); effects.push(dispose); return dispose },
  }
  return ctx
}

/** Build the props the renderer would hand a `settings.section` component. */
function sectionProps(ctx, t) {
  const { options } = ctx.sections[0]
  const face = options.inject()
  const store = face.hooks.contextCompressor
  return {
    ...face,
    t,
    close: () => {},
    useContextCompressor: (selector) =>
      React.useSyncExternalStore(
        (listener) => store.subscribe(listener),
        () => selector(store.getSnapshot()),
        () => selector(store.getSnapshot()),
      ),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Apply the plugin once and hand back a renderer that re-reads the live form,
 * so a staged edit can be observed by rendering again.
 */
function mountAndRender() {
  const { registration } = loadBundle()
  const plugin = registration.factory(makeRequire())
  const ctx = fakeClientCtx()
  plugin.apply(ctx)
  const { options, component } = ctx.sections[0]
  const t = ctx.locale.bind(options.locale)
  return {
    ctx,
    t,
    /** Render the page against the form's current staged state. */
    render() {
      const props = sectionProps(ctx, t)
      return { props, html: renderToStaticMarkup(React.createElement(component, props)) }
    },
    /** The staged field state a save would write. */
    store: () => ctx.sections[0].options.inject().hooks.contextCompressor.getSnapshot(),
  }
}

test('the bundle registers under the package name and exports a cordis plugin', () => {
  const { registration } = loadBundle()
  assert.equal(registration.id, PACKAGE_NAME, 'the loader keys the registration by the package name')
  const plugin = registration.factory(makeRequire())
  assert.equal(plugin.name, PACKAGE_NAME)
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms'])
  assert.equal(plugin.SETTINGS_NS, SETTINGS_NS)
})

test('the bundle requires only platform seed words', () => {
  const { registration } = loadBundle()
  const seen = []
  registration.factory((specifier) => {
    seen.push(specifier)
    return makeRequire()(specifier)
  })
  assert.deepEqual([...new Set(seen)].sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
})

test('apply registers exactly one settings page under the plugin namespace', () => {
  const { registration } = loadBundle()
  const plugin = registration.factory(makeRequire())
  const ctx = fakeClientCtx()
  plugin.apply(ctx)

  assert.equal(ctx.injectedSlot, 'settings.section', 'the page takes the additive whole-page seat')
  assert.equal(ctx.sections.length, 1)
  const { options, component } = ctx.sections[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, SETTINGS_NS, 'the section id is the settings namespace')
  assert.equal(typeof options.label, 'function', 'the nav label is a thunk so it follows the locale')
  assert.equal(typeof options.inject, 'function')
  assert.equal(typeof component, 'function')
  assert.equal(ctx.requestedNamespace, SETTINGS_NS, 'the form binds to the plugin namespace, not the package name')
})

test('the page label is localized through the registered dictionaries', () => {
  const { registration } = loadBundle()
  const plugin = registration.factory(makeRequire())
  const ctx = fakeClientCtx()
  plugin.apply(ctx)
  const { options } = ctx.sections[0]
  assert.equal(options.locale, LOCALE_NS)
  assert.equal(ctx.locales[0].ns, LOCALE_NS)
  assert.equal(options.label(), '上下文压缩')
})

test('the section renders every control with no missing translation key', () => {
  const { t, render } = mountAndRender()
  const { html } = render()

  assert.match(html, /role="switch"/, 'the enable toggle renders')
  assert.match(html, /aria-checked="true"/, 'the toggle reflects the served config')
  assert.match(html, /role="tablist"/, 'the two-way trigger choice renders')
  assert.match(html, /id="cc-mode-absolute"/)
  assert.match(html, /id="cc-mode-ratio"/)
  assert.match(html, /id="cc-limit"/)
  assert.match(html, /id="cc-retain"/)
  assert.match(html, /id="cc-rounds"/)
  assert.match(html, /90000/, 'the served ceiling is shown')
  assert.ok(html.includes(t('statusTitle')), 'the live readout panel renders')
})

test('the trigger is a two-way choice and only its own field is rendered', () => {
  const { render, store } = mountAndRender()
  const absolute = render()

  assert.equal(store().mode.text, 'absolute')
  assert.match(absolute.html, /aria-selected="true"[^>]*>绝对上限/, 'the served mode is the selected tab')
  assert.match(absolute.html, /id="cc-limit"/, 'absolute mode renders the token ceiling')
  assert.doesNotMatch(absolute.html, /id="cc-ratio"/, 'and not the ratio field')

  // Exactly what the segmented control's onChange does.
  absolute.props.edit('mode', 'ratio')
  assert.equal(store().mode.text, 'ratio')
  assert.equal(store().mode.overridden, true, 'a staged change is marked as an override')

  const ratio = render()
  assert.match(ratio.html, /aria-selected="true"[^>]*>按窗口比例/)
  assert.match(ratio.html, /id="cc-ratio"/, 'ratio mode renders the percentage field')
  assert.doesNotMatch(ratio.html, /id="cc-limit"/, 'and hides the absolute one')
})

test('switching modes leaves the other trigger’s value untouched', () => {
  const { render, store } = mountAndRender()
  render().props.edit('mode', 'ratio')
  render().props.edit('mode', 'absolute')
  const back = render()

  assert.match(back.html, /id="cc-limit"/)
  assert.match(back.html, /90000/, 'the absolute ceiling was never rewritten by the switch')
  assert.equal(store().mode.text, 'absolute')
})

test('an unavailable namespace renders the unavailable notice instead of controls', () => {
  const { registration } = loadBundle()
  const plugin = registration.factory(makeRequire())
  const ctx = fakeClientCtx()
  ctx.configForms.get = () => ({
    getSnapshot: () => ({ status: 'unavailable', writable: false, mode: 'memory' }),
    subscribe: () => () => {},
    mutate: async () => false,
  })
  plugin.apply(ctx)
  const { options, component } = ctx.sections[0]
  const t = ctx.locale.bind(options.locale)
  const html = renderToStaticMarkup(React.createElement(component, sectionProps(ctx, t)))
  assert.ok(html.includes(t('unavailable')), 'the notice the host-missing case shows')
  assert.doesNotMatch(html, /role="switch"/)
})

test('both dictionaries define exactly the same keys', () => {
  const { registration } = loadBundle()
  const plugin = registration.factory(makeRequire())
  const ctx = fakeClientCtx()
  plugin.apply(ctx)
  const { zh, en } = ctx.locales[0].dictionaries
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('the plugin installs one stylesheet and disposes every effect', () => {
  const { registration, styles } = loadBundle()
  const plugin = registration.factory(makeRequire())
  const ctx = fakeClientCtx()
  plugin.apply(ctx)
  assert.equal(styles.length, 1, 'one stylesheet is appended')
  assert.equal(styles[0].dataset.pluginStyles, PACKAGE_NAME)
  assert.equal(ctx.effects.length, 4, 'dictionaries, stylesheet, form subscription, page registration')
  for (const dispose of ctx.effects) {
    assert.equal(typeof dispose, 'function', 'every effect must hand cordis a disposer')
    dispose()
  }
})
