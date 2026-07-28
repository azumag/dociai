# Agent workflow

- Do not select, start, or implement an issue or task unless the user has explicitly confirmed the exact target.
- Before delegating work, state the target, purpose, explicitly selected Codex implementation model, and review sequence.
- The parent agent owns implementation. It must not treat its own self-review as sufficient to call work done.
- Use Sol (`sol_reviewer`) for overall plan review and intermediate implementation review. For any work touching code, config, migrations, or docs, always invoke `sol_reviewer` before reporting completion or opening a PR, passing it the issue, requirements, diff, related code, and test results.
- Fix any BLOCKER or HIGH findings yourself, then request re-review from `sol_reviewer`; repeat fix-and-re-review until zero BLOCKER/HIGH findings remain. The reviewer itself must not edit code.
- Treat the GitHub Actions Claude Code automatic PR review, configured as a Claude Opus 5 review, as the final external review.
- Run proportional tests before publication and report the validation results, including the Sol review outcome and how each finding was addressed.
