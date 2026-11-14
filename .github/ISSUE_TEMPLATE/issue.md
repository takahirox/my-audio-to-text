---
name: Issue
about: Report a problem or propose a change
title: ""
labels: ""
assignees: ""
---

## Problem

Describe the problem or need.

## Expected outcome

Describe what should be true when this Issue is complete.

Default to completion criteria an AI agent can execute and verify. Require human checks only when necessary; explain why and the expected result, and distinguish optional validation from mandatory criteria. See the [Issue-authoring guidance](https://github.com/takahirox/my-audio-to-text/blob/main/docs/development-flow.md#start-with-an-issue).

Mandatory pre-merge acceptance criteria must be achievable and verifiable before merge. Checks possible only after merge must not be prerequisites for pre-merge PR approval. For a merge-triggered deployment, require code/configuration review, local builds, and applicable automated tests before merge; verify deployment and the newly published site after merge.

## Required post-merge verification

List checks needed by this change that can only be performed after merge, or state "None." Describe the expected result and report each check as **pending** until performed. Follow the [merge, closure and follow-up lifecycle](https://github.com/takahirox/my-audio-to-text/blob/main/docs/development-flow.md#pre-merge-acceptance-and-post-merge-verification): close the implemented Issue after merge, record verification evidence, and track actual defects in new or existing linked Issues.

## Context

Add relevant background, constraints, examples, references, or related Issues/PRs. For defects, include reproduction steps, the affected revision and actual behavior.
