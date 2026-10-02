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
  ↓
Required post-merge verification
```

## Start with an Issue

Work starts from an Issue using the [Issue template](../.github/ISSUE_TEMPLATE/issue.md). The Issue defines the intended problem, expected outcome, and scope. Clarify ambiguous requirements before implementation; do not invent requirements during the change.

By default, completion criteria should be executable and verifiable by an AI agent. Require human checks, such as physical-device testing, subjective evaluation, or external approval, only when there is a necessary reason to do so.

When human work is required, state why it is necessary and what result is expected. Distinguish optional additional validation from mandatory completion criteria.

### Pre-merge acceptance and post-merge verification

Mandatory pre-merge acceptance criteria must be achievable and verifiable before merge. Checks possible only after merge must not be prerequisites for pre-merge PR approval; requiring them would create a review/merge/verification dependency cycle.

For example, when merging triggers deployment, validate the code and configuration, local builds, and applicable automated tests before merge. After merge, verify that deployment succeeded and that the newly published site serves the intended revision and behaves as expected. The existing site or a local build does not establish that the merged revision was published successfully.

Record required post-merge verification separately in the Issue and PR validation report, with the expected result and a **pending** status until performed. After merge, perform those checks and record their results and evidence. Pending post-merge verification does not block pre-merge approval, but remains required work and must not be reported as passed or as fully verified Issue completion. This distinction does not relax implementation requirements or applicable pre-merge tests; report failures, skipped checks, and unperformed checks accurately.

## Implement and propose a Pull Request

Make the smallest coherent change that fully solves the Issue. Validate it against the expected outcome and pre-merge acceptance criteria, and record required post-merge verification as described above.

Use the [PR template](../.github/pull_request_template.md) to explain what changed, the resulting behavior, validation, and related Issues. Keep the description accurate as the implementation changes.

A PR may claim to close an Issue only when it fully addresses that Issue. If required post-merge verification remains pending, keep the Issue open until it is performed and recorded. Intentional partial work is allowed, but label it clearly as partial, describe what remains, and avoid closing the parent Issue unless the remaining scope has been explicitly split into follow-up Issues.

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
