#!/bin/sh
# Assemble SPEC.md and DECISIONS.md from the part files (order matters).
set -e
cd "$(dirname "$0")"
cat 00-front.md 01-purpose.md 02-decisions.md 03-glossary-platforms-arch.md 06-data.md 07-vault.md \
    08a-adapters-claude-codex.md 08b-adapter-agy.md 08c-adapters-tier2.md 09-engine.md 10-cli-contract.md \
    12-exec-lock-security.md 15-limitshift.md 16-17-run-release.md 18-22.md 90-appendices.md > ../SPEC.md
cat D-head.md D-03.md D-04.md D-06.md D-07.md D-08.md D-10.md D-11.md > ../DECISIONS.md
wc -l -w ../SPEC.md ../DECISIONS.md
