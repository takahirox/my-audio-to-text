# Development flow

This is the default workflow for my-audio-to-text, including AI-assisted development:

```text
Issue
  ↓
Implementation
  ↓
Pull Request
  ↓
Review
  ↓
Revision if needed
  ↓
Merge
```

## Start with an Issue

Work starts from an Issue using the [Issue template](../.github/ISSUE_TEMPLATE/issue.md). The Issue defines the intended problem, expected outcome, and scope. Clarify ambiguous requirements before implementation; do not invent requirements during the change.

## Implement and propose a Pull Request

Make the smallest coherent change that fully solves the Issue. Validate it against the expected outcome and any acceptance criteria.

Use the [PR template](../.github/pull_request_template.md) to explain what changed, the resulting behavior, validation, and related Issues. Keep the description accurate as the implementation changes.

A PR may claim to close an Issue only when it fully addresses that Issue. Intentional partial work is allowed, but label it clearly as partial, describe what remains, and avoid closing the parent Issue unless the remaining scope has been explicitly split into follow-up Issues.

## Review, revise, and merge

Review is required before merge. Apply the [review guidelines and merge criteria](review-guidelines.md) to check completeness, scope, correctness, and validation.

Resolve review feedback, revise the change and PR description as needed, and review again. Merge only when the PR is correct and appropriately scoped and meets the merge criteria.

## Language policy

Write repository collaboration artifacts and documentation in **English**, including:

- Issues and Issue comments;
- PR titles, descriptions, comments, and review comments;
- commit messages;
- repository documentation and user-facing developer instructions;
- code comments intended as maintained documentation.

Use English code identifiers unless there is a strong domain-specific reason otherwise. This keeps collaboration and project history readable across contributors, tools, and AI agents.

Japanese may appear in test fixtures, speech-recognition sample data, example Japanese transcripts, Japanese-language product behavior being tested, proper nouns, and other content that must remain in Japanese.

## Keep the policy small

Templates prompt authors, this document defines workflow and language policy, and the review guidelines define review and merge criteria. Use links for navigation instead of duplicating policy across documents.

This workflow takes design inspiration from GitWeave's [development flow](https://github.com/takahirox/gitweave/blob/main/docs/development-flow.md), [review guidelines](https://github.com/takahirox/gitweave/blob/main/docs/review-guidelines.md), [Issue template](https://github.com/takahirox/gitweave/blob/main/.github/ISSUE_TEMPLATE/issue.md), and [PR template](https://github.com/takahirox/gitweave/blob/main/.github/pull_request_template.md). It is adapted for this repository and requires no GitWeave tooling.
