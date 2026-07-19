export const meta = {
  name: 'feature-factory',
  description: 'Build a feature from a PRD via a gated multi-agent loop: decompose → critique the plan → implement slice-by-slice → run the project quality gates → adversarial review → fix, looping until every gate is green and every acceptance criterion is checked. Stack-agnostic: gates, conventions, and review dimensions are supplied via args (resolved from a profile by the build-feature skill).',
  phases: [
    { title: 'Decompose', detail: 'Read PRD + code, produce a sliced plan with acceptance criteria' },
    { title: 'Critique plan', detail: 'Parallel panel hardens the plan before any code is written' },
    { title: 'Implement', detail: 'One agent per slice: dependent slices serialized, independent slices in parallel worktrees' },
    { title: 'Merge', detail: 'Apply worktree-isolated slices back to the main tree, fast-gating each' },
    { title: 'Gate', detail: 'Run the project quality gates' },
    { title: 'Audit', detail: 'Verify planned tests actually ran + changes stayed in scope' },
    { title: 'Acceptance', detail: 'Drive the running app (mobile-mcp) through the PRD acceptance criteria' },
    { title: 'Review', detail: 'Adversarial review by dimension, each finding verified' },
    { title: 'Fix', detail: 'Address confirmed findings + gate failures, then re-gate' },
  ],
}

// ---- args (resolved config, supplied by the build-feature skill) ----------
// Workflow({ scriptPath: '~/.claude/workflows/feature-factory.js', args: {
//   prd: 'path/to/prd.md', maxRounds: 3,
//   gates: { fast, snapshot?, e2e? }, gateNotes: {...},
//   conventions: '...', reviewDimensions: [{key, ask}], procedures: {...},
// }})
// args may arrive as a parsed object, a JSON string, or a bare PRD path string.
let cfg = args || {}
if (typeof cfg === 'string') {
  const s = cfg.trim()
  if (s.startsWith('{')) {
    try { cfg = JSON.parse(s) } catch (e) { throw new Error('feature-factory: args looks like JSON but failed to parse — ' + e.message) }
  } else {
    cfg = { prd: cfg }
  }
}
const PRD = cfg.prd
const MAX_ROUNDS = cfg.maxRounds || 3
if (!PRD) throw new Error('feature-factory: args.prd (path to the PRD markdown) is required')

const gates = cfg.gates || {}
const gateNotes = cfg.gateNotes || {}
const GATE_ORDER = ['fast', 'snapshot', 'e2e']
const activeGates = GATE_ORDER.filter(k => gates[k])
if (!gates.fast) throw new Error('feature-factory: args.gates.fast (the build+unit command) is required')

const CONVENTIONS = cfg.conventions ||
  'Match the surrounding code\'s naming, comment density, and idiom. Read neighboring files before adding anything. No new dependencies without strong justification.'

// Some repos keep the build tool in a subdir (e.g. Gradle root in android/).
const WORKDIR = cfg.workdir && cfg.workdir !== '.' ? cfg.workdir : null
const WORKDIR_NOTE = WORKDIR
  ? `\nIMPORTANT: run all build / gate / gradle commands from the \`${WORKDIR}/\` directory — that is the build-tool root, not the repo root.`
  : ''

// Optional model override (cfg.model, e.g. 'fable') for the VERIFICATION-LOOP
// agents: gate, audit, acceptance, review, verify, fix. Planning and impl
// agents deliberately keep their original opts so that resuming a run with a
// new cfg.model still cache-hits the completed plan and implementation slices
// (opts are part of the resume cache key); those agents inherit the session model.
const MODEL = cfg.model || null
const withModel = (o) => (MODEL ? { ...o, model: MODEL } : o)

const dimensions = (cfg.reviewDimensions && cfg.reviewDimensions.length) ? cfg.reviewDimensions : [
  { key: 'correctness', ask: 'Logic bugs, edge cases, null/empty/error handling, state that fails to reset between operations.' },
  { key: 'conventions', ask: 'Fits existing module structure and patterns, no dead code, no needless new dependencies.' },
  { key: 'test-coverage', ask: 'The added tests actually prove the acceptance criteria; nothing critical is left untested.' },
]

