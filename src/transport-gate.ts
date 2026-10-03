/**
 * Transport-level evidence gate for provider SSE streams.
 *
 * Runs inside the http.response hook, between the Mission Barisal provider
 * and OpenCode's driver:
 *
 *   - The response body is ONE-SHOT: this transform consumes the original
 *     stream and the caller replaces the Response with a new one wrapping
 *     the transformed stream (never reads the body twice).
 *   - Role/reasoning/tool events stream live until the first content delta;
 *     from there events are held (original order preserved) until [DONE],
 *     then the gate decides: flush as-is or replace the text with the
 *     honest "no proof" message.
 *   - Bounded memory: held bytes are capped; on overflow the gate FAILS
 *     OPEN (flush + passthrough) — a slow/oversized response is never
 *     buffered without limit.
 *   - All state lives in the closure of one transform instance and is
 *     released when the stream ends. No timers, no globals, no retries.
 *   - Unparseable payloads and non-SSE events pass through byte-for-byte
 *     (normalized only when they are chat chunks); the bridge never drops
 *     data it does not understand.
 */

import { EvidenceGate } from "./evidence-gate.ts"
import {
  buildBlockedChunk,
  firstChoiceContent,
  normalizeChatChunk,
  type Json,
} from "./platin-normalizer.ts"

/** Upper bound for buffered events; beyond this the gate fails open. */
const MAX_HELD_BYTES = 2_000_000

const EVENT_SEPARATOR = /\r?\n\r?\n/
const LINE_SEPARATOR = /\r?\n/
const DONE_PAYLOAD = "[DONE]"

type Controller = ReadableStreamDefaultController<Uint8Array>
type Logger = (message: string) => void

interface HeldEvent {
  /** Serialized SSE event including trailing newlines. */
  raw: string
  /** Normalized chunk when the payload was a chat chunk, else null. */
  chunk: Json | null
}

export function createGateTransform(gate: EvidenceGate, log: Logger): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  let pending = ""
  let holding = false
  let gated = true
  let finished = false
  let held: HeldEvent[] = []
  let heldBytes = 0
  let fullText = ""

  const emit = (controller: Controller, text: string): void => {
    try {
      controller.enqueue(encoder.encode(text))
    } catch {
      // Consumer cancelled the stream — stop enqueueing; the transform
      // instance is discarded with the response, nothing leaks.
    }
  }

  const routeRaw = (controller: Controller, rawEvent: string): void => {
    const serialized = `${rawEvent}\n\n`
    if (holding) {
      hold({ raw: serialized, chunk: null })
    } else {
      emit(controller, serialized)
    }
  }

  const hold = (event: HeldEvent): void => {
    held.push(event)
    heldBytes += event.raw.length
    if (heldBytes > MAX_HELD_BYTES) {
      heldOverflow = true
    }
  }

  let heldOverflow = false

  const emitHeld = (controller: Controller, truthMessage?: string): void => {
    if (truthMessage === undefined) {
      for (const event of held) emit(controller, event.raw)
    } else {
      let replaced = false
      for (const event of held) {
        if (event.chunk === null) {
          emit(controller, event.raw)
          continue
        }
        if (firstChoiceContent(event.chunk) === undefined) {
          emit(controller, event.raw)
          continue
        }
        if (!replaced) {
          emit(controller, `data: ${JSON.stringify(buildBlockedChunk(event.chunk, truthMessage))}\n\n`)
          replaced = true
          continue
        }
        // Later content-only chunks are dropped; events carrying other
        // fields (finish_reason, usage, role) stay with content stripped.
        const stripped = stripContent(event.chunk)
        if (isMeaningful(stripped)) {
          emit(controller, `data: ${JSON.stringify(stripped)}\n\n`)
        }
      }
    }
    held = []
    heldBytes = 0
  }

  const finalize = (controller: Controller, withDone: boolean): void => {
    if (finished) return
    finished = true

    if (holding && gated) {
      const verdict = gate.evaluate(fullText)
      log(`evidence gate: ${verdict.passed ? "PASSED" : "BLOCKED"} (${verdict.reason})`)
      if (verdict.passed) {
        emitHeld(controller)
      } else {
        emitHeld(controller, gate.truthMessage(fullText.length))
      }
    } else if (held.length > 0) {
      emitHeld(controller)
    }

    holding = false
    if (withDone) emit(controller, `data: ${DONE_PAYLOAD}\n\n`)
  }

  const handleEvent = (controller: Controller, rawEvent: string): void => {
    const dataLines = rawEvent
      .split(LINE_SEPARATOR)
      .filter((line) => line.startsWith("data:"))

    if (dataLines.length === 0) {
      routeRaw(controller, rawEvent)
      return
    }

    const payload = dataLines
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim()

    if (payload === DONE_PAYLOAD) {
      finalize(controller, true)
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      // Not JSON — pass the original bytes through unchanged.
      routeRaw(controller, rawEvent)
      return
    }

    const chunk = normalizeChatChunk(parsed)
    if (chunk === null) {
      routeRaw(controller, rawEvent)
      return
    }

    if (!gated) {
      emit(controller, `data: ${JSON.stringify(chunk)}\n\n`)
      return
    }

    const content = firstChoiceContent(chunk)
    if (content !== undefined) {
      holding = true
      fullText += content
    }

    const serialized = `data: ${JSON.stringify(chunk)}\n\n`
    if (holding) {
      hold({ raw: serialized, chunk })
      if (heldOverflow) {
        log(`evidence gate: FAIL-OPEN (held ${heldBytes} bytes > cap ${MAX_HELD_BYTES})`)
        emitHeld(controller)
        gated = false
        holding = false
      }
    } else {
      emit(controller, serialized)
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      const parts = pending.split(EVENT_SEPARATOR)
      pending = parts.pop() ?? ""
      for (const part of parts) {
        if (part.trim().length > 0) handleEvent(controller, part)
      }
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending.trim().length > 0 && !finished) {
        handleEvent(controller, pending)
      }
      // Stream closed without [DONE] — still honor the gate decision.
      finalize(controller, false)
    },
  })
}

/** Remove content from every choice of a chunk (keeps all other fields). */
function stripContent(chunk: Json): Json {
  const clone: Json = { ...chunk }
  if (!Array.isArray(clone.choices)) return clone
  clone.choices = clone.choices.map((entry) => {
    if (typeof entry !== "object" || entry === null) return entry
    const choice: Json = { ...(entry as Json) }
    if (typeof choice.delta === "object" && choice.delta !== null) {
      const delta: Json = { ...(choice.delta as Json) }
      delete delta.content
      choice.delta = delta
    }
    return choice
  })
  return clone
}

/** True when a content-stripped chunk still carries meaningful state. */
function isMeaningful(chunk: Json): boolean {
  if (chunk.usage !== undefined && chunk.usage !== null) return true
  const choices = chunk.choices
  if (!Array.isArray(choices)) return false
  return choices.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false
    const choice = entry as Json
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) return true
    const delta = choice.delta
    return typeof delta === "object" && delta !== null && Object.keys(delta).length > 0
  })
}
