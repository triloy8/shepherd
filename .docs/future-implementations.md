# Future Implementations

## Future 001 — Unified Discord authorization

### Status

Proposed.

### Context

Shepherd currently relies on Discord server and channel permissions for access
control. Any user who can send messages where the bot is listening can invoke
the available `!` commands. This includes conversation-scoped commands such as
`!repo`, `!thread`, and `!model`, as well as process-scoped commands such as
`!restart` and `!deploy`.

Adding authorization to only a subset of commands would create an inconsistent
and difficult-to-explain security model. Until a unified policy exists,
`!restart` and `!deploy` should follow the same access model as the other
commands.

### Proposed direction

Introduce one Discord authorization layer that runs before any command or
approval side effect. It should receive a normalized principal and action, then
return an allow or deny decision with a user-facing reason.

The policy should cover:

- every `!` command;
- approval button interactions;
- guild, channel, thread, user, and role context;
- process-wide actions such as restart and deployment;
- conversation and workspace actions such as repo selection, skill changes,
  thread mutation, and turn interruption.

### Design constraints

- Keep authorization at the Discord adapter boundary so the core remains
  surface-agnostic.
- Use one policy path for commands and interactions instead of scattered
  per-command checks.
- Deny before starting network, filesystem, Codex, or process side effects.
- Make the default and configuration precedence explicit.
- Return consistent denial messages without exposing sensitive policy details.
- Add structured audit logging for allowed and denied administrative actions.
- Test the complete action matrix, including role changes and thread channels.

### Open decisions

- Whether the primary policy is based on Discord roles, explicit user IDs,
  allowed channels, or a composition of all three.
- Whether read-only commands and mutating commands require different grants.
- Whether direct mentions that start or steer Codex turns use the same policy.
- Whether deployment and restart require an additional confirmation step.

### Completion criteria

Authorization is considered unified when all command and approval entry points
delegate to the same policy service, no individual command contains its own
identity allowlist, and the behavior is documented and covered by integration
tests.
