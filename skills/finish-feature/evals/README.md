# finish-feature evals

`evals.json` holds three test cases for the skill-creator eval loop; each
references a fixture repo via its `files` field (`fixtures/fixture-a`,
`fixtures/fixture-b`).

The fixtures are **tiny self-contained git repos** (a fake project with shipped
`session-notes`, unshipped `idle-timer`, and — in fixture-b — an already-archived
`searchbox`). They ship as a tarball because nested `.git` directories can't be
tracked by the outer repo:

```bash
cd ~/.claude/skills/finish-feature/evals
tar -xzf fixtures.tar.gz     # yields fixtures/fixture-a and fixtures/fixture-b
```

Extract before running the evals; `files` paths resolve relative to this
directory. The fixture commits (`537b328`, `8a10a32`, neutral
`Fixture <fixture@test.local>` identity) are the ones the assertions cite.

Result from the 2026-07-04 run (iteration-1): with-skill 20/20 assertions vs
baseline 16/20; the delta is format consistency + docs-only commit discipline.
The refuse-to-archive-unshipped case is non-discriminating (the base model also
refuses) — kept anyway because it guards the skill's one destructive edge.
