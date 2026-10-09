---
description: "Sign in to a local Codex account, manage its model catalog, and view official DeepSeek balance or Codex quota."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-codex-account

English | [中文](README.zh.md)

## Summary

Sign in to ChatGPT for the `openai-codex` route, edit its model catalog, and see official DeepSeek API-key balance or Codex quota in the composer. Login uses the installed pi-ai authorization and credential store; it never starts automatically. The local browser callback requires Host and browser on the same machine. Account and quota indicators do not prove that a model request will succeed.

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

The Web/Desktop composition includes this plugin by default; the standalone package is not a profile bundle and has no `dsh plugin add` installation path.

### When to choose it

Use this package when a local Web or Desktop Host needs Codex OAuth controls, model-catalog editing, or account information. It mounts with the `llm-codex-account` row; it is not for headless or SDK compositions. It reuses the existing pi-ai authorization and provider, rather than adding a second OAuth or model-request flow.

### Minimal configuration

The shipped Web and Desktop profiles enable the row by default. A custom composition can mount it with:

```yaml
- id: llm-codex-account
  name: '@deepseek-ai/dsh-llm-codex-account'
```

| Field | Default | Meaning |
|---|---:|---|
| `providerInfoRefreshIntervalMs` | `60000` | Cache and composer refresh interval for account information, in milliseconds (`10000`–`86400000`). |
| `providerInfoRequestTimeoutMs` | `10000` | Maximum duration of an account-information request, in milliseconds (`1`–`120000`). |
| `pollIntervalMs` | `1000` | Browser polling cadence during login, in milliseconds (`250`–`30000`). |
| `loginDeadlineMs` | `300000` | Maximum lifetime of a login attempt, in milliseconds (`1`–`86400000`). |
| `attemptLeaseMs` | `60000` | Idle time without a poll before the Host releases an attempt; at least four poll intervals, at most `86400000` ms. |
| `attemptRetentionMs` | `300000` | How long the Host retains a completed attempt for polling; at least one poll interval, at most `86400000` ms. |

The Host validates these fields at load; lease or retention values shorter than the stated poll relationship fail loading. This table reflects the Host `Config` schema.

### Sign in and choose a route

Open Settings → Codex sign-in to sign in, cancel an active attempt, reopen its authorization page, or sign out. The page does not log in on load. After a successful new login on that page, it adds `providers.openai-codex: {}` only when that entry is absent; it never replaces an existing provider profile, including an API-key override. If automatic route enabling fails, the page offers a retry; the underlying Host also supports an explicit enable-route operation. Existing `apiKeyEnv` configuration retains the official adapter's authentication precedence.

Signing in does not revoke a prior server grant when you sign out. Sign-out deletes only the local Codex credential record and does not remove route configuration. Disabling this built-in means setting the `llm-codex-account` row's `disabled: true`; keep its settings and credentials if you may enable it again.

### Edit the model catalog

The settings page lists discovered models and supports adding, editing, and deleting catalog entries. Edits remain a draft until saved. Saving changes only `models`; other providers, `apiKeyEnv`, `modelOverrides`, and hidden model-row fields are preserved. Inherited defaults and an explicitly empty catalog are distinct: Restore defaults unsets `models`, while an empty list hides models from the selector. Catalog metadata does not establish account entitlement.

### View account information

The composer shows the official DeepSeek API-key balance for `deepseek-official` and the Codex OAuth 5-hour and weekly quota for `openai-codex`. A missing, unsupported, or failed query hides the indicator; it never reports failure as zero. Valid zero balance or quota remains visible. Codex quota uses the upstream window durations, not a fixed assumption about primary and secondary windows.

The Host makes credentialed network requests and returns only allowlisted, sanitized balance, quota, and timing fields. Upstream errors and response text remain hidden. Provider information is a bounded probe, not a quota reservation.

<a id="understand-the-implementation"></a>
## Understand the implementation

The combined package has Host and Client compiler faces. The Host owns login attempts, the callback availability probe, provider-information requests, and the narrow route-enable operation. The Client provides the Settings controls, catalog editor, and composer indicator through existing slots. Both faces use the existing authorization, credentials, pi-ai provider, settings, and Connection services; they do not implement another token refresh or inference path.

<a id="further-exploration"></a>
## Further Exploration

- [LLM provider adapters](../README.md) — package family and provider choices.
- [pi-ai provider routes](../llm-pi-ai/README.md) — provider configuration and credential precedence.
- [LLM streaming](../../../docs/subsystems/llm-streaming.md) — model request and adapter behavior.

<a id="model-experience"></a>
## Model Experience

### `openai-codex` account status and model catalog

#### What the model sees

This package adds no model-visible text to requests using `openai-codex`. Account status and catalog entries are used by the client and model selector, not inserted into model input.

#### Token effect

This package adds no input tokens. Actual usage depends on the selected model and request.

#### KV Cache effect

This package adds no model-input prefix and does not change KV-cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- OAuth requires the browser and Host to run on the same machine so the official flow can receive its `localhost:1455` callback. `PI_OAUTH_CALLBACK_HOST` must resolve to a loopback address; the port probe is a momentary check, not a reservation, and login still has a bounded deadline.
- Codex `/wham/usage` is an internal upstream endpoint and may change. It is not an entitlement check or reservation. Account-record presence alone does not establish that credentials are valid.
- The account indicator does not support custom Codex `baseURL`, `api`, or `apiKeyEnv` routes, nor DeepSeek account-token authentication or nonofficial DeepSeek API endpoints.
- Replacing the former external `dsh-openai-codex-oauth` add-on requires disabling/removing its activation from the user's profile layer before the built-in row is active. The built-in does not migrate or delete the add-on, its settings, or credentials.
- Live OAuth validation requires a manual account-enabled check; automated tests do not authenticate against real accounts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Implementation and verification notes — click to expand</summary>

The Host accepts only same-machine loopback callback configurations and uses the installed pi-ai OAuth implementation. Its callback-port probe releases the port immediately, so another process may bind it before OAuth does. Provider-information responses are size-bounded and reduced to documented fields before crossing Connection. Keep runtime imports from settings (`SettingsConflictError`), credentials (`credentialRef`), pi-ai (`recordKeyFor`), deepseek-api-key config helpers, and launch-environment (`launchEnvironmentOf`) classified as peer imports; add no safe-export allowlist.

</details>
