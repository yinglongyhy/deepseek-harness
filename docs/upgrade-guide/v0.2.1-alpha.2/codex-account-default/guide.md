---
kind: upgrade-guide
description: "The Codex account UI moves from the separately activated add-on to the default Web/Desktop composition row."
---

# Codex account controls are built in

English | [中文](guide.zh.md)

## Change

Web and Desktop now enable the Codex account controls through the `llm-codex-account` row by default. The previous `dsh-openai-codex-oauth` add-on is a separate activation and must not remain active alongside the built-in row. Headless and SDK compositions do not gain this UI.

## Migration

1. In the user's profile layer, disable or remove the old `dsh-openai-codex-oauth` activation before using the built-in row. Do not delete or move its settings or credentials automatically; the built-in does not migrate them.
2. Confirm the Web/Desktop composition has the row `id: llm-codex-account` with `name: '@deepseek-ai/dsh-llm-codex-account'`. Keep it enabled to use the built-in controls. To turn them off, set `disabled: true` on that row; do not erase its settings or credentials.
3. Open Settings → Codex sign-in and confirm its sign-in and catalog controls appear. Login remains user-initiated; no credentials or live OAuth behavior are verified by this guide.