// ---- schemas --------------------------------------------------------------
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'slices', 'risks'],
  properties: {
    summary: { type: 'string', description: 'One-paragraph description of what will be built' },
    slices: {
      type: 'array',
      description: 'Ordered, independently-buildable increments. Order matters: earlier slices are dependencies of later ones.',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'title', 'intent', 'files', 'acceptance'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          intent: { type: 'string', description: 'What this slice does and why' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files/modules expected to be created or edited' },
          acceptance: { type: 'array', items: { type: 'string' }, description: 'Checkable acceptance criteria, each tied to a PRD requirement' },
          tests: { type: 'array', items: { type: 'string' }, description: 'Tests this slice must add or update' },
          independent: { type: 'boolean', description: 'true ONLY if this slice touches no file any other slice touches (tests included), depends on no other slice\'s changes, AND no other slice depends on its changes — it will be implemented concurrently in an isolated git worktree and merged back' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const CRITIQUE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lens', 'issues', 'verdict'],
  properties: {
    lens: { type: 'string' },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['problem', 'fix'], properties: { problem: { type: 'string' }, fix: { type: 'string' } } } },
    verdict: { type: 'string', enum: ['ship-as-is', 'revise', 'block'] },
  },
}

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['sliceId', 'status', 'filesTouched', 'notes'],
  properties: {
    sliceId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    fastGatePassed: { type: 'boolean' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'What was done, what remains, any gate output worth surfacing' },
  },
}

const GATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['green', 'results'],
  properties: {
    green: { type: 'boolean', description: 'true only if every required gate passed (or was legitimately skipped)' },
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['gate', 'status', 'detail'],
        properties: {
          gate: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'skipped'] },
          detail: { type: 'string', description: 'Failure summary, or why skipped / what needs human review' },
        },
      },
    },
  },
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['dimension', 'findings'],
  properties: {
    dimension: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'file', 'severity', 'why'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          why: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['real', 'reason'],
  properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
}

const ACCEPTANCE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['platform', 'deviceAvailable', 'results'],
  properties: {
    platform: { type: 'string' },
    deviceAvailable: { type: 'boolean', description: 'false if no emulator/simulator was available, or the mobile-mcp tools were not connected' },
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['criterion', 'status', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'blocked'], description: "blocked = could not be exercised (app didn't launch / device or mobile-mcp unavailable); never mark pass without observing the expected state on screen" },
          evidence: { type: 'string', description: 'the exact on-screen element text/label observed, or why it failed / was blocked' },
        },
      },
    },
  },
}

const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['unmetTests', 'scopeIssues'],
  properties: {
    unmetTests: {
      type: 'array',
      description: 'Planned tests / test-backed acceptance criteria that are NOT actually satisfied — file missing, OR present but the gate reported it NO-SOURCE / skipped so it never executed.',
      items: {
        type: 'object', additionalProperties: false, required: ['test', 'reason'],
        properties: { test: { type: 'string' }, reason: { type: 'string', description: 'e.g. "file absent" or "exists but NO-SOURCE — never ran under the gate"' } },
      },
    },
    scopeIssues: {
      type: 'array',
      description: 'Files changed on the branch that fall OUTSIDE the plan\'s declared files/modules.',
      items: {
        type: 'object', additionalProperties: false, required: ['file', 'justified', 'why'],
        properties: {
          file: { type: 'string' },
          justified: { type: 'boolean', description: 'true = a necessary, in-style incidental fix (e.g. a compile/render fix); false = unreviewed churn or scope creep (e.g. re-recorded snapshot goldens with no matching source change).' },
          why: { type: 'string' },
        },
      },
    },
  },
}

// ---- Phase 1: Decompose ---------------------------------------------------
phase('Decompose')
const plan = await agent(
  `Read the PRD at "${PRD}" and the relevant parts of this codebase, then produce an ordered, sliced implementation plan.
CONVENTIONS:
${CONVENTIONS}

Each slice must be independently buildable (the fast gate "${gates.fast}" must be able to pass at the end of each slice). Tie every acceptance criterion to a specific PRD requirement. Prefer 3–7 slices; a feature is one coherent narrative, so keep slices sequential where they share modules. If a slice's files (tests included) are FULLY disjoint from every other slice's AND no dependency runs in EITHER direction (it needs nothing from any other slice, and no other slice needs anything from it, at compile time or runtime), mark it independent: true — it will be implemented concurrently in an isolated git worktree and merged back. When in doubt leave it false: a wrong true costs a merge conflict, a wrong false only costs wall-clock.${WORKDIR_NOTE} Return the structured plan.`,
  { label: 'decompose-prd', phase: 'Decompose', schema: PLAN_SCHEMA },
)
log(`Plan: ${plan.slices.length} slices — ${plan.slices.map(s => s.id).join(', ')}`)

