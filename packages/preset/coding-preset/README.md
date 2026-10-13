---
description: "Derive the independent Coding preset from the shipped PTC preset, retaining its plugins and persona while adding the four-level delegation policy. Configure the PTC patch path and understand load-time inheritance and failure behavior."
kind: "package-reference"
---

# @deepseek-ai/dsh-coding-preset

English | [中文](README.zh.md)

## Summary

Choose the independent Coding preset to retain the shipped PTC plugins—including PTC mode—and persona text while adding the four-level delegation policy. Each plugin load reads the current distribution's PTC patch, so non-user settings inherit its current values; existing Sessions keep their sampled setup. The source patch path is required, and an unavailable or incompatible source fails loading rather than using a stale copy.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web composition provides the source patch path through `coding.patch.yml`; the plugin derives the fixed `coding` preset from the distribution-owned PTC patch.

### Configuration

```yaml
config:
  ptcPresetPath: /path/to/distribution/presets/ptc.patch.yml
```

| Field | Default | Meaning |
|---|---|---|
| `ptcPresetPath` | required | Path to the current distribution's PTC preset patch (`@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`); the Web composition supplies it from `coding.patch.yml` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-coding-preset) is the exhaustive source for accepted fields and their declarations.

### Selection and delegation

The preset uses fixed id `coding` and roster order `1.5`. Its [four-level delegation policy](policy.md) selects model and effort by task difficulty and risk; entries without route parameters may retain inherited or configured routes. The policy is prompt guidance, not runtime enforcement. Explicit delegation model selection still requires the user to enable model selection in Subagents and allow `openai-codex/gpt-6-luna` and `openai-codex/gpt-6.1-sol`; this preset does not change Host defaults or credentials.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

On each plugin load, the package reads the configured distribution patch and derives Coding configuration from its unique `ptc` declaration and persona. The package retains the PTC plugin list, including PTC mode, and persona text, then appends the complete four-level delegation policy from `policy.md` unchanged. Changes to the source patch take effect on a later plugin load, not in an already loaded plugin. A missing source patch or incompatible declaration fails loading; no stale bundled copy is used as fallback. The Web composition supplies `ptcPresetPath` through `coding.patch.yml`. Coding remains independent of the Web package; plugin loading derives it from the current upstream PTC declaration, so subsequent PTC evolution is inherited at a later load. The package does not modify Standard or PTC, or enforce policy at runtime.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Preset group](../README.md) — preset and persona package map.
- [Agent preset](../agent-preset/README.md) — declarative preset entries.
- [Persona](../persona/README.md) — scoped persona sections.
- [Web application](../../bundle/web-app/README.md) — shipped Coding composition and source-path configuration.
- [Scope subsystem](../../../docs/subsystems/scope.md) — registration isolation.

-----

<a id="model-experience"></a>
## Model Experience

### Coding delegation policy

#### What the model sees

The Coding persona includes the PTC persona text and the complete four-level delegation policy from the package's root `policy.md`, appended unchanged. Model requests expose a single `run_code` tool and include a generated SDK for the underlying tools; only intermediate results printed or returned by the program enter the conversation, except images, which are passed through. The policy guides model behavior; permissions remain enforced by the underlying tools, and the prompt does not enforce delegation or model selection.

#### Token effect

Coding requests include the inherited PTC persona text and the appended delegation policy. This preset makes no claim about reducing token use.

#### KV Cache effect

The selected PTC persona and plugins are inherited at plugin load. Cache behavior depends on the resulting request and provider; no cache reuse guarantee is made.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Delegation settings remain user-owned** — explicit model selection requires enabling it in Subagents and allowing both policy model routes; the package does not modify Host settings or credentials.
- **Policy is advisory** — direct access to alternate delegation tools remains possible because prompt text is not runtime enforcement.
- **Source compatibility is required** — the configured distribution patch must contain the unique compatible PTC declaration and persona; load fails when they are missing or incompatible, with no stale-copy fallback.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
