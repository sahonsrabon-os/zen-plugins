/**
 * Bengali coverage probe for EvidenceGate (v2).
 *
 * Bengali coverage probe for EvidenceGate (v3).
 *
 * v1 had two flaws found by inspecting its own output:
 *   1. Four expectations were mislabelled - yogy/tori/songshodon/poriborton
 *      ARE in CLAIM_MARKERS, so BLOCK was correct and the label was wrong.
 *   2. The NBSP and double-space variants were placed OUTSIDE the matched
 *      span, so they could not possibly break the match.
 * v2 placed every variant strictly INSIDE the span the pattern must match,
 * which exposed 5 genuine gate gaps (ZWJ, ZWNJ, NBSP, double space inside a
 * claim; ZWJ inside an honest confession).
 * v3 fixes those with normalizeForMatching() and closes the language-parity
 * hole: English claim verbs (installed, renamed, wrote, deleted) blocked,
 * so their Bengali equivalents must block too. A7-A10 therefore flipped
 * from PASS to BLOCK - the expectation changed because the gate changed,
 * on the stated principle that language must not decide the verdict.
 * v3 also fixes a typo in A10's own fixture: it spelled the Bengali word
 * for "deleted" with ja (U+099C) instead of cha (U+099B), so it could
 * never have matched any correct pattern.
 *
 * v4 closes the backtick loophole: a bare span such as `something` is no
 * longer evidence, while a file reference, file:line, line range or test
 * output inside backticks still is. Section D covers it.
 * ASCII-only source; all Bengali text is written as \u escape sequences.
 *
 * ASCII-only source; all Bengali text is written as \u escape sequences.
 */
import { EvidenceGate } from "../src/evidence-gate.ts"

const gate = new EvidenceGate()

// Neutral filler: every case must exceed DEFAULT_MIN_LENGTH (40) or the gate
// returns PASS as trivial chatter before any pattern is consulted.
const FILLER =
  "Here is a detailed account of what happened during the session, covering the full topic in order. "
const TAIL = " here is the rest of the report body text to stay long enough for the gate."

// The exact span every claim variant below must still be recognised inside.
const SPAN = "\u09B8\u09AE\u09BE\u09A7\u09BE\u09A8 \u0995\u09B0\u09C7\u099B\u09BF" // "samadhan korechi"

const NO_PROOF = "\u0986\u09AE\u09BE\u09B0 \u0995\u09BE\u099B\u09C7 \u09AA\u09CD\u09B0\u09AE\u09BE\u09A3 \u09A8\u09C7\u0987" // "amar kache proman nei"

// A claim long enough to clear minLength and certain to register as a claim,
// so every D-case varies only the evidence offered for it.
const CLAIM = "I fixed the bug in the module and the issue is now fully resolved for everyone."


type Case = { label: string; text: string; expect: "PASS" | "BLOCK" }

