/**
 * zen-bridge — OpenCode plugin bridging the Mission Barisal server.
 *
 * The main server is never modified. This plugin sits entirely on the
 * client side and does two things for provider "missionbarisal":
 *
 *   1. context hook  — appends Mission Barisal output requirements to the
 *      system prompt (scoped to the provider, other providers unaffected).
 *   2. http.response hook — transport-level gate: SSE streams are
 *      normalized to authentic OpenAI chunk format (Platin normalizer),
 *      buffered from the first content delta, and evaluated by the
 *      evidence gate; unproven claims are replaced with an honest message.
 *
 * Scope guards: only "text/event-stream"/JSON bodies are touched, only
 * primary-flow requests are gated (titles/compaction pass untouched),
 * and every failure path leaves the original response in place.
 */

import { Plugin } from "@opencode/plugin"
import { EvidenceGate } from "./src/evidence-gate.ts"
import { REQUIREMENTS } from "./src/requirements.ts"
import { createGateTransform } from "./src/transport-gate.ts"
import { buildBlockedChunk, firstChoiceContent, normalizeChatChunk, type Json } from "./src/platin-normalizer.ts"
import { logRuntime, readBaseUrl, verifyConnection } from "./src/runtime-log.ts"

const PROVIDER_ID = "missionbarisal"
const log = (message: string): void => console.log(`[zen-bridge] ${message}`)

interface Disposable {
  dispose(): Promise<void>
}

export default Plugin.define({
  id: "zen-bridge",
  async setup(ctx) {
    const gate = new EvidenceGate()
    const registrations: Disposable[] = []

    // (1) Requirements injection — system prompt only, provider-scoped.
    registrations.push(
      await ctx.session.hook(
        "context",
        (event) => {
          event.system.push({ type: "text", text: REQUIREMENTS })
        },
        { providerID: PROVIDER_ID },
      ),
    )

    // (2) Transport-level response gate — provider-scoped, primary flow only.
    registrations.push(
      await ctx.session.hook(
        "http.response",
        async (event) => {
          if (event.kind !== "primary") return
          const original = event.response
          const contentType = original.headers.get("content-type") ?? ""

          if (contentType.includes("text/event-stream")) {
            if (!original.body) return
            const headers = new Headers(original.headers)
            headers.delete("content-length") // stream length changes after transform
            const stream = original.body.pipeThrough(createGateTransform(gate, log))
            event.response = new Response(stream, {
              status: original.status,
              statusText: original.statusText,
              headers,
            })
            return
          }

          if (contentType.includes("application/json") && original.body) {
            // One-shot body: read exactly once, then rebuild the response.
            let text: string
            try {
              text = await original.text()
            } catch (error) {
              log(`json body read failed: ${error instanceof Error ? error.message : String(error)}`)
              return
            }
            const headers = new Headers(original.headers)
            headers.delete("content-length")
            let body = text
            try {
              const parsed: unknown = JSON.parse(text)
              const chunk = normalizeChatChunk(parsed)
              const content = chunk ? firstChoiceContent(chunk) : undefined
              if (chunk && content !== undefined) {
                const verdict = gate.evaluate(content)
                log(`evidence gate (json): ${verdict.passed ? "PASSED" : "BLOCKED"} (${verdict.reason})`)
                if (verdict.passed) {
                  body = JSON.stringify(chunk)
                } else {
                  body = JSON.stringify(buildBlockedChunk(chunk, gate.truthMessage(content.length)))
                }
              }
            } catch {
              // Not a chat payload (error object, etc.) — pass through as-is.
            }
            event.response = new Response(body, {
              status: original.status,
              statusText: original.statusText,
              headers,
            })
          }
        },
        { providerID: PROVIDER_ID },
      ),
    )

    // (0) Runtime artefacts — written the moment the server boots, before
    //     any hook fires. Directory creation, the boot line and the
    //     connection probe are all failure-tolerant: if the runtime log is
    //     unwritable or the server is down, the bridge still starts.
    const bootLog = logRuntime(`boot provider=${PROVIDER_ID}`)
    const baseUrl = readBaseUrl(PROVIDER_ID)
    if (baseUrl === null) {
      logRuntime("connection skipped: no baseURL in config")
      log(`bridge active for provider "${PROVIDER_ID}" (connection not probed: no baseURL)`)
    } else {
      void verifyConnection(baseUrl).then((check) => {
        const status = check.status === null ? "-" : String(check.status)
        const detail = check.error === null ? "" : ` error=${check.error}`
        logRuntime(`connection ${check.ok ? "OK" : "FAILED"} ${check.url} status=${status} ${check.ms}ms${detail}`)
        log(`connection probe: ${check.ok ? "OK" : "FAILED"} ${check.url} status=${status} ${check.ms}ms${detail}`)
      })
      log(`bridge active for provider "${PROVIDER_ID}"`)
    }

    log(`runtime log: ${bootLog ?? "unavailable (logging skipped)"}`)

    return () => {
      for (const registration of registrations) {
        void registration.dispose().catch(() => undefined)
      }
    }
  },
})
