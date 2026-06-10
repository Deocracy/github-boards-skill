// scripts/lib/profiles.mjs — per-skill source profiles. DATA ONLY, no logic.
//
// A profile tells the M3b sync pipeline three things about a skill's artifacts:
//   detect      — repo-relative dir whose presence activates the profile
//                 (null = always active)
//   watch       — glob patterns for the files that skill writes work items into
//                 (supported forms: literal path, or "<base>/**/*.<ext>")
//   hints       — prose handed to the LLM at extraction time (the LLM is the
//                 parser; this is the only place format knowledge lives)
//   doneSignals — how this skill marks completed work, so done items are skipped
//
// ORDER MATTERS: more-specific profiles first, `generic` LAST. A file matched by
// two profiles is attributed to the first match (hashWatched in board-manager).

export const PROFILES = [
  {
    name: 'superpowers',
    detect: 'docs/superpowers',
    watch: ['docs/superpowers/plans/**/*.md'],
    hints:
      'Each "### Task N:" heading in a plan is ONE candidate. The checkbox steps ' +
      'under a task are implementation detail, not separate candidates. ' +
      'Title = the task name after the colon. Use the plan Goal line or the ' +
      'linked spec for the note. A task whose checkbox steps are all "- [x]" is done.',
    doneSignals: ['every step under the task is "- [x]"', 'plan marked shipped/complete'],
  },
  {
    name: 'gsd',
    detect: '.planning',
    watch: ['.planning/**/*.md'],
    hints:
      'Files under .planning/ describe phases, milestones, and tasks. Each ' +
      'unfinished phase/milestone/task entry is ONE candidate at that level — ' +
      'not its individual steps. Title = the phase or task name. Use the stated ' +
      'goal for the note.',
    doneSignals: ['status: complete / shipped / done markers', '"- [x]"'],
  },
  {
    name: 'generic',
    detect: null, // always active
    watch: ['TODO.md', 'ROADMAP.md', 'BACKLOG.md'],
    hints:
      'Extract actionable work items. Each "- [ ]" checkbox line is one ' +
      'candidate; "- [x]" lines are done. Headings that clearly describe ' +
      'pending work may also be candidates. Title = the item text, trimmed.',
    doneSignals: ['"- [x]"'],
  },
];
