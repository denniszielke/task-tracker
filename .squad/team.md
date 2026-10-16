# Squad Team

> task-tracker

## Coordinator

| Name | Role | Notes |
|------|------|-------|
| Squad | Coordinator | Routes work, enforces handoffs and reviewer gates. |

## Members

| Name | Role | Charter | Status |
|------|------|---------|--------|
| Lead | Lead | [charter](agents/lead/charter.md) | Active |
| Backend | Backend Developer | [charter](agents/backend/charter.md) | Active |
| Frontend | Frontend Developer | [charter](agents/frontend/charter.md) | Active |
| Tester | Tester | [charter](agents/tester/charter.md) | Active |
| Scribe | Session Logger & Memory Manager | [charter](agents/scribe/charter.md) | Silent support |
| Ralph | Work Queue Monitor | [charter](agents/ralph/charter.md) | Monitor support |


## Coding Agent

<!-- copilot-auto-assign: false -->

| Name | Role | Charter | Status |
|------|------|---------|--------|
| @copilot | Coding Agent | — | 🤖 Coding Agent |

### Capabilities

**🟢 Good fit — auto-route when enabled:**
- Bug fixes with clear reproduction steps
- Test coverage (adding missing tests, fixing flaky tests)
- Lint/format fixes and code style cleanup
- Dependency updates and version bumps
- Small isolated features with clear specs
- Boilerplate/scaffolding generation
- Documentation fixes and README updates

**🟡 Needs review — route to @copilot but flag for squad member PR review:**
- Medium features with clear specs and acceptance criteria
- Refactoring with existing test coverage
- API endpoint additions following established patterns
- Migration scripts with well-defined schemas

**🔴 Not suitable — route to squad member instead:**
- Architecture decisions and system design
- Multi-system integration requiring coordination
- Ambiguous requirements needing clarification
- Security-critical changes (auth, encryption, access control)
- Performance-critical paths requiring benchmarking
- Changes requiring cross-team discussion

## Project Context

- **Project:** task-tracker
- **Owner:** denniszielke
- **Application:** Vehicle pickup order tracker
- **Stack:** React 19, Vite 8, JavaScript, Node.js
- **Created:** 2026-10-06
