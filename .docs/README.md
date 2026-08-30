# Shepherd Documentation

This directory contains maintained engineering references and archived design
material. Start with the maintained documents for the current system; use the
archive when historical reasoning is useful.

## Maintained references

- [Architecture](architecture.md) — current adapter, application-core, and
  runtime-core ownership boundaries and flows.
- [Schema parity matrix](schema-parity-matrix.md) — coverage of the generated
  Codex app-server surface.
- [Known errors](errors.md) — diagnosed errors, their impact, and recovery.
- [Future implementations](future-implementations.md) — proposed work that has
  not been accepted as current behavior.
- [Volatile signal callbacks](volatile-webhook-signals.md) — implemented
  loopback signals and the accepted ephemeral per-operation routing proposal.

## Historical design material

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
- Include a refresh date and source version in generated-surface inventories.
- Update this index when adding, moving, or retiring a document.
