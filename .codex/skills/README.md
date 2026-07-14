<div align="center">

# 🐕 Skills 🧰

</div>

This directory contains vendored local Codex skills used by Shepherd.

Each skill is a small, focused instruction bundle that teaches Codex how to handle a class of tasks with repo-specific policy, examples, and workflow guidance. Shepherd discovers these skills locally and can expose them to active threads through its adapter surfaces.

## 📦 Current Skills

The current set is intentionally small:

- `github`: GitHub task workflow and safety policy for this workspace
- `playwright-cli`: browser automation workflow for Playwright CLI usage

## 🧱 Structure

Each skill lives in its own directory and is anchored by a `SKILL.md` file. Additional local files can be used for examples, references, or untracked machine-specific configuration when needed.

## 🔐 Local Configuration

Some skills may rely on local, untracked configuration. For example, the `github` skill uses `github/local.env` for machine-specific identity and policy values, while `github/local.env.example` is the tracked template.

## 📝 Notes

These skills were vendored from `https://github.com/triloy8/shepherd-skills` at commit
`acf6b0cc94f64dbd0696908e995d235a3036bdfd`.

The collection is meant to stay practical and local-first. The goal is not a giant catalog of generic prompts, but a curated set of reusable skills that reflect how Shepherd is actually operated.
