---
name: orchestrating-subagents
description: Decide whether to hand parts of a task to sub-agents, and run them well when you do. Read it when a task has parts that are independent of each other and big enough for a fresh session (separate modules, a review, a test run, research or a sweep across many files, several bugs in unrelated areas), when someone asks you to delegate, split or parallelise work, or before any create_conversation call.
license: MIT
metadata:
  version: "1.0"
---

# Orchestrating sub-agents

You may hand parts of your task to sub-agents: fresh agent sessions in this project, started with the dalang MCP
tools (in Claude Code they may need loading first: search your tools for "mcp__dalang"). Use them, not a built-in
sub-agent tool (Task, Agent), for real work: these show up in the panel under your chat, keep their own session and
follow the limits. Your system prompt has a line with your project_id, how many you may still start, and your own
model and effort: no sub-agent may run above those.

## 1. Decide: split or do it yourself

A sub-agent costs a fresh context: it knows only what you write in its prompt, and you see only its last answer.
Both handoffs drop detail. Split only when that cost buys something.

Split when all of these hold:
- The parts are independent: none needs another's result to start, and they do not edit the same files.
- Each part is sizeable: many files to read or change, a long test run, a whole review. Not a handful of tool calls.
- You can say in a few paragraphs what "done" means for each part.

Do it yourself when:
- The work is small, or one lookup whose target you already know.
- The parts are tightly coupled (one design decision runs through all of them) or must happen in order.
- You do not yet understand the task well enough to brief someone else. Explore first, then decide.
- The person asked you, not a team, for a quick answer.

A review you want unbiased by your own reading is a good reason to split even when it is small: give the reviewer
the code or diff, not your conclusion.

Scale the number to the task: one sub-agent for a single sizeable part, two to four for a comparison or a few
separate areas, more only when the parts are clearly separate. Never more than the parts you can name; every extra
one costs a brief and a report to check.

Say in one line which you chose and why, then carry on. Do not ask the person whether to split.

## 2. Pick model and effort

1. Call `list_models`. It gives the models you may pick, ranked weakest (0) first, none above your own, and the
   efforts up to yours.
2. Pick the weakest model that fits the part, with the lowest effort that fits:
   - rank 0 (haiku, *-mini): searching, reading and summarising files, mechanical edits, running a test suite and
     reporting.
   - rank 1 (sonnet): ordinary implementation, a focused bug fix, writing tests.
   - rank 2+ (opus, gpt-*): design, a subtle bug, a security or correctness review, work where a wrong answer is costly.
3. Left out, a sub-agent runs on your own model and effort. That is fine for work as hard as yours, wasteful otherwise.
4. If a result falls short (failing tests, unfinished or wrong work), first `send_prompt` it a correction; if it
   still falls short, `set_model` one rank up. Never above your own: ask nobody to raise the limit.

## 3. Brief each one

`create_conversation` with `project_id`, `model`, `effort`, `worktree` and the task as `prompt`. The prompt is all it
gets, so write it like a brief to a capable colleague who has not seen this chat:

- **Goal**: what to achieve and why, in a sentence or two.
- **Context**: files, functions, docs to start from; what you already found or ruled out. Paste the exact error
  messages, failing test names and values it needs; "fix the race condition" alone is not enough.
- **Scope**: what it may change, and what it must leave alone. Read-only if it only investigates. When several
  run side by side, give each its own slice and say what the others cover, so two never do the same work. Add the
  shortcuts it must not take (e.g. "do not just raise the timeout", "do not change production code").
- **Done means**: how to check it (tests to run, behaviour to confirm).
- **Report**: what its last answer must contain, e.g. files changed, test output, open questions, findings with
  file:line. Ask for facts it checked, marked apart from guesses. A read-only one (research, review) gives its
  whole result in that answer: past about 6000 characters the report you get is cut, and `get_events` on its chat
  has the rest. Only one that already writes in its own worktree may put a long write-up in a file there and answer
  with the path and a short summary.

`worktree: true` for every sub-agent that changes files, so parallel sub-agents never write over each other or
you. Without a worktree it works in the project's main folder. A read-only one (research, review) needs none.

Start the independent ones together, all `create_conversation` calls in the same response (one per response makes
them wait on each other), then end your turn.

## 4. Wait, do not poll

When a sub-agent finishes, its last answer comes to your chat as a new message starting with `[Sub-agent]`. Do not
call `get_conversation` or `get_events` in a loop, and do not start the same work yourself while it runs. If the
person writes in the meantime, answer them; say a sub-agent is still running if they ask.

## 5. Check each report

Treat a report as a claim, not a fact: its mistakes come back in the same confident tone as its findings.
- Read the diff it made (in its worktree), not just its summary. Run the tests it says pass, when they matter.
- With several writers: check that their changes do not touch the same code, then run the full test suite on the
  changes together, not only each one's own tests.
- Spot-check one or two findings against the code before relying on them.
- If it fell short: `send_prompt` the same sub-agent a correction (it keeps its context), or `set_model` it one
  rank up. Do not quietly fix it yourself instead; that skips the check and fills your context. Give the work to
  another sub-agent only if this one is stuck, and after two failed corrections, rethink the split or do it yourself.
- At the limit of sub-agents, give a finished one new work with `send_prompt` instead of starting another.

## 6. Wrap up

Tell the person, briefly: what each sub-agent did, on which model, what you checked and how, and what is left.
A sub-agent's worktree changes stay on its own branch until someone merges them: say where they are.
