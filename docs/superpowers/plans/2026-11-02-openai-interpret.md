# OpenAI Interpretation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure `/api/interpret` endpoint that streams GPT-6.1 Terra answers grounded in the current Zi Wei Dou Shu chart and conversation history.

**Architecture:** Keep the existing `ChatPanel` contract unchanged. A small pure helper module builds OpenAI Responses API payloads and parses upstream SSE; a Next.js route validates input, calls OpenAI server-side, and translates OpenAI deltas into the existing `{delta:{text}}` SSE shape.

**Tech Stack:** Next.js 16, TypeScript, native fetch, OpenAI Responses API, existing tsx regression runner.

**Spec:** `docs/superpowers/specs/2026-11-02-openai-interpret-design.md`

## Global Constraints
- Do not modify chart calculation logic.
- `OPENAI_API_KEY` must stay server-side.
- Default model is exactly `gpt-6.1-terra`; allow `OPENAI_MODEL` override.
- Preserve the existing ChatPanel SSE protocol.
- Do not add a new SDK dependency.

## Review Focus
- Missing API key returns a controlled server error rather than leaking configuration.
- Empty or malformed chart/messages requests are rejected before upstream calls.
- OpenAI streaming delta events are translated without losing text chunks.
- Non-text OpenAI stream events are ignored safely.
- Oversized request bodies are rejected with a bounded error.

---

### Task 1: Define interpretation helper behavior
**Files:**
- Create: `scripts/regression/openai-interpret.test.ts`
- Create: `lib/ai/interpret.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `DEFAULT_OPENAI_MODEL`, `buildOpenAIRequest`, `parseOpenAISseLine`.

- [ ] Add a failing regression test for model selection, chart/history inclusion, and SSE delta parsing.
- [ ] Run CI and confirm failure because the helper module does not exist.
- [ ] Implement the minimal helper module.
- [ ] Run CI and confirm typecheck/tests pass.

### Task 2: Add the server route
**Files:**
- Create: `app/api/interpret/route.ts`
- Modify: `scripts/regression/openai-interpret.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: helper exports from Task 1.
- Produces: `POST /api/interpret` matching the existing ChatPanel streaming contract.

- [ ] Extend tests for request validation helpers and stream translation behavior.
- [ ] Implement the route with server-only key access, input bounds, upstream error handling, and SSE translation.
- [ ] Document `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env.example`.
- [ ] Run full CI and inspect the PR diff.