// ---- Phase 2: Critique the plan (parallel panel) --------------------------
phase('Critique plan')
const LENSES = [
  { key: 'architecture', ask: 'Does the plan fit the existing module boundaries, DI, app shell, and platform split? Flag anything that fights the codebase.' },
  { key: 'requirements', ask: 'Does every PRD requirement map to a slice + acceptance criterion? Flag missed or misread requirements.' },
  { key: 'test-strategy', ask: 'Will the planned tests actually prove the acceptance criteria across the available gates? Flag untestable criteria and missing test hooks.' },
]
const critiques = (await parallel(LENSES.map(l => () =>
  agent(`Critique this implementation plan through the "${l.key}" lens. ${l.ask}
CONVENTIONS:
${CONVENTIONS}
PLAN:
${JSON.stringify(plan, null, 2)}`,
    { label: `critique:${l.key}`, phase: 'Critique plan', schema: CRITIQUE_SCHEMA }),
))).filter(Boolean)

if (critiques.some(c => c.verdict === 'block')) log(`Plan blocked by ${critiques.filter(c => c.verdict === 'block').length} lens(es) — revising`)
let hardenedPlan = await agent(
  `Revise this implementation plan to resolve the critique issues. Keep the same slice structure where sound; fix what the panel flagged. Re-check each slice's independent flag under the disjointness rule (no file — tests included — shared with any other slice, no cross-slice dependency); clear the flag wherever revision created overlap. Return the improved plan.
ORIGINAL PLAN:
${JSON.stringify(plan, null, 2)}
CRITIQUES:
${JSON.stringify(critiques, null, 2)}`,
  { label: 'harden-plan', phase: 'Critique plan', schema: PLAN_SCHEMA },
)

// agent() returns null when the subagent dies on a terminal API error (e.g. an
// auth blip) — observed 2026-07-06 killing a whole run. Retry once before
// falling back to the unhardened plan.
if (!hardenedPlan) {
  log('⚠ harden-plan agent returned null (infra failure); retrying once')
  hardenedPlan = await agent(
    `Revise this implementation plan to resolve the critique issues. Keep the same slice structure where sound; fix what the panel flagged. Re-check each slice's independent flag under the disjointness rule (no file — tests included — shared with any other slice, no cross-slice dependency); clear the flag wherever revision created overlap. Return the improved plan.
ORIGINAL PLAN:
${JSON.stringify(plan, null, 2)}
CRITIQUES:
${JSON.stringify(critiques, null, 2)}`,
    { label: 'harden-plan:retry', phase: 'Critique plan', schema: PLAN_SCHEMA },
  )
}

// Guard: the harden step occasionally returns a DEGENERATE placeholder plan
// (e.g. summary "probe" with a single stub slice {id:"s1",title:"t",intent:"i",
// acceptance:["a"]}), which would silently collapse the whole build to one stub
// slice. Detect that and fall back to the original decompose plan.
const _isStubPlan = (p) =>
  !p || !Array.isArray(p.slices) || p.slices.length === 0 ||
  p.slices.some(s =>
    !s.title || String(s.title).trim().length <= 2 ||
    !s.intent || String(s.intent).trim().length <= 2 ||
    !Array.isArray(s.acceptance) || s.acceptance.length === 0 ||
    s.acceptance.every(a => String(a || '').trim().length <= 2))
if (_isStubPlan(hardenedPlan) || hardenedPlan.slices.length < plan.slices.length) {
  log(`⚠ harden-plan returned a degenerate/collapsed plan (${((hardenedPlan || {}).slices || []).length} slice(s) vs decompose's ${plan.slices.length}); keeping the original decompose plan`)
  hardenedPlan = plan
}

// Plan-only mode: stop after the plan is hardened (dry run / preview). No code
// is written, no gates run.
if (cfg.planOnly) {
  return {
    prd: PRD,
    planOnly: true,
    plan: hardenedPlan,
    critiques,
    note: 'Plan-only dry run — no code was written and no gates were run. Re-run without planOnly to build.',
  }
}

// ---- Phase 3: Implement — serial chain + parallel worktree slices ----------
// Dependent slices run SERIAL in the main tree: they share modules, and the
// fast gate needs one consistent tree. Slices the plan marked `independent`
// (file-disjoint from every other slice) run CONCURRENTLY, each in its own
// git worktree, and are merged back — re-proving the fast gate — before the
// full gates. Each slice self-fixes until the fast gate is green.
phase('Implement')
const serialSlices = hardenedPlan.slices.filter(s => !s.independent)
const indepSlices = hardenedPlan.slices.filter(s => s.independent)
if (indepSlices.length) log(`Parallel worktree slice(s): ${indepSlices.map(s => s.id).join(', ')} — serial chain: ${serialSlices.map(s => s.id).join(', ') || '(none)'}`)

