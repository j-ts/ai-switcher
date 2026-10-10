# accshift: specification

| | |
|---|---|
| Document | `SPEC.md`, version 0.9 (draft for implementation) |
| Date | 2026-10-07 |
| Owner | j-ts (LimitShift maintainer) |
| Status | Ready for M0 (verification spike). Everything marked **VERIFY** must be confirmed on real machines and accounts before the matching milestone ships. |
| Working name | `accshift`. Free on npm, crates.io, Homebrew and PyPI, with no GitHub repository of that name (research 09, conclusion 22). The name appears only in `internal/buildinfo` and the release config, so a rename touches two places. |
| Licence | MIT |
| Evidence | Nine research reports in [`research/`](research/README.md) and the judged decisions in [`DECISIONS.md`](DECISIONS.md). Citations look like `[R04 §2b]` (report 04, section 2b) or `[R08 C3]` (report 08, conclusion 3). |

Conventions:
- **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are used in the RFC 2119 sense.
- `cli` always means one of the supported agentic CLIs: `claude`, `codex`, `agy`, `copilot`. Gemini CLI is out of scope (§1.3).
- Times on the wire are integer Unix epoch seconds, with RFC 3339 UTC strings next to them.
- Paths use `/` and `~`; on Windows read `%USERPROFILE%` for `~` and `\` for `/`.

---

## Contents

1. [Purpose, goals and non-goals](#1-purpose-goals-and-non-goals)
2. [Decisions at a glance (and why Go)](#2-decisions-at-a-glance-and-why-go)
3. [Glossary](#3-glossary)
4. [Supported platforms and CLIs](#4-supported-platforms-and-clis)
5. [Architecture](#5-architecture)
6. [On-disk layout and data model](#6-on-disk-layout-and-data-model)
7. [Secret storage (the vault)](#7-secret-storage-the-vault)
8. [CLI adapters](#8-cli-adapters)
9. [Rotation and limit-state engine](#9-rotation-and-limit-state-engine)
10. [Command-line interface](#10-command-line-interface)
11. [Output contract ("contract 1")](#11-output-contract-contract-1)
12. [Process execution (`exec`)](#12-process-execution-exec)
13. [Concurrency, locking and crash safety](#13-concurrency-locking-and-crash-safety)
14. [Security and privacy](#14-security-and-privacy)
15. [LimitShift integration](#15-limitshift-integration)
16. [Phase 2: interactive `run` wrapper](#16-phase-2-interactive-run-wrapper)
17. [Build, release, install and update](#17-build-release-install-and-update)
18. [Testing strategy](#18-testing-strategy)
19. [Repository layout and engineering rules](#19-repository-layout-and-engineering-rules)
20. [Licensing, clean room, provenance and provider terms](#20-licensing-clean-room-provenance-and-provider-terms)
21. [Milestones and acceptance criteria](#21-milestones-and-acceptance-criteria)
22. [Verification checklist (real machines and accounts)](#22-verification-checklist-real-machines-and-accounts)
- [Appendix A: environment variables per CLI](#appendix-a-environment-variables-per-cli)
- [Appendix B: vendor paths and credential slots per OS](#appendix-b-vendor-paths-and-credential-slots-per-os)
- [Appendix C: limit, auth and session signals per CLI](#appendix-c-limit-auth-and-session-signals-per-cli)
- [Appendix D: JSON schemas](#appendix-d-json-schemas)
- [Appendix E: exit codes](#appendix-e-exit-codes)
- [Appendix F: README notice (provider terms)](#appendix-f-readme-notice-provider-terms)

---
