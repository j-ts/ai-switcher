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

## Final consistency pass (done 2026-10-10, scripted)

To save tokens this pass ran as scripted checks, not reviewers:
- every acctshift flag used anywhere is defined in §10.4;
- every `exit N` + error.code pair is listed in Appendix E and §10.3 (one gap fixed: `invalid-bundle`);
- every JSON key in the §6.2, §6.3 and §11.2 examples appears in Appendix D;
- the fix-round rules (doctor exit codes, list never exits 69, validate-only never runs exec, what
  `mark --ok` keeps, the agy routing exception) agree in every section that states them;
- the stale-term scan is clean.

A fuller reviewer-based pass is still possible later. Ask for two read-only reviewers over `parts/`: one on
the contract surface (§6, §10–§12, Appendix D/E), one on the behaviour flows (§5.2, §8.3, §9, §13, §15, §21).

Binding decisions for any further edit, latest wins: `review/batch2-decisions.md`, the "Amendments" block in
`review/batch2-crossnotes.md`, then `review/fix-decisions.md`.

## Before implementation

- Run the §22 verification items on real machines and accounts (M0).
- Land the LimitShift prerequisite fixes P1–P7 (§15.1).
- `acctshift` is a working name. The new repository does not exist yet (§19.1).
