# Shared skills migration

The one-time move from skills vendored in the Shepherd repository to the shared
`~/.agents/skills` checkout, completed on the production host. Current installation
and recovery are in [shared skills installation](../shared-skills-location.md).

## Migrate an existing host

1. Record the old skills revision and local changes. Privately back up
   `~/shepherd/.agents/skills/github/local.env` outside Git.
2. Install the shared checkout and confirm its ignore rule before restoring
   the existing private policy into `~/.agents/skills/github/local.env`.
   Preserve the policy values; do not replace them with the example template.
3. Verify discovery in a thread targeting a different repository with
   `!skills reload`. Both skills must be enabled and resolve to their shared
   paths. Also verify the GitHub skill can load the policy without printing it.
4. Apply the Shepherd revision that removes the tracked vendored skills.
   Remove the old private policy after successful verification. Preserve any
   unrelated local files. Retire old generic skill copies in active workspaces
   too, so they do not cause duplicate-name ambiguity.
5. Create the Claude Code link described in
   [Claude Code discovery](../shared-skills-location.md#claude-code-discovery) and verify it.
6. Reload skills for the Shepherd repository and active workspaces. Expect
   exactly one `github` and one `playwright-cli`, both from the shared location.
   Codex watches skill changes; open a fresh thread if an existing context
   still advertises the retired paths.

The underlying verification API is `skills/list` with the target repository in
`cwds` and `forceReload: true`, which is also what `!skills reload` requests.
[Codex skill discovery documentation](https://developers.openai.com/codex/skills)
describes the user directory, symlinks, and automatic change detection.
