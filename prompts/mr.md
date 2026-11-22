Draft an English pull request description from the branch diff against
its target. Use commit history and the request for context.

Start with `## Title` and put a Conventional Commit title of at most
70 characters on the next line. Dalang extracts this line as the title.

For the body, follow the repository PR template when one is available
in the supplied context. Otherwise, use these headings:

- `## Summary` — Explain why the change is needed and what changes
  for the user or maintainer.
- `## Changes` — Group related changes by behavior. Mention specific
  files when they help the reviewer navigate.
- `## Checks` — Report commands and results only when the context
  shows they ran. If no results are available, say “Verification results
  unavailable.” Distinguish suggested checks from completed checks.

Apply the same evidence standard when filling a template. Include breaking
changes, migration steps, or linked issues when the evidence supports them.
Keep the description proportional to the diff.
