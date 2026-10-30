---
name: internal-comms
description: A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenever asked to write some sort of internal communications (status reports, leadership updates, 3P updates, company newsletters, FAQs, incident reports, project updates, etc.).
license: Complete terms in LICENSE.txt
---

## Running inside Dalang

- Write in the person's language (usually Indonesian) and in plain words a non-technical reader follows; explain a technical term the first time it appears, with a simple analogy when it helps.
- A report or message the person will send to others goes in the chat as ready-to-copy text, not as a file, PDF or doc, unless they ask for one.
- Gather facts yourself before asking: git log and diffs, the chat history (`get_events`), Dalang memory (`memory_search`), ClickUp chat (`clickup_chat_history`), and data through `db_query` or `ssh_exec` when needed. The Slack, Drive, Email and Calendar sources named in `examples/` are only available if a connector for them exists. Ask only for what none of these can tell you (for example the team name), and otherwise pick a sensible default and say which one you used.
- Every number, date and status must come from something you read; mark anything you could not verify instead of filling it in.
- Paths in this skill (`examples/`) are relative to this skill's folder. Ignore the emoji rule in the 3P format if the audience is formal (clients, management, external partners).
- After drafting, run the draft through the `avoid-ai-writing` skill if it reads stiff or machine-like.

## When to use this skill
To write internal communications, use this skill for:
- 3P updates (Progress, Plans, Problems)
- Company newsletters
- FAQ responses
- Status reports
- Leadership updates
- Project updates
- Incident reports

## How to use this skill

To write any internal communication:

1. **Identify the communication type** from the request
2. **Load the appropriate guideline file** from the `examples/` directory:
    - `examples/3p-updates.md` - For Progress/Plans/Problems team updates
    - `examples/company-newsletter.md` - For company-wide newsletters
    - `examples/faq-answers.md` - For answering frequently asked questions
    - `examples/general-comms.md` - For anything else that doesn't explicitly match one of the above
3. **Follow the specific instructions** in that file for formatting, tone, and content gathering

If the communication type doesn't match any existing guideline, ask for clarification or more context about the desired format.

## Keywords
3P updates, company newsletter, company comms, weekly update, faqs, common questions, updates, internal comms
