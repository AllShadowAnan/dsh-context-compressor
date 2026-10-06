/**
 * Browser half of dsh-context-compressor.
 *
 * Registers ONE dedicated page in the Settings surface — the `settings.section`
 * list slot, which is the additive seat for "a whole page of your own" (as
 * opposed to `settings.general.item`, one row inside General). The page edits
 * this plugin's OWN profile entry config, addressed by its cordis.patch.yml row
 * id, through the shell's shared `ctx.configForms` form.
 *
 * Why a form model instead of direct writes: a settings write is a durable,
 * revision-fenced document mutation, so a control that committed as it settled
 * would turn one keystroke into a write the user never asked for. The staged
 * model shows exactly what a save would store.
 *
 * Why the page can be trusted to reflect reality: the live numbers (per-session
 * estimated tokens, the ceiling in force, the last compaction) come from the
 * host half's same-origin status route — the browser cannot measure a session
 * itself.
 *
 * This file is a hand-written bundle: no build step. DSH's client module loader
 * hands the factory a `require` that resolves platform seeds (`react`,
 * `@deepseek-ai/dsh-client-ui-primitives`, …) and other installed plugin
 * bundles by package id, so nothing needs bundling.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-compressor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Stable plugin id; matches the host half and the bundle id. */
    const PLUGIN_ID = 'dsh-context-compressor'

    /** Settings namespace = the plugin's profile patch row id. */
    const SETTINGS_NS = 'context-compressor'

    /** Same-origin readout served by the host half. */
    const STATUS_PATH = '/dsh-context-compressor/status'

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.contextCompressor'

    /** How often the readout refreshes while the page is mounted. */
    const STATUS_POLL_MS = 5000

    /** English copy. */
    const en = {
      nav: 'Context compression',
      title: 'Context compression',
      description:
        'Set an absolute ceiling on how many context tokens one session may reach. Once a session crosses it, the harness compacts the conversation automatically — regardless of which model is routed or how large that model’s context window is.',
      howItWorks:
        'On every step the session is measured. Over-budget tool results are shortened first; if that is not enough, everything older than the retained tail is replaced by one summary. Nothing runs while the session is under the ceiling.',
      enabled: 'Enable the absolute ceiling',
      enabledHint: 'Off leaves DeepSeek Harness’s built-in relative policy as the only trigger.',
      limit: 'Context ceiling (tokens)',
      limitHint: '0 disables the ceiling. This is an estimate of the request image, in tokens.',
      retain: 'Keep the most recent (tokens)',
      retainHint: 'This tail stays verbatim; everything older than it may be summarized.',
      rounds: 'Reductions per step',
      roundsHint: 'How many times one step may reduce the context before giving up for that step.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'The host half is not loaded, so it cannot be configured right now.',
      statusTitle: 'Live readout',
      statusOff: 'The ceiling is off — only the built-in policy is active.',
      statusIdle: 'No session has been measured yet. The first measurement lands on the next step of a session.',
      statusLimit: 'Ceiling in force',
      statusRetain: 'Retained tail',
      statusRounds: 'Reductions per step',
      statusSessions: 'Recently measured sessions',
      statusTokens: 'tokens',
      statusWindow: 'window',
      statusCompactions: 'compactions',
      statusLast: 'Last compaction',
      statusLastDetail: '{before} → {after} tokens, {nodes} nodes summarized',
      statusNone: 'none yet',
      statusErrors: 'Recent problems',
      statusUnreachable: 'The host readout is unreachable.',
      tokens: 'tokens',
    }

    /** Simplified Chinese copy. */
    const zh = {
      nav: '上下文压缩',
      title: '上下文压缩',
      description:
        '为一个会话设定绝对的上文 token 上限。一旦达到该上限，Harness 会自动压缩对话——与当前路由到哪个模型、该模型上下文窗口多大都无关。',
      howItWorks:
        '每一步开始前都会测量当前会话：先截短超预算的工具结果；如果仍然超出，则把「保留区」之前的历史替换为一条摘要。未达到上限时不会做任何事。',
      enabled: '启用绝对上限',
      enabledHint: '关闭后，仅由 DeepSeek Harness 内置的相对阈值策略触发压缩。',
      limit: '上下文上限（token）',
      limitHint: '0 表示不启用上限。此处为请求上下文的估算 token 数。',
      retain: '保留最近（token）',
      retainHint: '这段尾部保持原文不变；比它更早的历史可能被压缩为摘要。',
      rounds: '单步最多压缩次数',
      roundsHint: '同一步内最多尝试压缩多少次，超过则本步放弃。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填数字；留空表示使用默认值。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      readOnly: '本部署的设置为只读。',
      unavailable: '宿主端插件未加载，暂时无法配置。',
      statusTitle: '实时读数',
      statusOff: '上限未启用——当前只由内置策略触发。',
      statusIdle: '尚未测量任何会话。会话下一步开始时会写入第一次测量。',
      statusLimit: '当前上限',
      statusRetain: '保留尾部',
      statusRounds: '单步压缩次数',
      statusSessions: '最近测量的会话',
      statusTokens: 'token',
      statusWindow: '窗口',
      statusCompactions: '次压缩',
      statusLast: '最近一次压缩',
      statusLastDetail: '{before} → {after} token，压缩 {nodes} 个节点',
      statusNone: '暂无',
      statusErrors: '最近的问题',
      statusUnreachable: '无法读取宿主端读数。',
      tokens: 'token',
    }

    /** The page's stylesheet, scoped by a plugin-owned class prefix. */
    const STYLES = `
.cc-page { display: flex; flex-direction: column; gap: 18px; }
.cc-lede { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.6; }
.cc-note { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.6; }
.cc-toggle { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.cc-toggle-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cc-toggle-label { color: var(--dsw-alias-label-primary); font-size: 13px; }
.cc-toggle-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
.cc-toggle-side { display: flex; align-items: center; gap: 8px; flex: none; }
.cc-reset { border: 0; background: none; padding: 0; cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; text-decoration: underline; }
.cc-reset:disabled { opacity: 0.5; cursor: default; }
.cc-tag { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 4px; padding: 1px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.cc-panel { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.cc-panel-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; }
.cc-facts { display: flex; flex-wrap: wrap; gap: 18px; margin: 0; }
.cc-fact { display: flex; flex-direction: column; gap: 2px; }
.cc-fact-key { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.cc-fact-value { color: var(--dsw-alias-label-primary); font-size: 14px; font-variant-numeric: tabular-nums; }
.cc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.cc-table th { text-align: left; font-weight: 400; color: var(--dsw-alias-label-tertiary); padding: 3px 10px 3px 0; }
.cc-table td { padding: 3px 10px 3px 0; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cc-empty { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.cc-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5; }
.cc-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l2); overflow: hidden; }
.cc-bar-fill { height: 100%; background: var(--dsw-alias-brand-primary); }
.cc-bar-fill.cc-hot { background: var(--dsw-alias-state-warn-primary); }
`

    /**
     * A boolean field spec for `SettingsFormModel`, which ships number and text
     * helpers only. The model is spec-driven, so a boolean rides the same staged
     * edit / save / reset path with no new machinery: the switch stages the
     * literal `"true"` / `"false"` this spec parses back into a boolean.
     * @param field - field name inside the namespace section.
     * @returns the field's conversion spec.
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === true ? 'true' : value === false ? 'false' : ''),
        parse: (text) => {
          const trimmed = String(text).trim().toLowerCase()
          if (trimmed === 'true') return { kind: 'set', value: true }
          if (trimmed === 'false') return { kind: 'set', value: false }
          return { kind: 'clear' }
        },
      }
    }

    /**
     * The page's staged form over the `context-compressor` settings namespace.
     * @param scope - the shared configuration form for that namespace.
     */
    class ContextCompressorForm {
      constructor(scope) {
        this.form = new P.SettingsFormModel(scope, [
          settingsBooleanField('enabled'),
          P.settingsNumberField('contextLimit'),
          P.settingsNumberField('retainTokens'),
          P.settingsNumberField('maxRounds'),
        ])
        this.store = this.form.bind(() => ({
          ...this.form.shell(),
          enabled: this.form.field('enabled'),
          contextLimit: this.form.field('contextLimit'),
          retainTokens: this.form.field('retainTokens'),
          maxRounds: this.form.field('maxRounds'),
        }))
      }

      /** Build the face the page's slot registration injects. */
      inject() {
        return { hooks: { contextCompressor: this.store }, ...this.form.actions() }
      }

      /** Release the form's accepted-value subscription. */
      dispose() {
        this.form.dispose()
      }
    }

    /**
     * Read the host half's live readout.
     * @returns the payload, or `undefined` when the route is unreachable.
     */
    async function fetchStatus() {
      try {
        const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) return undefined
        const body = await response.json()
        return body !== null && typeof body === 'object' && body.ok === true ? body.data : undefined
      } catch {
        return undefined
      }
    }

    /** Render a compact human count. */
    function count(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toLocaleString()
    }

    /** Render a session id compactly. */
    function shortId(id) {
      const text = String(id ?? '')
      return text.length <= 18 ? text : `${text.slice(0, 8)}…${text.slice(-6)}`
    }

    /**
     * The live readout panel: what the policy is actually doing right now.
     * @param props.t - the page's locale reader.
     */
    function StatusPanel({ t }) {
      const [status, setStatus] = React.useState(undefined)
      const [reachable, setReachable] = React.useState(true)

      React.useEffect(() => {
        let live = true
        const load = () => {
          void fetchStatus().then((data) => {
            if (!live) return
            setStatus(data)
            setReachable(data !== undefined)
          })
        }
        load()
        const timer = setInterval(load, STATUS_POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [])

      const rows = []
      rows.push(h('h3', { className: 'cc-panel-title', key: 'title' }, t('statusTitle')))

      if (!reachable && status === undefined) {
        rows.push(h('p', { className: 'cc-empty', key: 'unreachable' }, t('statusUnreachable')))
        return h('section', { className: 'cc-panel' }, rows)
      }
      if (status === undefined) {
        rows.push(h('p', { className: 'cc-empty', key: 'loading' }, t('statusIdle')))
        return h('section', { className: 'cc-panel' }, rows)
      }

      if (!status.enabled || status.contextLimit <= 0) {
        rows.push(h('p', { className: 'cc-empty', key: 'off' }, t('statusOff')))
      } else {
        rows.push(
          h(
            'div',
            { className: 'cc-facts', key: 'facts' },
            h('div', { className: 'cc-fact' }, h('span', { className: 'cc-fact-key' }, t('statusLimit')), h('span', { className: 'cc-fact-value' }, count(status.contextLimit))),
            h('div', { className: 'cc-fact' }, h('span', { className: 'cc-fact-key' }, t('statusRetain')), h('span', { className: 'cc-fact-value' }, count(status.retainTokens))),
            h('div', { className: 'cc-fact' }, h('span', { className: 'cc-fact-key' }, t('statusRounds')), h('span', { className: 'cc-fact-value' }, count(status.maxRounds))),
          ),
        )
      }

      const sessions = Array.isArray(status.sessions) ? status.sessions : []
      rows.push(h('span', { className: 'cc-fact-key', key: 'sessions-title' }, t('statusSessions')))
      if (sessions.length === 0) {
        rows.push(h('p', { className: 'cc-empty', key: 'sessions-empty' }, t('statusIdle')))
      } else {
        rows.push(
          h(
            'table',
            { className: 'cc-table', key: 'sessions' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'session'),
                h('th', null, t('statusTokens')),
                h('th', null, t('statusWindow')),
                h('th', null, t('statusCompactions')),
              ),
            ),
            h(
              'tbody',
              null,
              ...sessions.map((row, index) =>
                h(
                  'tr',
                  { key: `${row.sessionId}-${String(index)}` },
                  h('td', null, shortId(row.sessionId)),
                  h('td', null, count(row.tokens)),
                  h('td', null, row.contextWindow === undefined ? '—' : count(row.contextWindow)),
                  h('td', null, count(row.compactions)),
                ),
              ),
            ),
          ),
        )
      }

      const last = status.lastCompaction
      rows.push(h('span', { className: 'cc-fact-key', key: 'last-title' }, t('statusLast')))
      rows.push(
        h(
          'p',
          { className: 'cc-empty', key: 'last' },
          last === null || last === undefined
            ? t('statusNone')
            : t('statusLastDetail', { before: count(last.before), after: count(last.after), nodes: count(last.shadowedNodes) }),
        ),
      )

      const errors = Array.isArray(status.errors) ? status.errors : []
      if (errors.length > 0) {
        rows.push(h('span', { className: 'cc-fact-key', key: 'errors-title' }, t('statusErrors')))
        for (const [index, row] of errors.entries()) {
          rows.push(h('p', { className: 'cc-error', key: `error-${String(index)}` }, String(row.message)))
        }
      }

      return h('section', { className: 'cc-panel' }, rows)
    }

    /**
     * The settings page itself.
     * @param props - the injected form face, its actions, and the shell's close.
     */
    function ContextCompressorSection(props) {
      const t = props.t
      const state = props.useContextCompressor((snapshot) => snapshot)
      const labels = {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
      const enabled = state.enabled.text === 'true'
      const disabled = !state.writable

      return h(
        'div',
        { className: 'cc-page' },
        h('p', { className: 'cc-lede' }, t('description')),
        h(
          P.SettingsForm,
          { labels, state, onSave: props.save, onDiscard: props.discard },
          h(
            'div',
            { className: 'cc-toggle' },
            h(
              'div',
              { className: 'cc-toggle-text' },
              h('span', { className: 'cc-toggle-label' }, t('enabled')),
              h('span', { className: 'cc-toggle-hint' }, t('enabledHint')),
            ),
            h(
              'div',
              { className: 'cc-toggle-side' },
              state.enabled.overridden ? h('span', { className: 'cc-tag' }, t('overridden')) : null,
              state.enabled.overridden
                ? h('button', { type: 'button', className: 'cc-reset', disabled, onClick: () => { props.resetField('enabled') } }, t('reset'))
                : null,
              h(P.Switch, {
                checked: enabled,
                onChange: (next) => { props.edit('enabled', next ? 'true' : 'false') },
                label: t('enabled'),
                disabled,
              }),
            ),
          ),
          h(P.SettingsValueField, {
            id: 'cc-limit',
            label: t('limit'),
            hint: t('limitHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            numeric: true,
            disabled,
            ...state.contextLimit,
            onEdit: (text) => { props.edit('contextLimit', text) },
            onReset: () => { props.resetField('contextLimit') },
          }),
          h(P.SettingsValueField, {
            id: 'cc-retain',
            label: t('retain'),
            hint: t('retainHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            numeric: true,
            disabled,
            ...state.retainTokens,
            onEdit: (text) => { props.edit('retainTokens', text) },
            onReset: () => { props.resetField('retainTokens') },
          }),
          h(P.SettingsValueField, {
            id: 'cc-rounds',
            label: t('rounds'),
            hint: t('roundsHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            numeric: true,
            disabled,
            ...state.maxRounds,
            onEdit: (text) => { props.edit('maxRounds', text) },
            onReset: () => { props.resetField('maxRounds') },
          }),
        ),
        h('p', { className: 'cc-note' }, t('howItWorks')),
        h(StatusPanel, { t }),
      )
    }

    /** Required client services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Mount the plugin's settings page.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-context-compressor: dictionaries')

      const style = document.createElement('style')
      style.dataset.pluginStyles = PLUGIN_ID
      style.textContent = STYLES
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'dsh-context-compressor: stylesheet')

      const controller = new ContextCompressorForm(ctx.configForms.get(SETTINGS_NS))
      ctx.effect(() => () => controller.dispose(), 'dsh-context-compressor: form subscription')

      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: SETTINGS_NS,
                order: 60,
                label: () => t('nav'),
                locale: NS,
                inject: () => ({ ...controller.inject(), t }),
              },
              ContextCompressorSection,
            ),
          ),
        'dsh-context-compressor: settings page',
      )
    }

    exports.name = PLUGIN_ID
    exports.apply = apply
    exports.inject = inject
    exports.SETTINGS_NS = SETTINGS_NS
    exports.ContextCompressorSection = ContextCompressorSection
    return module.exports
  },
})