const sliceImplPrompt = (slice) => `Implement slice "${slice.id}: ${slice.title}" in the CURRENT working tree.
CONVENTIONS:
${CONVENTIONS}
INTENT: ${slice.intent}
EXPECTED FILES: ${slice.files.join(', ')}
ACCEPTANCE CRITERIA (must all hold when you are done):
${slice.acceptance.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}
TESTS TO ADD/UPDATE: ${(slice.tests || []).join(', ') || '(decide what proves the criteria)'}

Read neighboring files first and match their style. After editing, run the fast gate:
    ${gates.fast}${WORKDIR_NOTE}
Fix anything red and re-run until it passes. Do NOT run the heavier gates here (a later phase runs the full suite). If you add user-facing UI, add the required test hook / testTag the way the codebase does.
Leave every change UNCOMMITTED — never git-commit: the Review phase reads the uncommitted diff, so a committed slice becomes invisible to review.
Report your result.`

// Extra contract for worktree-isolated slices: stay strictly in-scope, and
// report where the work lives so the merge agent can find it (worktreePath is
// required by the widened schema).
const INDEP_NOTE = `

ISOLATION: you are in your OWN git worktree (an isolated checkout of this repo); a later step merges your work into the main tree. Stay STRICTLY within the expected files and their tests — out-of-scope edits jeopardize the merge. When done, report the absolute path of your checkout's repo root (from \`pwd\`) as worktreePath, and do NOT remove the worktree yourself.`
const IMPL_INDEP_SCHEMA = {
  ...IMPL_SCHEMA,
  required: [...IMPL_SCHEMA.required, 'worktreePath'],
  properties: { ...IMPL_SCHEMA.properties, worktreePath: { type: 'string', description: 'Absolute path of the isolated git worktree this slice was implemented in' } },
}

// agent() returns null (not throw) when a subagent dies on a terminal API
// error — e.g. a connection dropped mid-response or a usage-limit wall — after
// its retries. Observed 2026-07-07 crashing the run at `res.status`. Synthesize
// a 'blocked' result (carrying the sliceId the final map needs) so one flaky
// slice can't kill the whole build: its partial edits stay on disk and the
// later Gate→Review→Fix loop verifies and completes the slice.
const blockedResult = (slice, where) => ({
  sliceId: slice.id, status: 'blocked', fastGatePassed: false, filesTouched: [],
  notes: `impl agent died on a terminal API error (null result); slice may be partially implemented${where} — the gate/review/fix loop must verify and complete it.`,
})

const implResults = []
// One barrier over the serial chain + every independent slice: wall-clock is
// max(chain, slowest independent), and the main tree is only ever edited by
// one agent at a time. Merges must NOT start before this barrier — a merge's
// fast-gate run would otherwise compile the serial chain's half-written code.
const implSettled = await parallel([
  async () => {
    for (const slice of serialSlices) {
      // Per-slice catch: a thrown agent() (background-and-end-turn on the long
      // fast gate, budget exhaustion) must not silently truncate the chain —
      // parallel() would swallow the thunk's throw into a null.
      let res = null
      try {
        res = await agent(sliceImplPrompt(slice), { label: `impl:${slice.id}`, phase: 'Implement', schema: IMPL_SCHEMA })
      } catch (e) {
        log(`⚠ impl:${slice.id} threw (${String((e && e.message) || e).slice(0, 100)}); marking blocked and continuing the chain`)
      }
      const safeRes = res || blockedResult(slice, '')
      implResults.push(safeRes)
      log(`Slice ${slice.id}: ${safeRes.status}${safeRes.fastGatePassed === false ? ' (fast gate NOT green)' : ''}`)
      if (safeRes.status === 'blocked') log(`⚠ ${slice.id} blocked: ${safeRes.notes}`)
    }
    return true
  },
  ...indepSlices.map(slice => () =>
    agent(sliceImplPrompt(slice) + INDEP_NOTE, { label: `impl:${slice.id}`, phase: 'Implement', isolation: 'worktree', schema: IMPL_INDEP_SCHEMA })),
])

// Belt for thunk-level failures the per-slice catch can't see: if the serial
// chain died early, keep every unattempted slice visible to the report and the
// fix loop instead of letting it vanish.
if (implSettled[0] !== true) {
  log('⚠ serial implementation chain aborted early; marking unattempted slices blocked')
  for (const slice of serialSlices) {
    if (!implResults.some(r => r.sliceId === slice.id)) {
      implResults.push({ ...blockedResult(slice, ''), notes: 'serial chain aborted before this slice ran; not attempted — the gate/review/fix loop must implement or surface it.' })
    }
  }
}

