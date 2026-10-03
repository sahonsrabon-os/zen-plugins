/**
 * Tests for the runtime artefact layer: boot logging, config reading and
 * the read-only connection probe.
 *
 * Every test points the module at a temporary directory or a local HTTP
 * server it owns, so the suite never touches the real ~/.opencode log, the
 * real config, or the Mission Barisal server.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { logRuntime, readBaseUrl, verifyConnection, RUNTIME_LOG_FILENAME } from "../src/runtime-log.ts"

// Prefer the pre-approved scratch directory; fall back to the OS temp dir.
const SCRATCH = existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir()

/** A directory that does not exist yet, so the module must create it. */
const freshDir = (): string => mkdtempSync(join(SCRATCH, "zen-bridge-test-"))

test("logRuntime creates a missing directory and appends a boot line", () => {
  const dir = join(freshDir(), "does-not-exist-yet")
  assert.equal(existsSync(dir), false, "precondition: directory must start absent")

  const written = logRuntime("boot provider=missionbarisal", dir)

  assert.equal(written, join(dir, RUNTIME_LOG_FILENAME))
  assert.equal(existsSync(dir), true, "logRuntime must create the directory")
  const content = readFileSync(written as string, "utf8")
  assert.match(content, /^\d{4}-\d{2}-\d{2}T\S+ boot provider=missionbarisal\n$/)
})

test("logRuntime appends rather than truncating", () => {
  const dir = freshDir()
  logRuntime("first", dir)
  logRuntime("second", dir)

  const lines = readFileSync(join(dir, RUNTIME_LOG_FILENAME), "utf8").trim().split("\n")
  assert.equal(lines.length, 2, "two calls must produce two lines")
  assert.match(lines[0]!, / first$/)
  assert.match(lines[1]!, / second$/)
})

test("logRuntime returns null instead of throwing when the path is unwritable", () => {
  // A file where the directory should be: mkdirSync must fail.
  const blocker = join(freshDir(), "not-a-directory")
  writeFileSync(blocker, "occupied")
  assert.equal(logRuntime("boot", join(blocker, "sub")), null)
})

test("readBaseUrl returns the installer-written baseURL", () => {
  const dir = freshDir()
  const file = join(dir, "opencode.json")
  writeFileSync(
    file,
    JSON.stringify({
      providers: { missionbarisal: { settings: { baseURL: "http://localhost:5000/v1" } } },
    }),
  )

  assert.equal(readBaseUrl("missionbarisal", file), "http://localhost:5000/v1")
})

test("readBaseUrl returns null instead of throwing on every bad input", () => {
  const dir = freshDir()

  assert.equal(readBaseUrl("missionbarisal", join(dir, "missing.json")), null, "missing file")

  const malformed = join(dir, "malformed.json")
  writeFileSync(malformed, "{ not json")
  assert.equal(readBaseUrl("missionbarisal", malformed), null, "malformed JSON")

  const empty = join(dir, "empty.json")
  writeFileSync(empty, JSON.stringify({ providers: {} }))
  assert.equal(readBaseUrl("missionbarisal", empty), null, "provider absent")

  const wrongType = join(dir, "wrong-type.json")
  writeFileSync(
    wrongType,
    JSON.stringify({ providers: { missionbarisal: { settings: { baseURL: 42 } } } }),
  )
  assert.equal(readBaseUrl("missionbarisal", wrongType), null, "non-string baseURL")

  const blank = join(dir, "blank.json")
  writeFileSync(blank, JSON.stringify({ providers: { missionbarisal: { settings: { baseURL: "" } } } }))
  assert.equal(readBaseUrl("missionbarisal", blank), null, "empty baseURL")
})

/** Start a throwaway HTTP server, run `fn`, then always shut it down. */
async function withServer(
  handler: (url: string, res: { writeHead: (c: number) => void; end: (b?: string) => void }) => void,
  fn: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => handler(req.url ?? "", res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    await fn(`http://127.0.0.1:${port}/v1`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test("verifyConnection reports OK and probes exactly <base>/models", async () => {
  let seenPath = ""
  await withServer(
    (url, res) => {
      seenPath = url
      if (url === "/v1/models") {
        res.writeHead(200)
        res.end('{"object":"list","data":[]}')
      } else {
        res.writeHead(404)
        res.end()
      }
    },
    async (baseURL) => {
      const check = await verifyConnection(baseURL)
      assert.equal(check.ok, true)
      assert.equal(check.status, 200)
      assert.equal(check.error, null)
      assert.equal(check.url, `${baseURL}/models`)
      assert.equal(seenPath, "/v1/models")
      assert.ok(check.ms >= 0, "duration must be measured")
    },
  )
})

test("verifyConnection reports FAILED on a non-2xx answer instead of throwing", async () => {
  await withServer(
    (url, res) => {
      res.writeHead(404)
      res.end()
    },
    async (baseURL) => {
      // baseURL has no /v1 prefix here, so probe the bare host instead.
      const check = await verifyConnection(baseURL.replace("/v1", ""))
      assert.equal(check.ok, false)
      assert.equal(check.status, 404)
      assert.equal(check.error, null)
    },
  )
})

test("verifyConnection tolerates a trailing slash on the base URL", async () => {
  await withServer(
    (url, res) => {
      res.writeHead(url === "/v1/models" ? 200 : 404)
      res.end()
    },
    async (baseURL) => {
      const check = await verifyConnection(`${baseURL}/`)
      assert.equal(check.ok, true, "trailing slash must not produce /v1//models")
      assert.equal(check.url, `${baseURL}/models`)
    },
  )
})

test("verifyConnection reports a refused connection as data, not an exception", async () => {
  // Grab a port, release it, then probe it: the OS will refuse.
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))

  const check = await verifyConnection(`http://127.0.0.1:${port}/v1`, 2000)
  assert.equal(check.ok, false)
  assert.equal(check.status, null)
  assert.notEqual(check.error, null, "the refusal reason must be reported")
})
