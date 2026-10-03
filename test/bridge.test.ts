/**
 * Unit tests for the zen-bridge plugin modules.
 * Run: node --test bridge.test.ts  (Node >= 22.6 strips types natively)
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { EvidenceGate } from "../src/evidence-gate.ts"
import { buildBlockedChunk, firstChoiceContent, normalizeChatChunk } from "../src/platin-normalizer.ts"
import { createGateTransform } from "../src/transport-gate.ts"

const gate = new EvidenceGate()

function chunk(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...extra,
  }
}

async function pump(events: string[]): Promise<string> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    },
  })
  const stream = source.pipeThrough(createGateTransform(gate, () => undefined))
  const reader = stream.getReader()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
const DONE = "data: [DONE]\n\n"

test("gate blocks a claim without evidence", () => {
  const verdict = gate.evaluate(
    "I fixed the bug and the issue is resolved now, everything works again properly.",
  )
  assert.equal(verdict.passed, false)
})

test("gate passes a claim with file:line evidence", () => {
  const verdict = gate.evaluate(
    "Fixed the crash in src/server/handler.ts:42 — null check added before dispatch.",
  )
  assert.equal(verdict.passed, true)
})

test("gate passes honest confession of no proof", () => {
  const verdict = gate.evaluate(
    "I have no proof for this claim, no evidence was collected during the run.",
  )
  assert.equal(verdict.passed, true)
})

test("gate passes short/trivial chatter", () => {
  assert.equal(gate.evaluate("ok done").passed, true)
})

test("normalizer maps flat text payload to OpenAI chunk", () => {
  const out = normalizeChatChunk({ text: "hello" })
  assert.ok(out)
  assert.equal(out.object, "chat.completion.chunk")
  assert.equal(firstChoiceContent(out), "hello")
  assert.equal((out.choices as { finish_reason: unknown }[])[0].finish_reason, null)
})

test("normalizer preserves standard chunks", () => {
  const out = normalizeChatChunk(chunk("hi"))
  assert.ok(out)
  assert.equal(firstChoiceContent(out), "hi")
})

test("blocked chunk keeps structure and carries truth message", () => {
  const out = buildBlockedChunk(normalizeChatChunk(chunk("lie"))!, "TRUTH")
  const choices = out.choices as { delta: { content: string } }[]
  assert.equal(choices[0].delta.content, "TRUTH")
  assert.equal(out.model, "test")
})

test("transport: proven SSE passes through unchanged in order", async () => {
  const out = await pump([
    sse(chunk("I fixed ")),
    sse(chunk("the file at src/app.ts:12")),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    DONE,
  ])
  assert.match(out, /src\/app\.ts:12/)
  assert.match(out, /finish_reason":"stop"/)
  assert.ok(out.endsWith(DONE))
})

test("transport: unproven claim is replaced with honest message", async () => {
  const out = await pump([
    sse(chunk("I fixed everything and the problem is solved, trust me on this.")),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    DONE,
  ])
  assert.doesNotMatch(out, /trust me on this/)
  assert.match(out, /no proof provided/)
  assert.match(out, /finish_reason":"stop"/)
  assert.ok(out.endsWith(DONE))
})

test("transport: non-JSON data and raw lines pass through", async () => {
  const out = await pump(["data: not-json at all\n\n", ": comment line\n\n", DONE])
  assert.match(out, /not-json at all/)
  assert.match(out, /comment line/)
})

test("transport: stream without [DONE] still finalizes gate", async () => {
  const out = await pump([sse(chunk("I changed the config and fixed the bug completely."))])
  assert.match(out, /no proof provided/)
})

// --- Bengali (Unicode-escaped) pattern coverage ---

const BN_TRUTH = "\u0986\u09AE\u09BE\u09B0 \u0995\u09BE\u099B\u09C7 \u09AA\u09CD\u09B0\u09AE\u09BE\u09A3 \u09A8\u09C7\u0987 \u0987\u0981\u0996 \u09A8\u09BF\u09B6\u09CD\u099A\u09BF\u09A4\u09A4\u09BE \u09A6\u09C7\u0996\u09BE\u09B2\u09C1\u09AE \u09A8\u09BE\u0964"
const BN_CLAIM = "\u0986\u09AE\u09BF \u09B2\u0997\u09BF\u09A8 \u09AC\u0997\u0995\u09CD\u09B8 \u09A0\u09BF\u0995 \u0995\u09B0\u09C7\u099B\u09BF \u098F\u09AC\u0982 \u09A1\u09C7\u099F\u09C7\u09AC\u09C7\u09B8 \u09B9\u09CD\u09AF\u09BE\u09A8\u09A1\u09B2\u09B0 \u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09A8 \u0995\u09B0\u09C7\u099B\u09BF\u0964 \u09B8\u09AE\u09B8\u09CD\u09AF\u09BE \u09B8\u09AE\u09BE\u09A7\u09BE\u09A8 \u0995\u09B0\u09C7 \u09AB\u09C7\u09B2\u09C7 \u0997\u09C7\u09B2\u09C7\u099B\u09C7\u0964"

test("gate blocks Bengali claim without evidence", () => {
  assert.equal(gate.evaluate(BN_CLAIM).passed, false)
})

test("gate passes Bengali honest confession", () => {
  assert.equal(gate.evaluate(BN_TRUTH).passed, true)
})