// ---- Phase 3b: merge worktree slices back into the main tree ---------------
// Serial among themselves (they all edit the main tree), after the barrier.
if (indepSlices.length) {
  phase('Merge')
  for (let i = 0; i < indepSlices.length; i++) {
    const slice = indepSlices[i]
    const impl = implSettled[i + 1] // [0] is the serial-chain thunk
    if (!impl) {
      implResults.push(blockedResult(slice, ' in an orphaned worktree (check `git worktree list`)'))
      log(`⚠ ${slice.id} blocked: impl agent died in its worktree`)
      continue
    }
    const mergePrompt = `Merge independently-implemented slice "${slice.id}: ${slice.title}" from its isolated git worktree into the MAIN working tree (your current directory).
WORKTREE: ${impl.worktreePath || '(not reported — find it via `git worktree list`: the checkout whose changes match the files below)'}
IMPLEMENTER'S REPORT: status=${impl.status}; files: ${(impl.filesTouched || []).join(', ') || '(none listed)'}; notes: ${impl.notes}

STEPS:
1. Sanity-check the worktree (exists, is a git checkout, \`git -C <wt> status\` shows the expected changes). An UNCHANGED worktree is auto-removed by the runtime — so if it is missing or clean AND the implementer reported done with little/no file work, verify the expected end state already holds in the main tree and report status=done with a "nothing to merge" note. Otherwise, if the work is genuinely absent, report status=blocked with what you found.
2. Extract its diff: \`git -C <wt> add -A && git -C <wt> diff --binary HEAD > <temp file>\`.
3. Apply it to the main tree from the repo root: \`git apply --3way <patch>\` (fall back to plain \`git apply\` if 3way balks on binaries). Conflicting hunks that are ONLY re-recorded snapshot/golden images with no source change in this slice: keep the MAIN tree's version and drop those hunks. Resolve any real conflict by hand, preserving both slices' intent. SAFETY: if a conflict's main-tree side contains uncommitted work the factory did not make this run (the user's pre-existing edits), that work MUST survive — never revert or delete it.
4. Run the fast gate and fix integration fallout until green:
    ${gates.fast}${WORKDIR_NOTE}
5. Remove the worktree: \`git worktree remove --force <wt>\` (if removal fails, say so in notes).
Do NOT git-commit anything — the Review phase reads the uncommitted diff.
Report with sliceId "${slice.id}": status=done ONLY if the slice's changes are fully present in the main tree and the fast gate is green.`
    // Same throw mode as the Gate step (agent backgrounds the long fast gate and
    // ends its turn without StructuredOutput): retry once foreground-only, then
    // degrade to blocked — never let one merge kill the workflow mid-tree.
    let merged = null
    try {
      merged = await agent(mergePrompt, { label: `merge:${slice.id}`, phase: 'Merge', schema: IMPL_SCHEMA })
    } catch (e) {
      log(`⚠ merge:${slice.id} threw (${String((e && e.message) || e).slice(0, 100)}); retrying with foreground-only instruction`)
      try {
        merged = await agent(mergePrompt + `
IMPORTANT: run every command in the FOREGROUND and wait for it to complete — do NOT background commands, and do NOT end your turn before reporting results via StructuredOutput.`,
          { label: `merge:${slice.id}:retry`, phase: 'Merge', schema: IMPL_SCHEMA })
      } catch (e2) {
        log(`⚠ merge:${slice.id} retry also threw; marking blocked`)
      }
    }
    const safeMerged = merged || {
      sliceId: slice.id, status: 'blocked', fastGatePassed: false, filesTouched: [],
      notes: `merge agent failed; the slice's work may still be unmerged in its worktree (${impl.worktreePath || 'path unknown'}) — the gate/review/fix loop must verify and complete the merge.`,
    }
    implResults.push(safeMerged)
    log(`Merge ${slice.id}: ${safeMerged.status}${safeMerged.fastGatePassed === false ? ' (fast gate NOT green)' : ''}`)
  }
}

// ---- Phases 4–6: Gate → Review → Fix, loop until green --------------------
const gateList = activeGates
  .map((k, i) => `${i + 1}. ${k}: ${gates[k]}${gateNotes[k] ? `\n   NOTE: ${gateNotes[k]}` : ''}`)
  .join('\n')

// Plan-derived expectations for the audit: what tests must actually run, and
// which files the change is allowed to touch.
const declaredTests = [...new Set(hardenedPlan.slices.flatMap(s => s.tests || []))]
const declaredFiles = [...new Set(hardenedPlan.slices.flatMap(s => s.files || []))]
// Paths the scope guard must ignore: factory infrastructure and known pre-existing
// noise (e.g. env-nondeterministic baselines). Repo overlay can extend via cfg.scopeIgnore.
const scopeIgnore = ['.claude/', ...(cfg.scopeIgnore || [])]
// Optional acceptance verification: drive the running app per platform via mobile-mcp.
const acceptanceTargets = cfg.acceptance ? Object.entries(cfg.acceptance) : []
const allAcceptance = [...new Set(hardenedPlan.slices.flatMap(s => s.acceptance || []))]

