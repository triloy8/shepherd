# Shared installation of Shepherd skills

Status: proposed migration. This document records the intended layout and rollout;
adding it does not move skills or change the running installation.

## Decision

Manage Shepherd's generic skills in a separate Git repository and install them
manually at `~/.agents/skills`. Remove the vendored copy at
`~/shepherd/.agents/skills` after the replacement is installed and verified.

The current skills README identifies `triloy8/shepherd-skills` as the source of
`github` and `playwright-cli`. Prefer reusing that repository after confirming
its current contents and access, rather than creating a second source of truth.

A repository-local skills directory applies to work within that repository.
The user-level directory makes these generic skills discoverable when Shepherd
opens threads in other repositories or isolated workspaces.

## Intended layout

```text
~/.agents/skills/                  # Git checkout of the skills repository
  .gitignore
  github/
    SKILL.md
    local.env.example             # Tracked policy template
    local.env                     # Private, untracked installation policy
  playwright-cli/
    SKILL.md

~/shepherd/
  .docs/shared-skills-location.md
```

Each skill must be directly under the installation directory, without an extra
nested `skills/` level. Keep skill changes versioned in the skills repository.
Do not create a second clone under `~/shepherd/skills` or retain duplicate
installed copies. Project-specific workflow skills remain in their own projects.

If `~/.agents/skills` already contains unrelated skills, preserve them: install
the Shepherd skill folders individually or link them from a separate checkout.
Do not replace an existing directory merely to obtain the preferred layout.

## Migration sequence

1. Inspect the existing installation and record its revision and local changes.
   Preserve `github/local.env` privately before changing either location.
2. Install the skills repository at `~/.agents/skills`, when that destination is
   available. Verify its folder layout and ensure `github/local.env` is ignored
   before restoring the private policy. Commit only its example template.
3. Update the GitHub skill's default policy lookup from
   `~/shepherd/.agents/skills` to `~/.agents/skills`, or explicitly configure
   `SHEPHERD_SKILLS_DIR` for every relevant launcher. Keep one authoritative
   policy file and avoid workspace-specific copies.
4. Update Shepherd's Docker bind-mount source from `./.agents/skills` to the
   operator's installed skills directory. Keep the container destination at
   `/home/bun/.agents/skills`, read-only, and keep `SHEPHERD_SKILLS_DIR` aligned
   with that container path. Ensure the installed skills exist before startup.
5. Update installation instructions, packaging references and tests that assume
   the vendored directory. Configure the host service environment explicitly;
   an interactive shell setting alone may not reach a running service.
6. Run `!skills reload` in a thread targeting a different repository. Confirm
   that `github` and `playwright-cli` are listed from the shared installation.
   Restart the service or open a fresh thread if its context is stale.
7. Verify that the GitHub skill resolves the preserved policy without printing
   its contents. For Docker users, also check discovery and policy readability
   inside the container.
8. Only after verification, remove Shepherd's tracked vendored skills and the
   old private file. Keep any temporary private backup outside Git until the
   migration is confirmed, then dispose of it through the operator's normal
   secret-handling process.

## Completion and recovery

Completion requires one discoverable installation of each generic skill, intact
Git history in the skills repository, successful policy lookup, and working
host/container paths for the deployments in use. No credentials or private
policy values may enter either repository.

If verification fails, retain the old installation and restore the previous
launcher and mount settings while investigating. Do not remove the working
copy first. Future updates should be deliberate Git updates with their revision
recorded; installing the skills does not require automatic updates at startup.
