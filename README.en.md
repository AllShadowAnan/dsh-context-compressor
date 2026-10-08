# dsh-context-compressor

[简体中文](README.md) · **English**

An external [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds a **configurable context trigger**: pick one of two — an **absolute token ceiling**, or a **share of the model's context window** — and once a session reaches it the harness compacts the conversation automatically.

It ships a dedicated page in Settings, so the trigger is a user-facing preference rather than a config-file edit.

---

## Why this exists

DeepSeek Harness already compacts. Its policy is a **hard-coded relative** one: `@deepseek-ai/dsh-compaction-basic` triggers at 80% of whatever context window the routed model declares, with a 16% verbatim tail. That is the right default, and it is what most sessions want.

What it does not give you is a say in **where that line is drawn**. This plugin offers two ways to draw it, and you pick one:

- **Absolute ceiling (`absolute`).** "Never let one session grow past N tokens." For:
  - **Cost and latency ceilings.** A 1M-token window does not mean a 1M-token budget.
  - **Mixed routing.** The same session can be routed to models with wildly different windows; an absolute ceiling does not move when the route changes.
  - **Third-party and self-hosted endpoints.** Their declared `contextWindow` is often a guess, and the real limit is lower.
- **Share of window (`ratio`).** "Compact at X% of the window." This is exactly what the built-in policy does, except the hard-coded 80% becomes a number you control — compact earlier to save cost, or later to keep more context.

The two modes are **mutually exclusive**: only the selected one is ever computed, and the page renders only the field that belongs to it. The other value stays in the config, so switching back restores it.

Turn the master switch off and DSH behaves exactly as it did before installation.

---

## Install

The plugin is installed as an ordinary external profile plugin — nothing is patched into the application.

```sh
# from a local checkout: install the package's own deps first, because a
# `link:` dependency is a symlink and pnpm does not install into it
pnpm install
dsh plugin --profile desktop add link:/absolute/path/to/dsh-context-compressor

# from a GitHub release: releases/latest always resolves to the newest one
dsh plugin --profile desktop add https://github.com/AllShadowAnan/dsh-context-compressor/releases/latest/download/dsh-context-compressor.tgz

# pin an exact version (example)
dsh plugin --profile desktop add https://github.com/AllShadowAnan/dsh-context-compressor/releases/download/v1.0.1/dsh-context-compressor-1.0.1.tgz
```

`dsh plugin` forwards to `pnpm` with the profile directory as its working directory. Because this package declares both `dsh.bundle.patch` and `dsh.client.platform: "web"`, the same command also appends `dsh-context-compressor` to `dsh.profile.bundles`, which is what makes the package a profile composition layer.

The plugin's one runtime dependency is `@deepseek-ai/schemastery` — it supplies the `Config` schema the Settings page projects. A release-tarball install pulls it in automatically; a `link:` install needs the `pnpm install` above.

Then:

- **Live profiles (the Desktop app)** reconcile themselves when the profile manifest changes — the host half is active immediately. **Refresh the browser page** so the new browser bundle is injected into the document; that half cannot hot-apply.
- **Startup profiles** need a restart.
- **After editing the plugin's own source, restart the application.** The host half is Node code loaded at boot, and the browser bundle's bytes are read and cached at boot too; reinstalling or touching the profile manifest does not re-evaluate an already-loaded module. A page refresh alone is not enough.

To confirm the host half is up:

```sh
curl http://127.0.0.1:19387/dsh-context-compressor/status
# {"ok":true,"data":{"enabled":true,"mode":"absolute","contextLimit":0,"contextRatioPercent":80,"retainTokens":16000,"maxRounds":3,...}}
```

### Troubleshooting the install

**`pnpm` reports `fetch failed` when installing from the release URL.** Node's bundled CA list cannot verify GitHub's certificate chain on some Windows setups — TLS inspection, or a corporate root that is in the Windows store but not in Node's bundle. A browser and `Invoke-WebRequest` still work, which makes it look like a network problem rather than a trust one. Point Node at the system trust store for that one command:

```sh
NODE_OPTIONS=--use-system-ca dsh plugin --profile desktop add <tarball-url>
```

```powershell
$env:NODE_OPTIONS = "--use-system-ca"; dsh plugin --profile desktop add <tarball-url>
```

The same applies to `pnpm add` of any `github.com` URL, and it is not specific to this plugin.

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
| **Enable the trigger** | on | Master switch. Off restores DSH's built-in relative policy as the only trigger. |
| **Trigger** | Absolute ceiling | Pick one: `Absolute ceiling` or `Share of window`. Only the selected one is enforced, and only its field is shown below. |
| **Context ceiling (tokens)** | `0` | Active in absolute mode. The cap on one session's estimated context. `0` means "no ceiling". |
| **Trigger at (% of window)** | `80` | Active in ratio mode. Accepted range 5–95. 80 is what the built-in policy uses. |
| **Keep the most recent (tokens)** | `16000` | The verbatim tail. Everything older than it may be replaced by one summary. |
| **Reductions per step** | `3` | How many times one step may reduce the context before giving up for that step. |

Every field is `Reset to default`-able, and an overridden field is badged. Saves are staged: the page writes only when you press **Save**, and leaving the page discards uncommitted edits — the same contract every shipped settings page follows.

Below the form is a **live readout** fed by the host half: the trigger in force, the ceiling it resolves to (in ratio mode, the actual token count it works out to, or `—` while the window is unknown), the recently measured sessions (estimated tokens, that model's window, the threshold that session was held to, how many compactions it has taken), the last compaction's before/after token counts, and any recent failures. If the retained tail is not smaller than the ceiling, the readout says so directly — in that configuration a compaction has nothing left to summarize.

---

## What happens when a session crosses the trigger

At every step boundary (`agent/pre-step`), for the agent about to take that step:

1. **Resolve the threshold.** In absolute mode that is the configured token count; in ratio mode it is the routed model's declared window times the configured percentage, rounded down. Ratio mode does **nothing at all** while the session has logged no `request/context` — with no known window there is also nothing worth compacting. A master switch that is off, or an absolute limit of `0`, returns just as early.
2. **Measure.** `ctx.tokenMeter.measure(session)` prices the current surface — the request image, not the raw transcript.
3. **Under the threshold?** Do nothing at all. This is the common path.
4. **Prune first.** Over-budget tool results are shortened (`toolResultPruner`) — the cheap, deterministic reduction the built-in engine also tries first. If that alone clears the threshold, **no summary is written**.
5. **Then summarize.** Everything older than the `retainTokens` tail is replaced by one summary, via the public `compaction.compactRegion(start, end, agent)`. The cut is walked back until no assistant tool call is left without its result, so a tool-call/result pair is never split.
6. **Repeat** up to `maxRounds` times, stopping as soon as the session is under the threshold or a round makes no further progress.

Every failure is contained. A compaction that cannot run — the engine's durable lock is held, no safe cut exists, the summarizer errors — is logged, surfaced in the readout, and the turn continues. A context trigger is an optimization; it is never a reason to fail a turn.

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

The same six fields can be seeded from the composition layer — the plugin's own `cordis.patch.yml`, or the profile's:

```yaml
- insert:
    - id: context-compressor
      name: dsh-context-compressor
      config:
        enabled: true
        mode: absolute          # or ratio
        contextLimit: 120000    # active when mode is absolute
        contextRatioPercent: 80 # active when mode is ratio
        retainTokens: 20000
        maxRounds: 3
```

`mode` is a `union([const('absolute'), const('ratio')])` rather than a bare string, so a typo is rejected at load instead of silently turning the plugin into a no-op. `contextRatioPercent` is bounded to 5–95.

`id` is the **settings namespace** the page edits, not the package name. Keep them in sync if you rename it (`SETTINGS_NS` in `lib/index.js`, `SETTINGS_NS` in `lib/client.js`).

---

## Package layout

```
package.json          name / exports["./client"] / dsh.bundle.patch / dsh.client.platform
cordis.patch.yml      the profile composition layer: mounts the host row and seeds defaults
lib/index.js          host half: the trigger policy, the pre-step hook, the status route
lib/client.js         browser half: the Settings page (hand-written bundle, no build step)
locale/{en,zh}.json   the plugin inventory's title and description
icon.svg              plugin artwork
test/                 47 tests: policy, harness-settings conformance, browser bundle
```

There is **no build step**. The host half is plain ESM. The browser half is written directly in the shape DSH's client module loader expects — `window.__ModuleLoader__.load({ id, factory })` — and `require`s only platform seed words (`react`, `@deepseek-ai/dsh-client-ui-primitives`), so nothing needs bundling.

---

## Tests

```sh
node --test test/host.test.mjs test/settings-projection.test.mjs test/client.test.mjs
```

Three suites, 47 tests:

- **`host.test.mjs`** — the policy against fakes: the schema contract, balanced-cut selection, the retained tail, the system head, the prune-first path, the preset-realm resolution, failure containment, and the status route.
- **`settings-projection.test.mjs`** — runs the **harness's own** `volatileForm` / `projectForm` / `isVolatilePath` (imported from the installed application) against this plugin's `Config`, so a schema mistake fails here instead of producing a Settings page with no controls. Set `DSH_REFERENCE_ASAR` to the extracted application to run it; it skips otherwise.
- **`client.test.mjs`** — evaluates the real browser bundle against the module loader, then renders the page with **real React** and asserts every `t()` key resolves in both dictionaries.

---

## Known limitations

- **Token counts are estimates.** The meter prices the request image with a fixed-density heuristic until provider usage is available; treat the trigger as a budget line, not an exact tokenizer count.
- **A single oversized unit cannot be repaired.** If one retained message or request envelope exceeds the threshold on its own, surface compaction has nothing safe to cut and the session stays over. The readout says so.
- **The threshold is enforced at step boundaries**, so one step can overshoot it before the next measurement lands.
- **Ratio mode depends on the model declaring its window.** Until a session has logged a `request/context` the window is unknown and the plugin stays inert; an endpoint whose declared window is wrong gets a wrong threshold — which is precisely why absolute mode exists.
- **It needs a composition that mounts compaction.** The Desktop and web apps do; a minimal profile that never mounts the compaction stack has nothing for this plugin to drive, and it stays inert rather than failing.
- **The browser half needs a page refresh** after install. Only the host half hot-applies — and after editing the plugin's own source, both need an application restart.

## License

MIT.
