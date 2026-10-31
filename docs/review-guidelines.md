# Review guidelines

Start by reading the source Issue and the PR's description and changes. The central review question is:

> Does this Pull Request completely address the Issue, without adding changes that are not justified by the Issue?

Review scope in both directions. Prefer the smallest coherent change that fully solves the Issue. This is especially important for AI-generated changes, which can produce broader or more elaborate implementations than necessary.

## No missing scope

Do not approve a PR when required implementation or pre-merge validation is still missing. Check for:

- incomplete pre-merge acceptance criteria;
- only one part of a multi-part Issue being implemented;
- missing applicable pre-merge validation for a required behavior;
- documentation or migration work omitted when explicitly required by the Issue.

Mandatory pre-merge acceptance criteria must be achievable and verifiable before merge. Checks possible only after merge must not be prerequisites for pre-merge PR approval. Confirm that required post-merge verification is recorded separately with expected results and a **pending** status until performed, following the [acceptance and verification guidance](development-flow.md#pre-merge-acceptance-and-post-merge-verification). Approval does not establish that those checks passed or that the Issue is fully verified.

For a merge-triggered deployment, review the code/configuration, local build results, and applicable automated tests before merge. Verify deployment and the newly published site after merge. This preserves implementation requirements and applicable pre-merge tests; failures, skips, or unperformed checks must not be reported as passed.

For intentional partial work, verify that the PR clearly states what remains and follows the [partial-work rule](development-flow.md#implement-and-propose-a-pull-request).

## No unnecessary scope

Avoid over-engineering. Check for:

- unnecessary abstractions or speculative extensibility;
- unrelated refactoring;
- new frameworks or subsystems without a demonstrated need;
- configuration or policy added "for the future";
- solutions to adjacent problems that were not requested.

Each change should have a clear reason tied to the Issue. Additional complexity is not automatically beneficial.

## Node architecture

Use the existing [design principles](../README.md#design-principles) and
[composition examples](processing-pipeline.md#graph-driven-live-text-99) as review
prompts for reviewers and AI agents, within the existing review:

1. Does each modified node do only what its public contract promises?
2. Did any node silently acquire history, grouping, rendering or producer-specific
   behavior? Catch implicit history in a formatter, display-specific logic in a
   generic sink, and translation/preview-specific state in unrelated nodes.
3. Could explicit composition of existing processors meet the need instead of
   expanding an output node or introducing an unnecessary framework?
4. Where relevant, are direct/latest-result and explicit-accumulation behaviors
   independently tested?
5. Are new abstractions, ports, modes or configuration directly required by the
   source Issue?

One responsibility permits multiple ports and intentional stateful processors;
it does not require a node for every implementation detail. These prompts add
no mandatory workflow stage. Detailed producer-independence and transport checks
remain in [port contracts](port-contracts.md) and the ordinary quality checks below.

## UI/UX

Review UI changes against the [UI/UX design principles](../README.md#uiux),
including their requirement to preserve essential labels and accessibility information.

## Ordinary quality

Apply the [test and CI principles](development-flow.md#test-and-ci-principles): consider the additional defects detected, overlap with existing coverage, and execution/maintenance cost of new or expanded checks. Ask:

> Does this change provide sufficient confidence with the lightest appropriate validation, without redundant execution?

Also review:

- correctness and behavior against the expected outcome;
- clarity and consistency with the current architecture;
- appropriate tests or validation for the required behavior;
- documentation updates when behavior changes;
- port/schema changes tested against saved versions, with visible recovery for
  behavior differences and no silent loss of unrelated routes or stored content;
- [producer-independent composition](port-contracts.md): reject wiring checks or
  hidden modes based on producer type/name, output name, neighbors or edge order;
  test alternate producers, both edge orders, incomplete drafts, consumer-owned
  startup/correlation constraints and independent failure/Cancel paths;
- grouped delivery, independent streams, repeated values and cleanup validated
  without exposing internal job metadata as public ports;
- security and privacy implications where relevant.

## Merge criteria

A PR is ready to merge only after review and when:

- it fully implements the required scope and satisfies pre-merge acceptance criteria, or accurately identifies intentional partial work;
- it has no unjustified scope or complexity;
- the implementation is correct and applicable pre-merge validation is sufficient;
- required post-merge verification is recorded separately as pending, with expected results, and the Issue remains open until it is performed and recorded;
- review feedback has been resolved;
- the PR description accurately reflects what was implemented.

If any criterion is unmet, request changes and review again after revision. Passing CI alone is insufficient when the implementation is incomplete or over-scoped.
