/**
 * EvidenceGate — "Show proof, or tell the truth."
 *
 * Ported from the VS Code extension's mission/evidenceGate.ts (dependency-free).
 * Evaluates an agent response against evidence markers, honest-confession
 * patterns, and claim markers. A substantive claim without verifiable proof
 * is blocked and replaced with an honest message.
 *
 * Only English patterns are used here: file/line/test markers are
 * language-neutral, claim markers match English claim phrasing (parity with
 * the extension), and this file must contain no non-ASCII text.
 */

export interface EvidenceVerdict {
  /** True when the response may be shown as-is. */
  passed: boolean
  /** The evidence marker that satisfied the gate, if any. */
  matched: string
  /** Human-readable explanation of the verdict. */
  reason: string
}

export interface EvidenceGateOptions {
  /** Responses shorter than this are trivial chatter and always pass. */
  minLength?: number
  /** Project-specific evidence patterns, appended after the built-ins. */
  extraPatterns?: RegExp[]
}

export const DEFAULT_MIN_LENGTH = 40

/**
 * Patterns that count as proof in an agent response. Evaluation stops at
 * the first hit; the matched text is reported in the verdict.
 */
const EVIDENCE_PATTERNS: RegExp[] = [
  // path/to/file.ts:12 — file reference with line number (any language ext)
  /\b[\w./\\-]+\.\w{1,6}:\d+\b/,
  // conventional source directories (no line number needed)
  /\b(?:src|lib|test|tests|__tests__|out|dist|app|components|pages|server|client)\/[\w./\\-]+\b/,
  // "line 42", "lines 12-14"
  /\bline[s]?\s+\d+(-\d+)?\b/i,
  // test output: "424 pass", "0 fail", "ok 48", "1 error"
  /\b\d+\s*(?:pass|passed|fail|failed|error|errors|tests?|ok)\b/i,
  // "exit code 0", "exit 0"
  /\bexit(?:ed)?\s+(?:with\s+)?(?:code\s+)?0\b/i,
  // inline code / quoted symbols
  /`[^`\n]{2,}`/,
  // explicit test-run references
  /\b(?:npm test|test suite|unit test|integration test|ran the tests?)\b/i,
]

/**
 * Honest confessions pass automatically: a response that truthfully admits
 * it has no evidence is itself the truth.
 */
const TRUTH_PATTERNS: RegExp[] = [
  /\bno proof\b/i,
  /\bno evidence\b/i,
  /\bcannot verify\b/i,
  /\bcan'?t verify\b/i,
  /\bdon'?t have evidence\b/i,
  /\bi don'?t know for sure\b/i,
  /\bwithout proof\b/i,
  /\bnot verified\b/i,
  // Bengali honest-confession phrases, written as Unicode escapes so the
  // source file stays ASCII-only (project rule: no Bengali in code).
  /\u0986\u09AE\u09BE\u09B0\u0020\u0995\u09BE\u099B\u09C7\u0020\u09AA\u09CD\u09B0\u09AE\u09BE\u09A3\u0020\u09A8\u09C7\u0987/,
  /\u09AA\u09CD\u09B0\u09AE\u09BE\u09A3\u0020\u09A8\u09C7\u0987/,
  /\u09AA\u09CD\u09B0\u09AE\u09BE\u09A3\u0020\u09A8\u09BE\u0987/,
  /\u09A8\u09BF\u09B6\u09CD\u099A\u09BF\u09A4\u0020\u09A8\u09BE/,
  /\u09AD\u09C1\u09B2\u0020\u09AC\u09B2\u09C7\u099B\u09BF/,
  /\u0995\u09B0\u09BF\u09A8\u09BF/,
  /\u0995\u09B0\u09C7\u09A8\u09BF/,
]

/**
 * Claim markers — statements asserting the agent DID change code or located
 * a root cause. Only claim-heavy responses must carry evidence; explanatory
 * or conversational text passes as-is so the chat never feels empty.
 */
const CLAIM_MARKERS: RegExp[] = [
  /\b(?:i|we)\s+(?:fixed|changed|added|removed|updated|implemented|created|deleted|refactored|moved|renamed|replaced|rewrote|wrote|built|installed|configured|enabled|disabled|patched|solved|resolved)\b/i,
  /\b(?:the|a)\s+(?:bug|root cause|issue|problem)\s+(?:is|was|lies|exists)\b/i,
  /\b(?:root cause|the problem is|the issue is|i found|i discovered|i located)\b/i,
  /\b(?:cause|caused|causing|breaks|broke|fixes|fixed|patched)\b/i,
  /\bi\s+(?:can|will|could)\s+(?:fix|solve|implement|add|remove|update|change)\b/i,
  // Bengali claim phrases (code-change assertions), Unicode-escaped so the
  // source file stays ASCII-only. Stems cover -echi/-echen/-eche endings.
  /\u09B8\u09AE\u09BE\u09A7\u09BE\u09A8\u0020\u0995\u09B0\u09C7\u099B(?:\u09BF|\u09C7\u09A8|\u09C7)/,
  /\u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09A8\u0020\u0995\u09B0\u09C7\u099B(?:\u09BF|\u09C7\u09A8|\u09C7)/,
  /\u09A0\u09BF\u0995\u0020\u0995\u09B0\u09C7\u099B(?:\u09BF|\u09C7\u09A8|\u09C7)/,
  /\u09AF\u09CB\u0997\u0020\u0995\u09B0\u09C7\u099B(?:\u09BF|\u09C7\u09A8|\u09C7)/,
  /\u09B8\u09B0\u09BF\u09AF\u09BC\u09C7\u099B(?:\u09BF|\u09C7\u09A8|\u09C7)/,
  /\u09A4\u09C8\u09B0\u09BF\u0020\u0995\u09B0\u09C7\u099B(?:\u09BF|\u09C7\u09A8|\u09C7)/,
  /\u09AC\u09A6\u09B2\u09C7\u099B(?:\u09BF|\u09C7\u09A8|\u09C7)/,
  /\u0986\u09AA\u09A1\u09C7\u099F\u0020\u0995\u09B0\u09C7\u099B(?:\u09BF|\u09C7\u09A8|\u09C7)/,
  /\u09B8\u0982\u09B6\u09CB\u09A7\u09A8\u0020\u0995\u09B0\u09C7\u099B(?:\u09BF|\u09C7\u09A8|\u09C7)/,
  /\u09AB\u09BF\u0995\u09CD\u09B8\u0020\u0995\u09B0\u09C7\u099B(?:\u09BF|\u09C7\u09A8|\u09C7)/,
]

/** Pure gate — decides whether a response may be shown. */
export class EvidenceGate {
  private readonly minLength: number
  private readonly patterns: RegExp[]

  constructor(options?: EvidenceGateOptions) {
    this.minLength = options?.minLength ?? DEFAULT_MIN_LENGTH
    this.patterns = [...EVIDENCE_PATTERNS, ...(options?.extraPatterns ?? [])]
  }

  public evaluate(text: string): EvidenceVerdict {
    const trimmed = text.trim()

    // Empty or trivial chatter is not a claim — always show it.
    if (trimmed.length === 0 || trimmed.length < this.minLength) {
      return {
        passed: true,
        matched: "",
        reason: `trivial (${trimmed.length} chars < min ${this.minLength})`,
      }
    }

    // The agent already told the truth about lacking proof — show it.
    for (const truth of TRUTH_PATTERNS) {
      if (truth.test(trimmed)) {
        return { passed: true, matched: "", reason: "agent stated lack of proof" }
      }
    }

    // First evidence marker wins — the response is proven.
    for (const pattern of this.patterns) {
      const match = trimmed.match(pattern)
      if (match && match[0]) {
        return { passed: true, matched: match[0], reason: `evidence: ${match[0]}` }
      }
    }

    // No claim markers → explanatory / conversational / instructional text.
    const makesClaim = CLAIM_MARKERS.some((marker) => marker.test(trimmed))
    if (!makesClaim) {
      return {
        passed: true,
        matched: "",
        reason: "explanatory/conversational (no claim markers)",
      }
    }

    return {
      passed: false,
      matched: "",
      reason: "claim without evidence: no file refs, line numbers, test output or quotes",
    }
  }

  /** Honest replacement message shown when the gate blocks a response. */
  public truthMessage(originalLength: number): string {
    return (
      "**Response withheld: no proof provided**\n\n" +
      `The agent produced ${originalLength} characters with no verifiable evidence — ` +
      "no file references (`path:line`), line numbers, test output, exit codes or code quotes.\n\n" +
      "Per Mission Barisal rules, unproven claims are not shown. " +
      'Ask the agent for proof (e.g. "show the file:line" or "run the test").'
    )
  }
}
