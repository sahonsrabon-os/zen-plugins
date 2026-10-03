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
  // Inline code that carries a checkable reference: `handler.ts`,
  // `src/app.ts:42`, `424 pass`. A bare `symbolName` is decoration, not
  // evidence, and no longer satisfies the gate — otherwise a response can
  // be waved through by emitting any backtick span at all.
  /`[^`\n]*(?:\.\w{1,6}(?::\d+)?|\b\d+\s*(?:pass|passed|fail|failed|ok|tests?|errors?)\b)[^`\n]*`/,
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
 * Bengali conjugation tail shared by every claim verb: -echi / -echen /
 * -eche. Declension is not a hiding place for an unproven claim.
 * Written with double backslashes so this source file stays ASCII-only
 * (project rule: no Bengali characters in code files).
 */
const BN_TAIL = "(?:\\u09BF|\\u09C7\\u09A8|\\u09C7)"

/**
 * `<verb> + korechi|koren|kore` — the standard Bengali perfective claim
 * ("I solved / I have solved / I solved it"). Both arguments and the verb
 * are supplied as \u escapes; the literal space between them is widened to
 * `\s+` so a newline or tab cannot hide the claim.
 */
const bnKorechi = (verb: string): RegExp =>
  new RegExp(verb.replace(/ /g, "\\s+") + "\\s+" + "\\u0995\\u09B0\\u09C7\\u099B" + BN_TAIL, "i")

/**
 * Bare perfective stem used where no `korechi` helper fits: "likhechi",
 * "muliye feleche", "lekha hoyeche". Same tail, same space widening.
 */
const bnStem = (stem: string): RegExp =>
  new RegExp(stem.replace(/ /g, "\\s+") + BN_TAIL, "i")

/**
 * Claim markers — statements asserting the agent DID change code or located
 * a root cause. Only claim-heavy responses must carry evidence; explanatory
 * or conversational text passes as-is so the chat never feels empty.
 *
 * The Bengali list is kept at parity with the English list: language must
 * not decide whether an unproven claim is blocked. English "I installed X"
 * is a claim, so Bengali "install korechi" must be a claim as well.
 */
const CLAIM_MARKERS: RegExp[] = [
  /\b(?:i|we)\s+(?:fixed|changed|added|removed|updated|implemented|created|deleted|refactored|moved|renamed|replaced|rewrote|wrote|built|installed|configured|enabled|disabled|patched|solved|resolved)\b/i,
  /\b(?:the|a)\s+(?:bug|root cause|issue|problem)\s+(?:is|was|lies|exists)\b/i,
  /\b(?:root cause|the problem is|the issue is|i found|i discovered|i located)\b/i,
  /\b(?:cause|caused|causing|breaks|broke|fixes|fixed|patched)\b/i,
  /\bi\s+(?:can|will|could)\s+(?:fix|solve|implement|add|remove|update|change)\b/i,
  // --- Bengali: "<verb> korechi" forms, kept at English parity ------------
  bnKorechi("\u09B8\u09AE\u09BE\u09A7\u09BE\u09A8"), // samadhan     solve
  bnKorechi("\u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09A8"), // poriborton   change
  bnKorechi("\u09A0\u09BF\u0995"), // thik         fix
  bnKorechi("\u09AF\u09CB\u0997"), // jog          add
  bnKorechi("\u09A4\u09C8\u09B0\u09BF"), // tori         create
  bnKorechi("\u0986\u09AA\u09A1\u09C7\u099F"), // update       update
  bnKorechi("\u09B8\u0982\u09B6\u09CB\u09A7\u09A8"), // songshodon   correct
  bnKorechi("\u0987\u09A8\u09B8\u09CD\u099F\u09B2"), // install      install
  bnKorechi("\u09B0\u09BF\u09A8\u09C7\u09AE"), // rename       rename
  bnKorechi("\u09B0\u09BF\u09AB\u09CD\u09AF\u09BE\u0995\u09CD\u099F\u09B0"), // refactor     refactor
  bnKorechi("\u0987\u09AE\u09AA\u09CD\u09B2\u09BF\u09AE\u09C7\u09A8\u09CD\u099F"), // implement    implement
  bnKorechi("\u0995\u09A8\u09AB\u09BF\u0997\u09BE\u09B0"), // configar     configure
  bnKorechi("\u099A\u09BE\u09B2\u09C1"), // chalu        enable
  bnKorechi("\u09AC\u09A8\u09CD\u09A7"), // bondho       disable
  bnKorechi("\u09B0\u09BF\u09AA\u09CD\u09B2\u09C7\u09B8"), // replace      replace
  bnKorechi("\u09B8\u0982\u09AF\u09C1\u0995\u09CD\u09A4"), // songjukto    attach
  bnKorechi("\u09B6\u09C1\u09B0\u09C1"), // shuru        start
  bnKorechi("\u09AB\u09BF\u0995\u09CD\u09B8"), // fix          fix
  bnKorechi("\u09AE\u09C1\u09AD"), // move         move

  // --- Bengali: bare perfective stems (no "korechi" helper) ---------------
  bnStem("\u09B8\u09B0\u09BF\u09AF\u09BC\u09C7\u099B"), // soriyeche      moved out
  bnStem("\u09AC\u09A6\u09B2\u09C7\u099B"), // bodleche       changed
  bnStem("\u09B2\u09BF\u0996\u09C7\u099B"), // likheche       wrote
  bnStem("\u09AC\u09BE\u09A8\u09BF\u09AF\u09BC\u09C7\u099B"), // baniyeche      built
  bnStem("\u09AE\u09C1\u099B\u09C7\u0020\u09AB\u09C7\u09B2\u09C7\u099B"), // muliye feleche deleted
  bnStem("\u09B2\u09C7\u0996\u09BE\u0020\u09B9\u09AF\u09BC\u09C7\u099B"), // lekha hoyeche  written
  bnStem("\u09AE\u09C1\u099B\u09C7\u0020\u09AB\u09C7\u09B2\u09BE\u0020\u09B9\u09AF\u09BC\u09C7\u099B"), // muliye fela hoyeche deleted passive
  bnStem("\u09B8\u09B0\u09BE\u09A8\u09CB\u0020\u09B9\u09AF\u09BC\u09C7\u099B"), // sarano hoyeche moved
  bnStem("\u09AF\u09CB\u0997\u0020\u09B9\u09AF\u09BC\u09C7\u099B"), // jog hoyeche    added
  bnStem("\u0986\u09AA\u09A1\u09C7\u099F\u0020\u09B9\u09AF\u09BC\u09C7\u099B"), // update hoyeche updated
  bnStem("\u0995\u09BE\u099F\u09BE\u0020\u09B9\u09AF\u09BC\u09C7\u099B"), // kata hoyeche   cut
]

/**
 * Match-only normalisation. Bengali text routinely carries characters that
 * carry no meaning yet defeat a literal pattern match:
 *
 *   U+200D ZWJ    zero-width joiner, inserted between consonants
 *   U+200C ZWNJ   zero-width non-joiner, same story before an i-matra
 *   U+00A0 NBSP   non-breaking space, common in pasted text
 *   any whitespace run (double space, tab, newline)
 *
 * The ORIGINAL string is never rewritten - only the copy used for matching.
 * Normalising the whole input instead of patching individual patterns fixes
 * every pattern at once, honest confessions included: before this, a claim
 * carrying a ZWJ slipped through while a confession carrying a ZWJ was
 * BLOCKED - the worst possible inversion.
 */
const normalizeForMatching = (text: string): string =>
  text
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "") // zero-width + directional marks
    .replace(/\u00A0/g, " ") // NBSP -> plain space
    .replace(/\s+/g, " ") // collapse whitespace runs

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

    // Normalise a COPY for pattern matching. ZWJ/ZWNJ/NBSP and whitespace
    // runs carry no meaning yet defeat every literal pattern below; matching
    // against `norm` fixes all of them at once. The original text is what
    // gets displayed (or replaced) and is never rewritten.
    const norm = normalizeForMatching(trimmed)

    // The agent already told the truth about lacking proof — show it.
    for (const truth of TRUTH_PATTERNS) {
      if (truth.test(norm)) {
        return { passed: true, matched: "", reason: "agent stated lack of proof" }
      }
    }

    // First evidence marker wins — the response is proven.
    for (const pattern of this.patterns) {
      const match = norm.match(pattern)
      if (match && match[0]) {
        return { passed: true, matched: match[0], reason: `evidence: ${match[0]}` }
      }
    }

    // No claim markers → explanatory / conversational / instructional text.
    const makesClaim = CLAIM_MARKERS.some((marker) => marker.test(norm))
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
