/**
 * Runtime artefacts for zen-bridge.
 *
 * When the OpenCode server boots it loads this plugin, and setup() calls
 * into here to
 *
 *   1. create the runtime directory if it does not exist yet, and
 *   2. append a boot line to an append-only log, and
 *   3. probe the Mission Barisal server and record whether it answered.
 *
 * Two constraints shape everything below:
 *
 *   - The main server (localhost:5000) is NEVER written to. The only call
 *     made against it is a read-only GET <base>/models.
 *   - No runtime failure may take the plugin down. Every filesystem and
 *     network path is wrapped, and a failure is returned as data rather
 *     than thrown, so a full disk or a dead server leaves the bridge
 *     working exactly as it did before.
 *
 * Paths are parameters with defaults rather than constants, so the tests
 * can point them at a temporary directory instead of the real home.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Runtime directory. Created on first use if it is missing. */
export const RUNTIME_DIR = join(homedir(), ".opencode")

/** Append-only boot log, one line per server start. */
export const RUNTIME_LOG_FILENAME = "zen-bridge-runtime.log"

/** Config file written by setup.sh. Read-only here; never modified. */
export const CONFIG_FILENAME = "opencode.json"

export interface ConnectionCheck {
  /** The exact URL that was probed. */
  url: string
  /** True when the server answered with a 2xx status. */
  ok: boolean
  /** HTTP status, or null when the request never completed. */
  status: number | null
  /** Wall-clock duration of the probe in milliseconds. */
  ms: number
  /** Error description when the probe did not complete. */
  error: string | null
}

/**
 * Append one ISO-timestamped line to the boot log, creating the runtime
 * directory first.
 *
 * @returns the file written, or null when logging was not possible.
 *          Never throws: a logging problem must not break the plugin.
 */
export function logRuntime(message: string, dir: string = RUNTIME_DIR): string | null {
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, RUNTIME_LOG_FILENAME)
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
    return file
  } catch {
    return null
  }
}

/**
 * Read `providers.<id>.settings.baseURL` out of the installer-written
 * config. The file is only ever read — the plugin does not write config.
 *
 * @returns the base URL, or null when the file or the key is missing,
 *          unparsable, or not a non-empty string.
 */
export function readBaseUrl(providerID: string, file: string = join(RUNTIME_DIR, CONFIG_FILENAME)): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    const cfg = parsed as {
      providers?: Record<string, { settings?: { baseURL?: unknown } }> | undefined
    }
    const value = cfg?.providers?.[providerID]?.settings?.baseURL
    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * Read-only liveness probe: GET `<baseURL>/models`.
 *
 * Trailing slashes are trimmed so `http://host/v1/` and `http://host/v1`
 * hit the same path. Anything other than 2xx is reported as `ok: false`
 * rather than thrown, so the caller can simply log the outcome.
 */
export async function verifyConnection(
  baseURL: string,
  timeoutMs = 5000,
): Promise<ConnectionCheck> {
  const url = `${baseURL.replace(/\/+$/, "")}/models`
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    })
    return {
      url,
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      error: null,
    }
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
