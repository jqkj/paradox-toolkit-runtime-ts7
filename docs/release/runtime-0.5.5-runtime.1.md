# Toolkit runtime / TS7 adaptation 0.5.5-runtime.1

Third-party preview based on upstream Toolkit 0.5.5 / LSP 0.3.8, commit
`4a3e210a74d40af91907f52753dd118f8fe8c3ea`. GPL-3.0-or-later, upstream credits retained.

## Changes

- Optional TS7 development typecheck alongside TS5.
- Consistent configurable top-level index exclusions, including incremental/open-document paths.
- Bounded, conservative token prefilter for lazy references, invalidated on edits.
- Resolved watcher roots and MCP/PI filesystem watching; preserve explicit unsaved buffers.
- Windows path normalization for mod inventory/override requests.
- Portable MCP/PI build without maintainer paths, plus isolated GitHub build and prerelease workflow.

## Evidence and limits

Local Windows runtime verification before portable packaging: 29/29 lifecycle checks,
47/47 scanner comparisons and 27/27 LSP response comparisons agreed with the defined baseline;
13 nonempty content assertions passed. Related suites reported 107 passed, 2 skipped
(Windows symlink privileges); these are not the entire upstream test suite.
The installed MCP bridge exposed 23 tools and passed edit/create/exclusion fixture checks.
Portable packaging verification: TS5 and TS7 typechecks, full lint and game-boundary checks passed;
five related LSP suites reported 101 passed and 2 skipped; both portable bridge tests passed.
The real project check returned 516,587 indexed definitions, 12 references for the selected
symbol and 38 overrides. The portable package has a separate synthetic MCP smoke test.

One local controlled indexing comparison: 12.593 s to 7.038 s (about 1.79x),
heap 445 to 280 MiB, peak RSS 1015 to 826 MiB. Exclusions change the indexed scope;
the smaller count is intentional, not evidence that every omitted file is irrelevant to every user.
Prefilter first-query setup was 4.255 s; subsequent sampled distinct-symbol queries took
33.6–219.6 ms. These are measurements on one machine, not a universal speed guarantee.
The prefilter is rebuilt after restart. TS7 development checks measured 9.784 s to
1.474 s median in a separate experiment; that does not measure game-source query speed.

Actual PI UI installation, full VS Code GUI behavior and GitHub-hosted workflow execution
remain to be verified. The source preserves other upstream functionality without claiming
every Toolkit feature has been revalidated or accelerated.