const cases: Case[] = [
  // --- A. recognition: which Bengali claim phrases are in the marker list ---
  { label: "A1  samadhan korechi (in list)", text: SPAN, expect: "BLOCK" },
  { label: "A2  thik korechi (in list)", text: "\u0986\u09AE\u09BF \u09A0\u09BF\u0995 \u0995\u09B0\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A3  jog korechi (in list)", text: "\u0986\u09AE\u09BF \u09AF\u09CB\u0997 \u0995\u09B0\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A4  tori korechi (in list)", text: "\u0986\u09AE\u09BF \u09A4\u09C8\u09B0\u09BF \u0995\u09B0\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A5  songshodon korechi (in list)", text: "\u0986\u09AE\u09BF \u09B8\u0982\u09B6\u09CB\u09A7\u09A8 \u0995\u09B0\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A6  poriborton korechi (in list)", text: "\u0986\u09AE\u09BF \u09AA\u09B0\u09BF\u09AC\u09B0\u09CD\u09A4\u09A8 \u0995\u09B0\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A7  install korechi (parity: EN 'installed')", text: "\u0986\u09AE\u09BF \u0987\u09A8\u09B8\u09CD\u099F\u09B2 \u0995\u09B0\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A8  rename korechi (parity: EN 'renamed')", text: "\u0986\u09AE\u09BF \u09B0\u09BF\u09A8\u09C7\u09AE \u0995\u09B0\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A9  likhechi (parity: EN 'wrote')", text: "\u0986\u09AE\u09BF \u09B2\u09BF\u0996\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A10 muliye felechi (parity: EN 'deleted')", text: "\u0986\u09AE\u09BF \u09AE\u09C1\u099B\u09C7 \u09AB\u09C7\u09B2\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A11 english I fixed the bug", text: "I fixed the bug", expect: "BLOCK" },
  { label: "A12 refactor korechi (new)", text: "\u0986\u09AE\u09BF \u09B0\u09BF\u09AB\u09CD\u09AF\u09BE\u0995\u09CD\u099F\u09B0 \u0995\u09B0\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A13 implement korechi (new)", text: "\u0986\u09AE\u09BF \u0987\u09AE\u09AA\u09CD\u09B2\u09BF\u09AE\u09C7\u09A8\u09CD\u099F \u0995\u09B0\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A14 chalu korechi (new)", text: "\u0986\u09AE\u09BF \u099A\u09BE\u09B2\u09C1 \u0995\u09B0\u09C7\u099B\u09BF", expect: "BLOCK" },
  { label: "A15 lekha hoyeche (new)", text: "\u0986\u09AE\u09BF \u09A4\u09BE \u09B2\u09C7\u0996\u09BE \u09B9\u09AF\u09BC\u09C7\u099B\u09C7", expect: "BLOCK" },
  { label: "A16 plain chat, no claim", text: "\u0995\u09BF\u099B\u09C1 \u0996\u09C1\u09A8\u09B8\u09BE \u09B8\u09C1\u09A8\u09CD\u09A6\u09B0 \u0996\u09C1\u09AC\u09C7 \u0996\u09BE\u0987, \u0985\u09AA\u09A8\u09A8\u09BF\u09B0\u09CD\u09A3 \u0995\u09BF\u099B\u09C1 \u0995\u09B9\u09B2\u09BE \u09B8\u09AE\u09CD\u09AD\u09AC\u09C7 \u09AE\u09A7\u09CD\u09AF\u09C7 \u0986\u09B2\u09CB\u099A\u09A8\u09BE \u09AF\u09BE\u09AC\u09C7\u0964", expect: "PASS" },

  // --- B. variants placed STRICTLY INSIDE the matched span ----------------
  { label: "B1  baseline", text: SPAN, expect: "BLOCK" },
  { label: "B2  ZWJ before i-matra", text: SPAN.replace("\u099B\u09BF", "\u099B\u200D\u09BF"), expect: "BLOCK" },
  { label: "B3  ZWNJ before i-matra", text: SPAN.replace("\u099B\u09BF", "\u099B\u200C\u09BF"), expect: "BLOCK" },
  { label: "B4  NBSP between words", text: SPAN.replace(" ", "\u00A0"), expect: "BLOCK" },
  { label: "B5  double space between words", text: SPAN.replace(" ", "  "), expect: "BLOCK" },
  { label: "B6  NFD decomposed", text: SPAN.normalize("NFD"), expect: "BLOCK" },
  { label: "B7  NFC composed", text: SPAN.normalize("NFC"), expect: "BLOCK" },

  // --- C. honest confession must override a claim -------------------------
  { label: "C1  claim + confession", text: SPAN + " ... " + NO_PROOF, expect: "PASS" },
  { label: "C2  confession with ZWJ inside", text: SPAN + " ... " + NO_PROOF.replace("\u09AA\u09CD\u09B0", "\u09AA\u200D\u09CD\u09B0"), expect: "PASS" },
  { label: "C3  confession with NBSP inside", text: SPAN + " ... " + NO_PROOF.replace(" ", "\u00A0"), expect: "PASS" },
  // --- D. backtick pseudo-proof: a span alone is not evidence -------------
  // Regression cover for the documented known limitation: any backtick span
  // used to satisfy the gate, so `something` waved a claim through.
  { label: "D1  bare backtick span", text: CLAIM + " Evidence: `something`.", expect: "BLOCK" },
  { label: "D2  bare symbol in backticks", text: CLAIM + " Evidence: `buildFinalMessages`.", expect: "BLOCK" },
  { label: "D3  claim sentence in backticks", text: CLAIM + " Evidence: `I fixed it`.", expect: "BLOCK" },
  { label: "D4  file reference in backticks", text: CLAIM + " Evidence: `handler.ts`.", expect: "PASS" },
  { label: "D5  file:line in backticks", text: CLAIM + " Evidence: `src/app.ts:42`.", expect: "PASS" },
  { label: "D6  test output in backticks", text: CLAIM + " Evidence: `424 pass`.", expect: "PASS" },
  { label: "D7  line range in backticks", text: CLAIM + " Evidence: `lines 12-14`.", expect: "PASS" },
]

console.log("RESULT  MATCH   CASE                                        REASON")
console.log("------  ------  ------------------------------------------  -------------------------")
const misses: string[] = []
for (const c of cases) {
  const v = gate.evaluate(FILLER + c.text + TAIL)
  const got = v.passed ? "PASS" : "BLOCK"
  const match = got === c.expect ? "ok" : "WRONG"
  if (match === "WRONG") misses.push(c.label)
  console.log(`${got.padEnd(7)}  ${match.padEnd(6)}  ${c.label.padEnd(42)}  ${v.reason}`)
}

console.log("")
console.log(`total ${cases.length}, expectation mismatches: ${misses.length}`)
for (const m of misses) console.log("  MISMATCH: " + m)
