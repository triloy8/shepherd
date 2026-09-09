# Shared skills installation

Shepherd's generic `github` and `playwright-cli` skills are maintained in
[`triloy8/shepherd-skills`](https://github.com/triloy8/shepherd-skills) and
installed at `~/.agents/skills`. Shepherd no longer vendors these skills.
Project-specific skills remain in their project repositories.

This guide covers the host deployment launched from `~/shepherd`. Docker is
outside this migration's scope.

## Install

When `~/.agents/skills` does not exist:

```bash
gh repo clone triloy8/shepherd-skills ~/.agents/skills
```

The checkout must contain `github/SKILL.md` and `playwright-cli/SKILL.md`
directly under `~/.agents/skills`, without an extra `skills/` level. If unrelated
skills already occupy that directory, preserve them and link the individual
Shepherd skill folders from a separate checkout instead of replacing it.

For a fresh installation, create the private policy:

```bash
cp ~/.agents/skills/github/local.env.example ~/.agents/skills/github/local.env
chmod 600 ~/.agents/skills/github/local.env
git -C ~/.agents/skills check-ignore github/local.env
```

Fill in the expected GitHub identity and allowed repositories in that file.
Include repositories this installation manages, including the skills repository
if it will maintain its own skills. Commit only the example template; `*.env`
is ignored.

The GitHub skill defaults to `$HOME/.agents/skills/github/local.env`.
`SHEPHERD_SKILLS_DIR` can override the installation root. The standard host
launcher inherits the user's `HOME`, so no override or launcher edit is needed.
For a custom root, set the override in the launcher environment; an unrelated
interactive shell setting does not update an already-running service.

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
5. Reload skills for the Shepherd repository and active workspaces. Expect
   exactly one `github` and one `playwright-cli`, both from the shared location.
   Codex watches skill changes; open a fresh thread if an existing context
   still advertises the retired paths.

The underlying verification API is `skills/list` with the target repository in
`cwds` and `forceReload: true`, which is also what `!skills reload` requests.
[Codex skill discovery documentation](https://developers.openai.com/codex/skills)
describes the user directory, symlinks, and automatic change detection.

## Updates and recovery

Keep generic skill edits in the skills repository, including the GitHub skill's
`<type>/<description>` branch naming rules. Use lowercase hyphenated descriptions
and omit assistant/tool branding; see that skill for the allowed types and examples.

Record the installed version with `git -C ~/.agents/skills rev-parse HEAD`.
Review and install updates deliberately; Shepherd does not update skills at
startup. Preserve ignored policy and local changes during upgrades.

If verification fails, keep or restore the previous checkout and private policy
and restore any previous launcher override. Do not remove the only working
installation. Dispose of temporary private backups after verifying the completed
migration. A successful host migration has one discoverable copy of each generic
skill, preserved Git history, and one readable, ignored private policy file.
