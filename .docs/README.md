# Shepherd Documentation

This directory contains maintained engineering references and archived design
material. Start with the maintained documents for the current system; use the
archive when historical reasoning is useful.

## Maintained references

- [Surface parity matrix](surface-parity-matrix.md) — feature-by-feature Discord
  and web support, interaction differences and recovery limits.

- [Answering questions](user-questions.md) — structured Codex and Claude
  questions, web and Discord answer workflows, limits, and desktop/mobile screenshots.

- [Web API](web-api.md) — setup, private access, HTTP request shapes, event
  recovery, and limits.
- [Web UI](web-ui.md) — what the built-in browser client shows and how its
  controls behave.

- [Surface launch and lifecycle](surface-launch.md) — selection, shared host ownership, adapter health, and startup/shutdown behavior.

- [Shared skills installation](shared-skills-location.md) — host setup,
  private policy migration, discovery checks, and recovery.

- [Architecture](architecture.md) — current adapter, application-core,
  runtime-core, and provider-layer ownership boundaries and flows.
- [Codex parity matrix](codex-parity-matrix.md) — coverage of the generated
  Codex app-server surface.
- [Claude parity matrix](claude-parity-matrix.md) — Claude Agent SDK and
  subscription support, native behavior, missing controls, and verification limits.
- [Known errors](errors.md) — diagnosed errors, their impact, and recovery.
- [Future implementations](future-implementations.md) — proposed work that has
  not been accepted as current behavior.
- [Volatile signal callbacks](volatile-webhook-signals.md) — implemented
  dynamic callback allocation, routed loopback ingress, and delivery semantics.

## Designs under review

- [Provider abstraction](provider-abstraction.md) — one provider-neutral
  conversation model over Codex and Claude: items, events, interactions, ports,
  account limits, mappings, and implementation stages (PR #90).

## Historical design material

- [Provider architecture audit](archive/provider-architecture-audit.md) —
  findings and structure from the first provider-separation pass on PR #90.
- [Adapter-to-core refactor map](archive/adapter-to-core-refactor-map.md) —
  original extraction plan that led to the current architecture.
- [Discord adapter review](archive/discord-review.md) — point-in-time review of
  the Discord-to-Codex path.
- [Discord formatting plan](archive/discord-formatting-plan.md) — formatting
  options and the completed Plan A implementation checklist.

## Maintenance conventions

- Use lowercase kebab-case filenames.
- Keep current behavior in the maintained references.
- Move completed or superseded plans into `archive/` and add a status note.
- Keep each fact in one document and link to it; for example, API contracts live
  in `web-api.md` and browser behavior in `web-ui.md`.
- Include a refresh date and source version in generated-surface inventories.
- Update this index when adding, moving, or retiring a document.
