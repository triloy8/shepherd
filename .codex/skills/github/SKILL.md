---
name: github
description: GitHub task execution with a gh-first workflow. Use when handling any GitHub-related request, including repositories, branches, pull requests, issues, checks, and merges. Default to GitHub CLI commands and enforce account, repository, and merge safety checks before remote actions.
---

# GitHub

Use `gh` as the default interface for any GitHub-related task. Use `git` only for local working-tree actions (`status`, `diff`, `add`, `commit`, `rebase`, branch cleanup).

Prefer `gh` commands/API for remote operations, but allow `git push` for branch updates in PR workflows. Keep `git pull`, `git fetch`, `git ls-remote`, `git remote` mutations, and `git submodule update --remote` blocked unless the user explicitly approves an exception in the current turn.

## Workspace Policy

Load local policy values from `.codex/skills/github/local.env` before any remote action:

```bash
set -a
source .codex/skills/github/local.env
set +a
```

Keep `.codex/skills/github/local.env` untracked. Commit only `.codex/skills/github/local.env.example`.

Set these policy values for this workspace and enforce them on every remote action:

- `EXPECTED_GITHUB_LOGIN`: from `$EXPECTED_GITHUB_LOGIN`
- `EXPECTED_GIT_USER_NAME`: from `$EXPECTED_GIT_USER_NAME`
- `EXPECTED_GIT_USER_EMAIL`: from `$EXPECTED_GIT_USER_EMAIL`
- `ALLOWED_REPOS`: from `$ALLOWED_REPOS`
- `PROTECTED_BRANCHES`: `main`, `master`
- `MERGE_STRATEGY`: `squash`
- `ACTIVE_REPO_PATH`: `<user-active-repo-path>`
- `AGENT_WORKSPACE_ROOT`: `~/.agent-workspaces`

Treat any mismatch as a hard stop unless the user explicitly overrides in the current turn.

Set `ACTIVE_REPO_PATH` per task/session to the user's current primary working repository.
Treat `ALLOWED_REPOS` as a comma-separated list, for example `owner/repo-one,owner/repo-two`.

## Workspace Isolation (Hard-Clone Mode)

Always perform edits in an isolated clone/worktree under `AGENT_WORKSPACE_ROOT`.

- Never edit files in `ACTIVE_REPO_PATH`
- Before any file edit, verify current working directory is not under `ACTIVE_REPO_PATH`
- If a task repo is missing in `AGENT_WORKSPACE_ROOT`, clone it first
- If it exists, fetch/prune and create a fresh task branch from `origin/main`
- For submodule targets (for example `triloy8/skills`), edit the target repo clone directly in `AGENT_WORKSPACE_ROOT`, not inside another repo's submodule directory
- Use branch + PR flow only; no direct branch updates to protected/default branches

## Required Preflight

Run these checks before any remote action (`push`, `pr create`, `pr merge`, `release`, `tag`, `issue edit`):

```bash
# Ensure git identity is explicitly configured for this repo before any commit/push
git config user.name "$EXPECTED_GIT_USER_NAME"
git config user.email "$EXPECTED_GIT_USER_EMAIL"

# Verify configured values
git config --get user.name
git config --get user.email
gh auth status
gh api user --jq '.login'
git remote -v
gh repo view --json nameWithOwner,defaultBranchRef
```

Apply these checks:

- `git config user.name` must equal `EXPECTED_GIT_USER_NAME`
- `git config user.email` must equal `EXPECTED_GIT_USER_EMAIL`
- Active login must equal `EXPECTED_GITHUB_LOGIN`
- `nameWithOwner` must be in `ALLOWED_REPOS`
- `defaultBranchRef.name` must be treated as protected

If any check fails, stop and ask for explicit confirmation before continuing.

## Hard Safety Rules

Enforce these defaults:

- Never push directly to protected branches (`main`, `master`, or repo default branch)
- Use branch + PR flow for all changes
- Allow `git push` only to non-protected branches associated with the active task/PR
- Never run `gh pr merge` unless user gives explicit merge confirmation in the current turn
- Never merge if checks are failing, unless user explicitly requests an override

## gh-First Command Patterns

Use these defaults:

```bash
# Repository context
gh repo view
gh repo view --web

# Pull requests
gh pr list
gh pr view <number>
gh pr checks <number>
gh pr create --base <base> --head <branch> --title "<title>" --body "<body>"
gh pr merge <number> --squash --delete-branch

# Issues
gh issue list
gh issue view <number>
gh issue create --title "<title>" --body "<body>"
```

When using `gh pr create`, `gh pr comment`, `gh pr edit`, or any `gh api` call with multiline text, never embed escaped `\n` sequences directly in a quoted shell string. Build the body with a single-quoted heredoc (`cat <<'EOF' ... EOF`) or pass a file via `--body-file` to preserve literal newlines and avoid shell interpolation.

If repo policy requires a different merge strategy, replace `--squash` only after explicit user instruction.

## PR Minimum Standard

Before creating a PR, ensure the PR body includes:

- What changed
- Why it changed
- How it was tested
- Linked issue or statement that no issue exists

After creating, always return the PR URL.

For every commit that is part of a PR branch, add a PR comment with:

- Commit SHA (short)
- Summary of what changed in that commit
- Test status for that commit (`tested` / `not tested`)

Use `gh pr comment <number> --body "<comment>"` and post the comment after the commit is pushed.
For multiline comments, use a single-quoted heredoc or `--body-file`; do not pass escaped `\n` sequences inside a quoted shell string.

## Commit And PR Message Rules

Use a light Conventional Commit format for commit subjects:

- `<type>: <imperative summary>`
- Keep the subject line at 72 characters or fewer
- Use lowercase types
- Describe the actual change, not process/meta wording
- Avoid placeholder subjects such as `wip`, `fix stuff`, `updates`

Allowed commit types:

- `feat`
- `fix`
- `docs`
- `refactor`
- `test`
- `build`
- `ci`
- `chore`

Examples:

- `feat: add remote skill export endpoint`
- `fix: read shared Codex sandbox config`
- `docs: clarify PR merge workflow`

Commit bodies are optional, but when present they should explain why the change was made or any important tradeoffs, not restate the diff.

PR titles should stay plain-language and describe the final squashed change clearly for reviewers. Do not require Conventional Commit formatting for PR titles unless the user explicitly asks for it.

## Merge Minimum Standard

Before merge, verify all of the following:

- PR targets the correct base branch
- Required checks are passing
- Account and repo preflight checks passed
- User explicitly confirmed merge in the current turn

Prefer `gh pr merge` over manual web merge.

## Stop Conditions

Stop and request user confirmation when any of the following occurs:

- Active GitHub account is unexpected
- Repository owner/name is not in `ALLOWED_REPOS`
- Action would push directly to a protected/default branch
- Task requires blocked networked `git` commands (`pull`, `fetch`, `ls-remote`, remote mutation, `submodule update --remote`) and no approved exception was provided
- Current directory is inside `ACTIVE_REPO_PATH` for a write/edit task
- Merge was requested without explicit confirmation
- Required checks are failing
- Working tree is dirty when a clean state is required
