# dsh-context-compressor

An external [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds an **absolute context ceiling**: you pick a token limit, and once a session reaches it the harness compacts the conversation automatically — regardless of which model is routed or how large that model's context window is.

It ships a dedicated page in Settings, so the limit is a user-facing preference rather than a config-file edit.

---

## Why this exists

DeepSeek Harness already compacts. Its policy is *relative*: `@deepseek-ai/dsh-compaction-basic` triggers at a fraction of whatever context window the routed model declares — 80% by default, with a 16% verbatim tail. That is the right default, and it is what most sessions want.

It cannot express "never let one session grow past N tokens". Three cases where that matters:

- **Cost and latency ceilings.** A 1M-token window does not mean a 1M-token budget.
- **Mixed routing.** The same session can be routed to models with wildly different windows; a relative policy moves the line every time the route changes.
- **Third-party and self-hosted endpoints.** Their declared `contextWindow` is often a guess, and the real limit is lower.

This plugin adds the absolute knob without touching the built-in policy. Leave the ceiling at `0` and DSH behaves exactly as it did before.

---

## Install

The plugin is installed as an ordinary external profile plugin — nothing is patched into the application.

```sh
# from a local checkout: install the package's own deps first, because a
# `link:` dependency is a symlink and pnpm does not install into it
pnpm install
dsh plugin --profile desktop add link:/absolute/path/to/dsh-context-compressor

# from a registry or tarball
dsh plugin --profile desktop add dsh-context-compressor
```

`dsh plugin` forwards to `pnpm` with the profile directory as its working directory. Because this package declares both `dsh.bundle.patch` and `dsh.client.platform: "web"`, the same command also appends `dsh-context-compressor` to `dsh.profile.bundles`, which is what makes the package a profile composition layer.

The plugin's one runtime dependency is `@deepseek-ai/schemastery` — it supplies the `Config` schema the Settings page projects. A registry install pulls it in automatically; a `link:` install needs the `pnpm install` above.

Then:

- **Live profiles (the Desktop app)** reconcile themselves when the profile manifest changes — the host half is active immediately. **Refresh the browser page** so the new browser bundle is injected into the document; that half cannot hot-apply.
- **Startup profiles** need a restart.

To confirm the host half is up:

```sh
curl http://127.0.0.1:19387/dsh-context-compressor/status
# {"ok":true,"data":{"enabled":true,"contextLimit":0,"retainTokens":16000,"maxRounds":3,...}}
```

### Uninstall

```sh
dsh plugin --profile desktop remove dsh-context-compressor
```

If the name lingers in `dsh.profile.bundles` in `$DSH_HOME/profiles/<profile>/package.json`, drop it there too.

---

## The Settings page

**Settings → 上下文压缩 / Context compression**

| Field | Default | Meaning |
| --- | --- | --- |
| **Enable the absolute ceiling** | on | Master switch. Off restores DSH's built-in relative policy as the only trigger. |
| **Context ceiling (tokens)** | `0` | The absolute cap on one session's estimated context. `0` means "no ceiling". |
| **Keep the most recent (tokens)** | `16000` | The verbatim tail. Everything older than it may be replaced by one summary. |
| **Reductions per step** | `3` | How many times one step may reduce the context before giving up for that step. |

Every field is `Reset to default`-able, and an overridden field is badged. Saves are staged: the page writes only when you press **Save**, and leaving the page discards uncommitted edits — the same contract every shipped settings page follows.

Below the form is a **live readout** fed by the host half: the ceiling in force, the recently measured sessions (estimated tokens, that model's window, how many compactions the session has taken), the last compaction's before/after token counts, and any recent failures.

---

## What happens when a session crosses the ceiling

At every step boundary (`agent/pre-step`), for the agent about to take that step:

1. **Measure.** `ctx.tokenMeter.measure(session)` prices the current surface — the request image, not the raw transcript.
2. **Under the ceiling?** Do nothing at all. This is the common path.
3. **Prune first.** Over-budget tool results are shortened (`toolResultPruner`) — the cheap, deterministic reduction the built-in engine also tries first. If that alone clears the ceiling, **no summary is written**.
4. **Then summarize.** Everything older than the `retainTokens` tail is replaced by one summary, via the public `compaction.compactRegion(start, end, agent)`. The cut is walked back until no assistant tool call is left without its result, so a tool-call/result pair is never split.
5. **Repeat** up to `maxRounds` times, stopping as soon as the session is under the ceiling or a round makes no further progress.

Every failure is contained. A compaction that cannot run — the engine's durable lock is held, no safe cut exists, the summarizer errors — is logged, surfaced in the readout, and the turn continues. A context ceiling is an optimization; it is never a reason to fail a turn.

### How it reaches the compaction engine

Worth knowing if you are writing a similar plugin, because the obvious approach does not work.

The compaction stack is mounted **inside each agent preset's isolated cordis group**, and the web bundle *disables* the profile-root rows of the same names (`@deepseek-ai/dsh-web-app`'s `cordis.patch.yml` turns off `compaction-basic`, `command-compact`, and `tool-result-pruner`). So:

- A profile-root plugin **cannot** `inject: ['compaction']` — there is no such service on the host plane.
- `agent.ctx.get('compaction')` **does not work either**. `agent.ctx` is a scope of the *root* `agent-loop` row, so its isolate key is the root symbol, under which the disabled row published nothing.
- `agent.ctx.compaction` (property access) throws `cannot get property "compaction" without inject`.

The registry that mounts each preset is the one handle that can look inside its own isolated realm, and it publishes `serviceFor(agent, name)` for exactly this purpose — `@deepseek-ai/dsh-api-session-controller` resolves `skills` the same way. This plugin resolves per agent, per call:

```js
ctx.get('agentPresets')?.serviceFor(agent, 'compaction')   // the preset realm
  ?? ctx.get('compaction') ?? agent.ctx.get('compaction')  // the host plane (headless)
```

The token meter is the exception that proves the rule: it deliberately *stays* on the host plane (its projection table is process-wide), so it resolves from the plugin's own context.

Two more contracts this plugin depends on:

- **`agent/pre-step` is a scope-filtered waterfall**, and an untagged listener registered on any context is admitted for every agent. That is the seam a root plugin wants, and it is also the only safe moment — the engine's region compaction requires an **open turn**, and `agent/pre-step` runs inside one.
- **Volatile config is what makes the page live.** Every field is declared `.volatile()`, so a settings write commits into the running reference in place (`cordis-plugin-loader`'s `_commitVolatile`) instead of remounting the plugin. The plugin therefore reads `config.contextLimit.get()` at each decision point and never caches a value.

---

## Configuration

The same four fields can be seeded from the composition layer — the plugin's own `cordis.patch.yml`, or the profile's:

```yaml
- insert:
    - id: context-compressor
      name: dsh-context-compressor
      config:
        enabled: true
        contextLimit: 120000
        retainTokens: 20000
        maxRounds: 3
```

`id` is the **settings namespace** the page edits, not the package name. Keep them in sync if you rename it (`SETTINGS_NS` in `lib/index.js`, `SETTINGS_NS` in `lib/client.js`).

---

## Package layout

```
package.json          name / exports["./client"] / dsh.bundle.patch / dsh.client.platform
cordis.patch.yml      the profile composition layer: mounts the host row and seeds defaults
lib/index.js          host half: the ceiling policy, the pre-step hook, the status route
lib/client.js         browser half: the Settings page (hand-written bundle, no build step)
locale/{en,zh}.json   the plugin inventory's title and description
icon.svg              plugin artwork
test/                 29 tests: policy, harness-settings conformance, browser bundle
```

There is **no build step**. The host half is plain ESM. The browser half is written directly in the shape DSH's client module loader expects — `window.__ModuleLoader__.load({ id, factory })` — and `require`s only platform seed words (`react`, `@deepseek-ai/dsh-client-ui-primitives`), so nothing needs bundling.

---

## Tests

```sh
node --test test/host.test.mjs test/settings-projection.test.mjs test/client.test.mjs
```

Three suites, 29 tests:

- **`host.test.mjs`** — the policy against fakes: the schema contract, balanced-cut selection, the retained tail, the system head, the prune-first path, the preset-realm resolution, failure containment, and the status route.
- **`settings-projection.test.mjs`** — runs the **harness's own** `volatileForm` / `projectForm` / `isVolatilePath` (imported from the installed application) against this plugin's `Config`, so a schema mistake fails here instead of producing a Settings page with no controls. Set `DSH_REFERENCE_ASAR` to the extracted application to run it; it skips otherwise.
- **`client.test.mjs`** — evaluates the real browser bundle against the module loader, then renders the page with **real React** and asserts every `t()` key resolves in both dictionaries.

---

## Known limitations

- **Token counts are estimates.** The meter prices the request image with a fixed-density heuristic until provider usage is available; treat the ceiling as a budget line, not an exact tokenizer count.
- **A single oversized unit cannot be repaired.** If one retained message or request envelope exceeds the ceiling on its own, surface compaction has nothing safe to cut and the session stays over. The readout says so.
- **The ceiling is enforced at step boundaries**, so one step can overshoot it before the next measurement lands.
- **It needs a composition that mounts compaction.** The Desktop and web apps do; a minimal profile that never mounts the compaction stack has nothing for this plugin to drive, and it stays inert rather than failing.
- **The browser half needs a page refresh** after install. Only the host half hot-applies.

## License

MIT.
