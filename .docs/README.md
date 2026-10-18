# Shepherd Documentation

This directory contains maintained engineering references and archived design
material. Start with the maintained documents for the current system; use the
archive when historical reasoning is useful.

## Maintained references

Start here:

- [Architecture](architecture.md) — the layers (protocol, ports, providers, core,
  surfaces, composition), what each owns, the main runtime flows, and the tests that
  enforce them.

Agents:

- [Provider adapters](provider-abstraction.md) — the shared boundary every agent
  implements: sessions, history, events, approvals, policy profiles and capabilities.
- [Codex parity matrix](codex-parity-matrix.md) — coverage of the generated Codex
  app-server surface.
- [Claude parity matrix](claude-parity-matrix.md) — Claude Agent SDK and subscription
  support, native behavior, missing controls, and verification limits.

Surfaces:

- [Web API](web-api.md) — setup, private access, HTTP request shapes, event recovery,
  and limits.
- [Web UI](web-ui.md) — what the built-in browser client shows and how its controls
  behave.
- [Surface parity matrix](surface-parity-matrix.md) — feature-by-feature Discord and
  web support, interaction differences and recovery limits.
- [Answering questions](user-questions.md) — structured agent questions and how web and
  Discord answer them.
- [Signal callbacks](volatile-webhook-signals.md) — callback allocation, routed
  loopback ingress, and delivery.

Operations:

- [Surface launch and lifecycle](surface-launch.md) — selection, shared host
  ownership, adapter health, and startup/shutdown.
- [Shared skills installation](shared-skills-location.md) — host setup, discovery
  checks, and recovery.
- [Known errors](errors.md) — diagnosed errors, their impact, and recovery.
- [Future implementations](future-implementations.md) — proposed work that has not
  been accepted as current behavior.

## Archive

Superseded descriptions, completed plans and resolved issues, kept for their reasoning:

- [Architecture before the layers](archive/architecture-before-layers.md) — the
  architecture as described before core was split into enforced layers.
- [Signal callbacks: design record](archive/signal-callbacks-design.md) — the
  problem, decisions, implementation checklist and acceptance criteria behind
  signal callbacks.
- [Shared skills migration](archive/shared-skills-migration.md) — the completed move
  from vendored skills to the shared checkout.
- [Resolved errors](archive/resolved-errors.md) — fixed issues and their diagnosis.
- [Provider architecture audit](archive/provider-architecture-audit.md) — findings from
  the first provider-separation pass on PR #90.
- [Adapter-to-core refactor map](archive/adapter-to-core-refactor-map.md) — the
  original extraction plan that led to core.
- [Discord adapter review](archive/discord-review.md) — a point-in-time review of the
  Discord path.
- [Discord formatting plan](archive/discord-formatting-plan.md) — formatting options
  and the completed implementation checklist.

## Maintenance conventions

- Use lowercase kebab-case filenames.
- Keep current behavior in the maintained references.
- Move completed or superseded plans into `archive/` and add a status note.
- Keep each fact in one document and link to it; for example, API contracts live
  in `web-api.md` and browser behavior in `web-ui.md`.
- Include a refresh date and source version in generated-surface inventories.
- Update this index when adding, moving, or retiring a document.
