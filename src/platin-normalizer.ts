/**
 * Platin normalizer — converts provider SSE payloads into the authentic
 * OpenAI `chat.completion.chunk` shape that OpenCode's drivers expect.
 *
 * Pure functions only: no I/O, no shared state, no side effects.
 * Unknown or unparseable payloads are returned untouched upstream
 * (pass-through) rather than dropped, so the bridge never loses data.
 */

export type Json = Record<string, unknown>

const CHUNK_OBJECT = "chat.completion.chunk"

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Normalize one parsed SSE data payload.
 * Returns a normalized chunk, or null when the payload is not an object
 * (caller passes the original raw event through unchanged).
 */
export function normalizeChatChunk(input: unknown): Json | null {
  if (!isObject(input)) return null
  const chunk: Json = { ...input }

  // Non-standard payload shapes → build an OpenAI-compatible choices array.
  if (!Array.isArray(chunk.choices)) {
    const flat =
      pickString(chunk, ["text", "content"]) ??
      pickNestedString(chunk, "message", "content") ??
      pickNestedString(chunk, "delta", "content")
    delete chunk.text
    delete chunk.content
    delete chunk.message
    chunk.choices = flat !== undefined
      ? [{ index: 0, delta: { content: flat }, finish_reason: null }]
      : []
  }

  // Enforce the fields OpenCode's chunk parser relies on.
  chunk.object = CHUNK_OBJECT
  if (typeof chunk.created !== "number") {
    chunk.created = Math.floor(Date.now() / 1000)
  }
  if (!Array.isArray(chunk.id) && typeof chunk.id !== "string") {
    // No id supplied by the provider: omit it rather than fabricate one.
    delete chunk.id
  }

  chunk.choices = (chunk.choices as unknown[]).map((entry, position) =>
    normalizeChoice(entry, position),
  )
  return chunk
}

function normalizeChoice(entry: unknown, position: number): Json {
  const choice: Json = isObject(entry) ? { ...entry } : {}
  if (typeof choice.index !== "number") choice.index = position

  if (!isObject(choice.delta)) {
    // Non-stream shape (`message`) delivered inside a stream event.
    const source = isObject(choice.message) ? choice.message : {}
    delete choice.message
    choice.delta = { ...source }
  }

  const delta = choice.delta as Json
  if (delta.content !== undefined && typeof delta.content !== "string") {
    delta.content = isObject(delta.content)
      ? JSON.stringify(delta.content)
      : String(delta.content)
  }

  if (choice.finish_reason === undefined) choice.finish_reason = null
  return choice
}

/** Content of the first choice when present and non-empty, else undefined. */
export function firstChoiceContent(chunk: Json): string | undefined {
  const choices = chunk.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (!isObject(first) || !isObject(first.delta)) return undefined
  const content = first.delta.content
  return typeof content === "string" && content.length > 0 ? content : undefined
}

/**
 * Rebuild a blocked response: the first choice carries the honest message,
 * later choices keep their shape with content cleared. Structure (id, model,
 * created, role fields) is preserved from the original chunk.
 */
export function buildBlockedChunk(original: Json, truthMessage: string): Json {
  const chunk: Json = { ...original }
  const source = Array.isArray(original.choices) ? original.choices : []
  const mapped = source.map((entry, position) => {
    const choice: Json = isObject(entry) ? { ...entry } : { index: position }
    if (typeof choice.index !== "number") choice.index = position
    const delta: Json = isObject(choice.delta) ? { ...choice.delta } : {}
    delta.content = position === 0 ? truthMessage : ""
    choice.delta = delta
    if (choice.finish_reason === undefined) choice.finish_reason = null
    return choice
  })
  chunk.choices = mapped.length > 0
    ? mapped
    : [{ index: 0, delta: { content: truthMessage }, finish_reason: null }]
  return chunk
}

function pickString(source: Json, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function pickNestedString(source: Json, parent: string, key: string): string | undefined {
  const value = source[parent]
  if (isObject(value)) {
    const inner = value[key]
    if (typeof inner === "string" && inner.length > 0) return inner
  }
  return undefined
}
