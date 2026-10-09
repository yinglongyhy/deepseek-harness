# Agent Note: Default Codex account integration

Status: implemented

English | [中文](2026-10-09-default-codex-account.zh.md)

## Problem

The existing pi-ai adapter and authorization services support Codex credentials, but a local GUI needs dedicated sign-in controls, editable model settings, and account information. Managing those related controls as separate add-ons scatters the feature and makes default Web/Desktop delivery harder to maintain.

## Decision

`llm-codex-account` owns the Host handlers and Client presentation in one nonexperimental LLM package, with separate Host and Client compiler faces. Web loads it by default and Desktop reuses that composition; Headless and SDK compositions remain unchanged. The package adds no provider or credential store: the installed pi-ai adapter owns OAuth and its existing credential key, as described in [credential records and authorization flows](2026-08-13-credential-records-and-authorization-flows.md).

Sign-in, route configuration, and request capability remain separate facts. A new successful login on the current page can add an absent Codex route, never replace an existing profile. Catalog saving is an explicit settings operation and can also create that profile. Stored credentials and reported quota do not guarantee access to a model. Logout removes only the local credential record.

Tokens, refresh, and upstream account requests stay on the Host. The Client receives allowlisted status and account fields. Connection registrations belong to the consuming plugin, which declares both Connection and its WebServer carrier so disposal and carrier replacement remove or remount its routes.

## Alternatives considered

**Experimental or opt-in delivery.** The requested feature is part of the default local GUI, not an evaluation capability; an experimental classification or optional bundle would contradict that product use.

**Separate login, catalog, and account-information packages.** These controls are maintained and delivered together. They do not require independently evolving public services, so splitting their implementation adds composition and management work without serving another consumer.

**A second OAuth flow, provider, or credential store.** Existing authorization and pi-ai services already own those responsibilities. Duplicating them would introduce competing token documents and authentication precedence.

## Consequences

Default delivery adds a dedicated settings section without starting authorization. Disabling the package preserves settings and credentials; an old external add-on must be disabled separately to avoid duplicate controls. The loopback OAuth callback requires Host and browser on the same machine. Codex quota relies on an unstable upstream endpoint, so failures hide stale information rather than report a fabricated zero.

Source tests cover account operations and lifecycle ownership; Loader and built-browser tests exercise actual composition and user-visible output. Live OAuth, quota, balance, and Desktop platform checks require account-enabled or manual validation separately.
