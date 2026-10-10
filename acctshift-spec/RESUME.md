# acctshift spec: status and how to resume

## Status (2026-10-10)

- `SPEC.md` (~495 KB) and `DECISIONS.md` (~43 KB) are complete. They are generated from `parts/*.md` by
  `sh parts/assemble.sh`. Always edit `parts/`, never the assembled files.
- `research/` holds the nine research reports (R01–R09) that the spec cites as `[Rxx §y]`.
- Review history:
  - batch 1: 77 security and cross-platform findings, applied;
  - batch 2: 115 contract, state, fact-check and completeness findings (`review/review-rest.md`), applied;
  - verify round: 6 independent verifiers found 133 checks fully addressed and 80 residual issues (`review/verify-issues.json`), all fixed per `review/fix-decisions.md`.
- Automated checks passed after the last edit: every `foo`/`fooEpoch` example pair agrees, every `§n.n`
  reference resolves, every V-item cited is defined in §22 and scheduled in §21, and every exec 125 code
  appears in Appendix E.

## Not done (optional)

One final cross-section consistency pass after the fix round. It was started and stopped by the usage limit,
so nothing ran. To run it, ask Claude for two read-only reviewers over `parts/`:
1. the contract surface: exit codes, error.codes, flags, and JSON fields in §6, §10–§12, Appendix D/E;
2. the behaviour flows: limit rotation, auth strikes, the agy swap and recovery, the notice gate, failure
   handling as LimitShift sees it, and milestones.

Binding decisions for any further edit, latest wins: `review/batch2-decisions.md`, the "Amendments" block in
`review/batch2-crossnotes.md`, then `review/fix-decisions.md`.

## Before implementation

- Run the §22 verification items on real machines and accounts (M0).
- Land the LimitShift prerequisite fixes P1–P7 (§15.1).
- `acctshift` is a working name. The new repository does not exist yet (§19.1).