let round = 0
let gate = null
let confirmed = []
let minorFindings = []
let auditBlockers = []
let audit = { unmetTests: [], scopeIssues: [] }
let acceptance = []
let acceptanceBlockers = []
while (round < MAX_ROUNDS) {
  round++

  // -- Gate --
  phase('Gate')
  const gatePrompt = `Run the project quality gates below, in order, and report structured results per gate from the ACTUAL command output. Read repo docs if a command is unclear.
${gateList}${WORKDIR_NOTE}
green=true only if every gate is 'pass' or a legitimate 'skipped'. Never report pass without running the command.`
  try {
    gate = await agent(gatePrompt, withModel({ label: `gate:round-${round}`, phase: 'Gate', schema: GATE_SCHEMA }))
  } catch (e) {
    // Observed failure mode: an agent backgrounds a long gate command, arms a
    // Monitor, and ends its turn "until the run finishes" — but ending the turn
    // without StructuredOutput is terminal and kills the whole workflow. Retry
    // once with an explicit foreground-only instruction. The primary prompt is
    // kept byte-identical so resumes still cache-hit prior successful rounds.
    log(`⚠ gate agent failed (${String((e && e.message) || e).slice(0, 100)}); retrying with foreground-only instruction`)
    gate = await agent(gatePrompt + `
IMPORTANT: run every gate command in the FOREGROUND and wait for it to complete — do NOT background commands, do NOT use Monitor/wait-for-notification patterns, and do NOT end your turn before all gates have finished and you have reported results via StructuredOutput. Long-running commands are expected; simply wait for them.`,
      withModel({ label: `gate:round-${round}:retry`, phase: 'Gate', schema: GATE_SCHEMA }))
  }
  // agent() returns null (not throw) when a subagent dies on a terminal API
  // error — e.g. a usage-limit wall or an infra blip. Observed 2026-07-07
  // crashing the run at `gate.results`. Treat a missing result as a failed
  // round so the loop proceeds to Fix (which will run once the model is
  // reachable again) instead of throwing an unhandled null.
  if (!gate) {
    log('⚠ gate agent returned no result (model unavailable / usage limit); treating round as failed')
    gate = { green: false, results: [{ gate: '(all)', status: 'fail', detail: 'gate agent returned no result — model unavailable or usage limit reached' }] }
  }
  const gateFails = gate.results.filter(r => r.status === 'fail')
  log(`Round ${round} gate: ${gate.results.map(r => `${r.gate}=${r.status}`).join(' ')}`)

  // -- Audit: close the "false done" hole (a green gate does NOT prove the
  // planned tests ran, nor that the change stayed in scope). --
  phase('Audit')
  audit = await agent(
    `Audit the current working tree against the plan. Use git (git diff HEAD --name-only, git status --porcelain to include untracked files) and read files as needed.

GATE RESULTS from this round (the "gate output" referenced below):
${JSON.stringify(gate.results, null, 2)}

1. TEST COVERAGE — for each planned test below, confirm the test FILE exists AND that it actually RAN in the gate output above (not reported NO-SOURCE / skipped). A test that exists but was reported NO-SOURCE never executed — that is an unmet test. If unsure it ran, run that module's specific test task (e.g. ./gradlew :feature:<module>:testDebugUnitTest) and check it executed real test cases.${WORKDIR_NOTE}
Planned tests:
${declaredTests.map(t => '- ' + t).join('\n') || '- (none declared — instead verify every acceptance criterion that mentions a test is backed by a real, executed test)'}

2. SCOPE — list every changed file (tracked + untracked) that is NOT within the plan's declared files/modules below. For each, judge justified=true only if it is a necessary, in-style incidental fix (e.g. a compile or snapshot-render fix); justified=false for unreviewed churn or scope creep — especially re-recorded snapshot/golden images in a module with NO matching source change. A changed file in a module or app area the plan never touches (e.g. a web/ file for an Android-only feature), or an untracked file unrelated to the feature's domain, is almost certainly the user's PRE-EXISTING uncommitted work — mark it justified=true and NEVER suggest reverting or deleting it.
IGNORE these paths entirely — do NOT report them (factory infrastructure / known pre-existing noise): ${scopeIgnore.join(', ')}
Declared files/modules:
${declaredFiles.map(f => '- ' + f).join('\n') || '- (none declared)'}

Report structured findings.`,
    withModel({ label: `audit:round-${round}`, phase: 'Audit', schema: AUDIT_SCHEMA }),
  )
  // Same null-on-terminal-error guard as the gate step: keep the last good audit
  // (initialized to empty) rather than crashing on `audit.unmetTests`.
  if (!audit) {
    log('⚠ audit agent returned no result (model unavailable / usage limit); skipping audit for this round')
    audit = { unmetTests: [], scopeIssues: [] }
  }
  auditBlockers = [
    ...audit.unmetTests.map(t => ({ kind: 'test', title: t.test, detail: t.reason })),
    ...audit.scopeIssues.filter(s => !s.justified).map(s => ({ kind: 'scope', title: s.file, detail: s.why })),
  ]
  if (auditBlockers.length) log(`Round ${round} audit: ${audit.unmetTests.length} unmet test(s), ${audit.scopeIssues.filter(s => !s.justified).length} out-of-scope change(s)`)

  // -- Acceptance: drive the running app through the PRD criteria (mobile-mcp).
  // Only when the code gates are green (no point driving a broken build) and
  // targets are configured. 'blocked' (no device / mobile-mcp not connected)
  // degrades gracefully like an E2E skip; only 'fail' blocks green. --
  acceptance = []
  acceptanceBlockers = []
  if (acceptanceTargets.length && gate.green) {
    phase('Acceptance')
    acceptance = (await parallel(acceptanceTargets.map(([platform, t]) => () =>
      agent(
        `Acceptance-verify the built feature by DRIVING THE RUNNING APP on the ${platform} ${platform === 'ios' ? 'simulator' : 'emulator'}. Judge pass/fail from what you OBSERVE on screen, NOT from reading source code.

SETUP (run from the repo root; commands may cd as needed):
1. Device check — ${platform === 'ios' ? 'run `xcrun simctl list devices booted`' : 'run `adb devices`'}. If none is ready, set deviceAvailable=false, mark every criterion "blocked" (reason: no ${platform} device), and stop.
2. Load mobile automation — call ToolSearch with query "mobile" to load the mobile-mcp tools (mobile_launch_app, mobile_list_elements_on_screen, mobile_click_on_screen_at_coordinates, mobile_type_keys, mobile_swipe_on_screen, mobile_take_screenshot, mobile_press_button). If no mobile_* tools load, the mobile-mcp server is not connected — set deviceAvailable=false, mark every criterion "blocked" (reason: mobile-mcp not connected), and stop.
3. Install the app: ${t.install}
4. Launch it: mobile_launch_app with ${platform === 'ios' ? `bundleId "${t.bundleId}"` : `appId "${t.appId}"`}.

VERIFY — for EACH criterion below, drive the UI (list elements → tap / type / swipe) to exercise it and OBSERVE the outcome. status=pass ONLY if you observe the expected on-screen state (record the exact element text/label you saw as evidence); status=fail if the observed state contradicts the criterion; status=blocked if that screen couldn't be reached.
CRITERIA:
${allAcceptance.map((a, i) => `  ${i + 1}. ${a}`).join('\n') || '  (none — report deviceAvailable and an empty results list)'}

Report structured results with platform="${platform}".`,
        withModel({ label: `accept:${platform}:r${round}`, phase: 'Acceptance', schema: ACCEPTANCE_SCHEMA })),
    ))).filter(Boolean)
    acceptanceBlockers = acceptance.flatMap(r => r.results.filter(x => x.status === 'fail').map(x => ({ platform: r.platform, title: x.criterion, detail: x.evidence })))
    log(`Round ${round} acceptance: ${acceptance.map(r => `${r.platform}=${r.deviceAvailable ? r.results.filter(x => x.status === 'pass').length + '/' + r.results.length : 'blocked'}`).join(' ')}`)
  } else if (acceptanceTargets.length) {
    log(`Round ${round}: skipping acceptance — code gates not green yet`)
  }

  // -- Review (parallel dimensions → verify each finding) --
  phase('Review')
  const reviews = (await parallel(dimensions.map(d => () =>
    agent(`Adversarially review the UNCOMMITTED changes on this branch through the "${d.key}" lens.
Focus: ${d.ask}
CONVENTIONS:
${CONVENTIONS}
Inspect the diff with git and read the changed files. Report concrete findings with file paths. Do not invent problems; report an empty list if the code is clean on this dimension.`,
      withModel({ label: `review:${d.key}:r${round}`, phase: 'Review', schema: REVIEW_SCHEMA })),
  ))).filter(Boolean)

  const candidate = reviews.flatMap(r => r.findings.map(f => ({ ...f, dimension: r.dimension })))
  // Minor findings skip verification and the fix loop by design (not worth an
  // agent each), but they must not vanish: carry them into the result for the
  // human close-out instead of silently dropping them.
  minorFindings = candidate.filter(f => f.severity === 'minor')
  // Verify each non-minor finding with an independent skeptic; keep only the real ones.
  confirmed = (await parallel(candidate.filter(f => f.severity !== 'minor').map(f => () =>
    agent(`A reviewer claims this is a real problem in the current changes. Try to REFUTE it by reading the actual code. Default to real=false if you cannot confirm it.
FINDING: [${f.severity}] ${f.title}
FILE: ${f.file}
WHY: ${f.why}`,
      withModel({ label: `verify:${f.file}:r${round}`, phase: 'Review', schema: VERDICT_SCHEMA }))
      .then(v => (v && v.real ? { ...f, reason: v.reason } : null)),
  ))).filter(Boolean)

  log(`Round ${round}: ${gateFails.length} gate failure(s), ${auditBlockers.length} audit blocker(s), ${acceptanceBlockers.length} acceptance failure(s), ${confirmed.length} confirmed finding(s), ${minorFindings.length} minor (unverified, surfaced in result)`)

  // -- Exit only if gates green AND nothing outstanding (audit + acceptance + review) --
  if (gate.green && auditBlockers.length === 0 && acceptanceBlockers.length === 0 && confirmed.length === 0) {
    log(`✅ Green: gates pass, planned tests ran, in scope, acceptance verified, no confirmed findings (round ${round})`)
    break
  }
  if (round >= MAX_ROUNDS) {
    log(`⏹ Reached maxRounds (${MAX_ROUNDS}); stopping with open items`)
    break
  }

  // -- Fix (serial: one coherent tree) --
  phase('Fix')
  await agent(
    `Fix the following in the current working tree, then leave the tree in a state where the fast gate passes. Do NOT introduce regressions; keep changes minimal and in-style.
CONVENTIONS:
${CONVENTIONS}
GATE FAILURES:
${gateFails.map(r => `- ${r.gate}: ${r.detail}`).join('\n') || '(none)'}
UNMET / UNRUN TESTS (write the missing test, or make the existing one actually execute — a NO-SOURCE test is not done):
${auditBlockers.filter(b => b.kind === 'test').map(b => `- ${b.title} — ${b.detail}`).join('\n') || '(none)'}
OUT-OF-SCOPE CHANGES (files the FACTORY changed outside the plan. SAFETY: NEVER revert or delete a file — no 'git checkout', 'git restore', 'git stash', or 'rm' — unless YOU created it in THIS run. Untracked files and edits in modules the feature never touches are the USER'S pre-existing uncommitted work; leave them exactly as-is even if listed here. You may tidy churn the factory itself introduced, but do NOT re-record snapshot goldens without a matching source change):
${auditBlockers.filter(b => b.kind === 'scope').map(b => `- ${b.title} — ${b.detail}`).join('\n') || '(none)'}
ACCEPTANCE FAILURES (the running app did not behave as the criterion requires — fix the behavior, not the test):
${acceptanceBlockers.map(b => `- [${b.platform}] ${b.title} — observed: ${b.detail}`).join('\n') || '(none)'}
CONFIRMED REVIEW FINDINGS:
${confirmed.map(f => `- [${f.severity}][${f.dimension}] ${f.title} (${f.file}) — ${f.why}`).join('\n') || '(none)'}
After fixing, run "${gates.fast}" and ensure it is green. Leave everything UNCOMMITTED (no git commit) — the next round's Review reads the uncommitted diff.${WORKDIR_NOTE}`,
    withModel({ label: `fix:round-${round}`, phase: 'Fix', schema: IMPL_SCHEMA }),
  )
}

// ---- Result ---------------------------------------------------------------
return {
  prd: PRD,
  plan: hardenedPlan.summary,
  // Worktree slices produce an impl entry AND a merge entry with the same
  // sliceId — keep the LAST per id (the merge outcome supersedes the isolated
  // impl) so the report shows one row per slice.
  slices: [...new Map(implResults.map(r => [r.sliceId, r])).values()].map(r => ({ id: r.sliceId, status: r.status })),
  rounds: round,
  finalGate: gate ? gate.results : [],
  green: !!(gate && gate.green && auditBlockers.length === 0 && acceptanceBlockers.length === 0 && confirmed.length === 0),
  openFindings: confirmed,
  minorFindings,
  unmetTests: audit.unmetTests,
  outOfScopeChanges: audit.scopeIssues,
  acceptance,
  procedures: cfg.procedures || {},
  note: 'Review any newly recorded snapshot baselines by eye. Run any gates this factory skipped (e.g. iOS, no-emulator E2E) before release.',
}
