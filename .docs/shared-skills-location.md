# Shared skills installation

Shepherd's generic `github` and `playwright-cli` skills are maintained in
[`triloy8/shepherd-skills`](https://github.com/triloy8/shepherd-skills) and
installed at `~/.agents/skills`. Shepherd no longer vendors these skills.
Project-specific skills remain in their project repositories.

This guide covers the host deployment launched from `~/shepherd`; Docker is out of
scope. The one-time move from vendored skills is archived in
[shared skills migration](archive/shared-skills-migration.md).

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
interactive shell setting does not update an already-running service. This override
selects the skills’ private configuration root; it does not configure Codex skill
discovery. Keep the skills discoverable through `~/.agents/skills` as well, for
example by linking that path to the custom root.

## Claude Code discovery

Codex reads the shared user directory `~/.agents/skills`; Claude Code's user
skill directory is `~/.claude/skills` (under `CLAUDE_CONFIG_DIR` when configured).
Claude also loads project skills. Link the shared user directory so additions
are discovered by both providers. Stop Claude processes that can write sync
state before migrating, and keep a private backup of both directories.

The following Bash block preflights every move before changing the directories.
It accepts an already-correct link, refuses another link or destination collision,
and stops if unrelated Claude skills need an explicit merge. It also supports the
non-checkout shared directory described under Install; Git excludes are changed
only when the shared directory itself is a checkout:

```bash
bash <<'SH'
set -eu
shared_skills_root="${SHEPHERD_SKILLS_DIR:-$HOME/.agents/skills}"
claude_config_root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
claude_skills_path="$claude_config_root/skills"
test -d "$shared_skills_root" || { echo 'Install the shared skills directory first.' >&2; exit 1; }
shared_skills_target="$(realpath -- "$shared_skills_root")"
stop() { echo "$1" >&2; exit 1; }

if [ ! -L "$claude_skills_path" ]; then
  claude_skills_absolute="$(realpath -m -- "$claude_skills_path")"
  [ "$claude_skills_absolute" != "$shared_skills_target" ] || stop 'The configured directories coincide; review the configuration before linking.'
fi
if [ -L "$claude_skills_path" ]; then
  existing_target="$(realpath -- "$claude_skills_path")" || stop 'Existing Claude skill link is broken.'
  [ "$existing_target" = "$shared_skills_target" ] || stop 'Claude skills points elsewhere; preserve it and review the migration.'
elif [ -e "$claude_skills_path" ]; then
  [ -d "$claude_skills_path" ] || stop 'Claude skills is not a directory.'
  shopt -s nullglob dotglob
  for source_entry in "$claude_skills_path"/*; do
    entry_name="${source_entry##*/}"
    case "$entry_name" in
      synced|.trash) ;;
      *) stop 'Unrelated Claude skills remain; merge them explicitly before linking.' ;;
    esac
    destination_entry="$shared_skills_target/$entry_name"
    if [ -e "$destination_entry" ] || [ -L "$destination_entry" ]; then
      stop 'Shared sync state already exists; merge the two copies explicitly before linking.'
    fi
  done
  for source_entry in "$claude_skills_path"/*; do
    mv -T -n -- "$source_entry" "$shared_skills_target/${source_entry##*/}"
    if [ -e "$source_entry" ] || [ -L "$source_entry" ]; then
      stop 'A destination appeared during migration; preserve both copies and retry after review.'
    fi
  done
  rmdir -- "$claude_skills_path"
fi

if [ ! -L "$claude_skills_path" ]; then
  mkdir -p -- "$claude_config_root"
  ln -sT -- "$shared_skills_target" "$claude_skills_path"
fi

skills_checkout_root="$(git -C "$shared_skills_target" rev-parse --show-toplevel 2>/dev/null || true)"
if [ "$skills_checkout_root" = "$shared_skills_target" ]; then
  skills_exclude_path="$(git -C "$shared_skills_target" rev-parse --path-format=absolute --git-path info/exclude)"
  mkdir -p -- "$(dirname -- "$skills_exclude_path")"
  touch -- "$skills_exclude_path"
  for exclusion in /synced/ /.trash/; do
    if ! grep -q -F -x -- "$exclusion" "$skills_exclude_path"; then
      printf '\n%s\n' "$exclusion" >> "$skills_exclude_path"
    fi
  done
fi
SH
```

Claude Code writes its sync state (`synced/`, `.trash/`) into the linked
directory. The local exclude keeps that state out of a shared skills checkout's
`git status` and commits. For a non-checkout directory, ensure any containing
repository excludes the sync state before committing. This recipe uses GNU
`realpath`, `mv -T -n`, and `ln -sT` on the supported Linux host; do not paste it
unchanged on a host with different filesystem utilities. If a move is interrupted,
preserve both directories and inspect them; do not delete sync state to make a
retry pass.

Verify in a new Claude Code process; an already-running session keeps its list:

```bash
claude -p "List the names of every skill available to you via the Skill tool, comma-separated." --model haiku
```

The output must include `github` and `playwright-cli`. With a custom
`SHEPHERD_SKILLS_DIR` or `CLAUDE_CONFIG_DIR`, the block uses those configured
directories. An already-running session must be reopened to load the new link.

## Updates and recovery

Keep generic skill edits in the skills repository, including the GitHub skill's
`<type>/<description>` branch naming rules. Use lowercase hyphenated descriptions
and omit assistant/tool branding; see that skill for the allowed types and examples.

Record the installed version with `git -C ~/.agents/skills rev-parse HEAD`.
Review and install updates deliberately; Shepherd does not update skills at
startup. Preserve ignored policy and local changes during upgrades.

If verification fails, keep or restore the previous checkout and private policy.
Do not remove the only working installation. A healthy host has one discoverable copy
of each generic skill, a `~/.claude/skills` link to the shared checkout, and one
readable, ignored private policy file.
