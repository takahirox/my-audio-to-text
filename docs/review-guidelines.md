# Review guidelines

Start by reading the source Issue and the PR's description and changes. The central review question is:

> Does this Pull Request completely address the Issue, without adding changes that are not justified by the Issue?

Review scope in both directions. Prefer the smallest coherent change that fully solves the Issue. This is especially important for AI-generated changes, which can produce broader or more elaborate implementations than necessary.

## No missing scope

Do not approve a PR as completing an Issue when required work is still missing. Check for:

- incomplete acceptance criteria;
- only one part of a multi-part Issue being implemented;
- missing validation for a required behavior;
- documentation or migration work omitted when explicitly required by the Issue.

For intentional partial work, verify that the PR clearly states what remains and follows the [partial-work rule](development-flow.md#implement-and-propose-a-pull-request).

## No unnecessary scope

Avoid over-engineering. Check for:

- unnecessary abstractions or speculative extensibility;
- unrelated refactoring;
- new frameworks or subsystems without a demonstrated need;
- configuration or policy added "for the future";
- solutions to adjacent problems that were not requested.

Each change should have a clear reason tied to the Issue. Additional complexity is not automatically beneficial.

## Ordinary quality

Also review:

- correctness and behavior against the expected outcome;
- clarity and consistency with the current architecture;
- appropriate tests or validation for the required behavior;
- documentation updates when behavior changes;
- security and privacy implications where relevant.

## Merge criteria

A PR is ready to merge only after review and when:

- it fully satisfies each Issue it claims to resolve, or accurately identifies intentional partial work;
- it has no unjustified scope or complexity;
- the implementation is correct and validation is sufficient;
- review feedback has been resolved;
- the PR description accurately reflects what was implemented.

If any criterion is unmet, request changes and review again after revision. Passing CI alone is insufficient when the implementation is incomplete or over-scoped.
