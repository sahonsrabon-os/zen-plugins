#!/usr/bin/env bash
#
# zen-bridge installer
#
# Configures OpenCode for the Mission Barisal provider + zen-bridge plugin.
# Idempotent: running it again with a new URL updates the config in place.
#
# Usage:
#   ./setup.sh                          # interactive: asks for the server URL
#   ./setup.sh --url http://host:5000/v1
#   ./setup.sh --url URL --dry-run      # show what would change, write nothing
#   ./setup.sh --url URL --no-open      # skip opening the config folder
#   ./setup.sh --help
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.opencode}"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
PLUGIN_PATH="$SCRIPT_DIR"
URL=""
DRY_RUN=0
OPEN_FOLDERS=1
ASSUME_YES=0
DEFAULT_URL="http://localhost:5000/v1"

# Model catalogue shipped with the Mission Barisal provider.
# key = model id (must match the agent id), value = display name.
readonly MODELS_JSON='{
  "mission": "Mission Barisal Orchestrator",
  "doc-king": "Documentation King (Halim)",
  "team-heart": "Team Heart (Jara)",
  "customer-experience-specialist": "Customer Experience Specialist",
  "ecommerce-operations-analyst": "E-Commerce Operations Analyst",
  "bug-hunter": "Bug Hunter (Jewel)",
  "code-guru": "Code Guru (Monu)",
  "perf-wizard": "Performance Wizard (Rashed)",
  "qa-tyrant": "Quality Tyrant (Mojnu)",
  "security-hero": "Security Hero (Bablu)"
}'

# Agents: id|description|permission-json|prompt
readonly AGENTS_TXT='
code-guru|System Architecture, Design Patterns, Code Structure|{"edit":"allow","bash":"allow"}|You are Code Guru (Monu). Focus on system architecture, design patterns, and code structure.
bug-hunter|Bug Detection, Debugging, Error Handling, Logic Validation|{"edit":"allow","bash":"allow"}|You are Bug Hunter (Jewel). Focus on bug detection, debugging, error handling, and logic validation.
security-hero|Security Audit, Vulnerability Assessment, Data Protection, Web Threat Research|{"edit":"deny","bash":{"*":"ask","grep *":"allow","git log*":"allow"}}|You are Security Hero (Bablu). Focus on security audits, vulnerability assessment, data protection, and web threat research.
perf-wizard|Performance Optimization, Memory Management, Caching Strategies|{"edit":"allow","bash":{"*":"ask","grep *":"allow"}}|You are Performance Wizard (Rashed). Focus on performance optimization, memory management, caching strategies, and benchmarking.
doc-king|Documentation, Code Comments, API Docs, README maintenance|{"edit":"allow","bash":"allow"}|You are Documentation King (Halim). Write and maintain clear, comprehensive documentation.
qa-tyrant|Quality Assurance, Test Coverage, Edge Cases, Regression Testing|{"edit":"allow","bash":{"*":"ask","grep *":"allow"}}|You are Quality Tyrant (Mojnu). Ruthlessly test code quality. Focus on test coverage and edge cases.
team-heart|Team Coordination, Communication, Conflict Resolution|{"edit":"allow","bash":"allow"}|You are Team Heart (Jara). Focus on team coordination, communication, and knowledge sharing.
customer-experience-specialist|Customer Experience, Retention, Omnichannel Support|{"edit":"allow","bash":"allow"}|You are a Customer Experience Specialist. Focus on customer retention, omnichannel support, and dispute handling.
ecommerce-operations-analyst|Ad Copywriting, Product Catalog Optimization, E-Commerce Strategy|{"edit":"allow","bash":"allow"}|You are an E-Commerce Operations Analyst. Focus on ad copywriting, product catalog optimization, and e-commerce strategy.
'

# ---------------------------------------------------------------------------
# Output helpers (ASCII only, no emoji)
# ---------------------------------------------------------------------------
info() { printf '[info]  %s\n' "$*"; }
ok()   { printf '[ ok ]  %s\n' "$*"; }
warn() { printf '[warn]  %s\n' "$*" >&2; }
err()  { printf '[error] %s\n' "$*" >&2; }

usage() {
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --url)      URL="${2:-}"; shift 2 ;;
    --url=*)    URL="${1#*=}"; shift ;;
    --dir)      CONFIG_DIR="${2:-}"; CONFIG_FILE="$CONFIG_DIR/opencode.json"; shift 2 ;;
    --dir=*)    CONFIG_DIR="${1#*=}"; CONFIG_FILE="$CONFIG_DIR/opencode.json"; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --no-open)  OPEN_FOLDERS=0; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --help|-h)  usage; exit 0 ;;
    *)          err "unknown option: $1"; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
detect_os() {
  case "$(uname -s)" in
    Linux*)               OS=linux ;;
    Darwin*)              OS=macos ;;
    MINGW*|MSYS*|CYGWIN*) OS=windows ;;
    *)                    OS=unknown ;;
  esac
  printf '%s' "$OS"
}
OS="$(detect_os)"
info "detected OS: $OS"

command -v python3 >/dev/null 2>&1 || { err "python3 is required (apt install python3 / brew install python3)"; exit 1; }

# ---------------------------------------------------------------------------
# Server URL: flag > env > prompt > default
# ---------------------------------------------------------------------------
if [ -z "$URL" ]; then
  URL="${MISSIONBARISAL_URL:-}"
fi

if [ -z "$URL" ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
  printf '\n'
  printf 'Which Mission Barisal server URL should the plugin use?\n'
  printf '  It must be the OpenAI-compatible base URL (ends in /v1).\n'
  printf '  Press Enter to accept the default.\n'
  printf 'Base URL [%s]: ' "$DEFAULT_URL"
  read -r REPLY || REPLY=""
  URL="${REPLY:-$DEFAULT_URL}"
fi

URL="${URL:-$DEFAULT_URL}"

# Normalise: allow a bare host to be promoted to .../v1
case "$URL" in
  */v1) ;;
  */) URL="${URL}v1" ;;
  *)   URL="$URL/v1" ;;
esac

case "$URL" in
  http://*|https://*) ;;
  *) err "URL must start with http:// or https:// -> $URL"; exit 2 ;;
esac

info "server base URL: $URL"

# ---------------------------------------------------------------------------
# Reachability probe (non-fatal: the server may start later)
# ---------------------------------------------------------------------------
probe_server() {
  command -v curl >/dev/null 2>&1 || return 0
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/models" 2>/dev/null || true)"
  case "$code" in
    200) ok "server reachable: GET $URL/models -> 200" ;;
    000) warn "server not reachable right now (GET $URL/models timed out). Setup continues; start it later." ;;
    *)   warn "server answered GET $URL/models -> HTTP $code. Check the URL if the models do not load." ;;
  esac
}
probe_server

# ---------------------------------------------------------------------------
# Write the config
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  info "dry run: nothing will be written"
fi

mkdir -p "$CONFIG_DIR"
[ -f "$CONFIG_FILE" ] || info "no existing config at $CONFIG_FILE - a fresh one will be created"

# Derive the MCP endpoint from the base URL:  http://h:5000/v1 -> http://h:5000/mcp
MCP_URL="${URL%/v1}/mcp"

set -o pipefail
python3 - "$CONFIG_FILE" "$URL" "$PLUGIN_PATH" "$MCP_URL" "$MODELS_JSON" "$AGENTS_TXT" "$DRY_RUN" <<'PYEOF'
import json, os, shutil, sys, time

config_file, url, plugin_path, mcp_url, models_json, agents_txt, dry_run = sys.argv[1:8]
dry_run = dry_run == "1"

# --- load existing config (or start fresh) ---------------------------------
data = {}
if os.path.isfile(config_file):
    with open(config_file, encoding="utf-8") as fh:
        raw = fh.read().strip()
    if raw:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"[error] {config_file} is not valid JSON: {exc}", file=sys.stderr)
            sys.exit(3)

created = not bool(data)
before = json.dumps(data, sort_keys=True, ensure_ascii=False)

changes = []

def note(msg):
    changes.append(msg)

if "$schema" not in data:
    data["$schema"] = "https://opencode.ai/config.json"
    note("set $schema")

# --- plugin registration ---------------------------------------------------
plugins = data.setdefault("plugins", [])
if not isinstance(plugins, list):
    plugins = list(plugins)
    data["plugins"] = plugins
if plugin_path not in plugins:
    plugins.append(plugin_path)
    note(f"registered plugin: {plugin_path}")

# --- provider --------------------------------------------------------------
providers = data.setdefault("providers", {})
prov = providers.setdefault("missionbarisal", {})
if not prov.get("name"):
    prov["name"] = "Mission Barisal Local Server"
    note("created provider 'missionbarisal'")
prov["package"] = prov.get("package") or "@opencode/ai/providers/openai-compatible"
settings = prov.setdefault("settings", {})
old_url = settings.get("baseURL")
settings["baseURL"] = url
if old_url != url:
    note(f"baseURL: {old_url or '(none)'} -> {url}")

# --- models (additive: never delete user models) ---------------------------
models = prov.setdefault("models", {})
catalog = json.loads(models_json)
for mid, name in catalog.items():
    entry = models.setdefault(mid, {})
    if entry.get("name") != name:
        entry["name"] = name
        note(f"model '{mid}': name -> {name}")

# --- default model ---------------------------------------------------------
if not data.get("model"):
    data["model"] = "missionbarisal/code-guru"
    note("set default model: missionbarisal/code-guru")

# --- agents (additive: an existing agent keeps its prompt/permissions) -----
agents = data.setdefault("agent", {})
added = []
for line in agents_txt.strip().splitlines():
    if not line.strip():
        continue
    aid, desc, perm_json, prompt = line.split("|", 3)
    if aid in agents:
        continue
    agents[aid] = {
        "description": desc,
        "mode": "all",
        "model": f"missionbarisal/{aid}",
        "prompt": prompt,
        "permission": json.loads(perm_json),
    }
    added.append(aid)
if added:
    note(f"added {len(added)} agent(s): {', '.join(added)}")

# --- MCP endpoint derived from the URL (additive) --------------------------
mcp = data.setdefault("mcp", {})
if "missionbarisal-mcp" not in mcp:
    mcp["missionbarisal-mcp"] = {"type": "remote", "url": mcp_url, "oauth": False, "codemode": True}
    note(f"added MCP server 'missionbarisal-mcp': {mcp_url}")
else:
    entry = mcp["missionbarisal-mcp"]
    if entry.get("url") != mcp_url:
        entry["url"] = mcp_url
        note(f"MCP 'missionbarisal-mcp' url -> {mcp_url}")

after = json.dumps(data, sort_keys=True, ensure_ascii=False)
changed = before != after

# --- report / write --------------------------------------------------------
if not changed and not created:
    print("[ done ] config already up to date - no changes needed")
    sys.exit(0)

for c in changes:
    print(f"[change] {c}")

if dry_run:
    print(f"[ dry  ] would write {config_file} ({len(changes)} change(s))")
    sys.exit(0)

# Back up the previous config once per run before replacing it.
if os.path.isfile(config_file):
    backup = f"{config_file}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(config_file, backup)
    print(f"[backup] {backup}")

os.makedirs(os.path.dirname(config_file) or ".", exist_ok=True)
tmp = config_file + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
os.replace(tmp, config_file)
print(f"[ wrote] {config_file}")
PYEOF
PY_RC=$?
if [ "$PY_RC" -ne 0 ]; then
  err "config write failed (exit $PY_RC)"
  exit "$PY_RC"
fi

# ---------------------------------------------------------------------------
# Dependencies for the plugin itself
# ---------------------------------------------------------------------------
install_deps() {
  if [ ! -f "$SCRIPT_DIR/package.json" ]; then
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    warn "npm not found - skip 'npm install'. Install Node.js to load the plugin."
    return 0
  fi
  if [ -d "$SCRIPT_DIR/node_modules/@opencode/plugin" ]; then
    ok "dependencies already present (node_modules/@opencode/plugin)"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    info "dry run: would run 'npm install' in $SCRIPT_DIR"
    return 0
  fi
  info "running npm install in $SCRIPT_DIR"
  if (cd "$SCRIPT_DIR" && npm install --no-fund --no-audit --loglevel=error); then
    ok "npm install finished"
  else
    warn "npm install failed - the plugin will not load until dependencies are installed"
  fi
}
install_deps

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
verify() {
  local cli=""
  if command -v opencode >/dev/null 2>&1; then
    cli="opencode"
  elif [ -x /opt/OpenCode/resources/opencode-cli ]; then
    cli=/opt/OpenCode/resources/opencode-cli
  elif [ -x "$HOME/.config/ai.opencode.desktop/cli/2.0.19/opencode-cli" ]; then
    cli="$HOME/.config/ai.opencode.desktop/cli/2.0.19/opencode-cli"
  fi

  if [ -z "$cli" ]; then
    warn "opencode CLI not found on PATH - skip plugin verification"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    info "dry run: would run '$cli plugin list'"
    return 0
  fi

  # The CLI may answer with an empty body while its background service warms
  # up, so retry once before concluding anything.
  local out="" attempt
  for attempt in 1 2; do
    out="$("$cli" plugin list 2>&1)" || out=""
    if [ -n "$out" ]; then
      break
    fi
    sleep 1
  done

  if [ -z "$out" ]; then
    warn "'$cli plugin list' returned no output (service may still be starting)."
    warn " Verify manually later with:  $cli plugin list"
    return 0
  fi
  if printf '%s' "$out" | grep -q 'zen-bridge'; then
    ok "plugin registered: zen-bridge"
  else
    warn "zen-bridge not listed by '$cli plugin list'. Output was:"
    printf '%s\n' "$out" >&2
    warn " Check that 'plugins' in $CONFIG_FILE contains: $PLUGIN_PATH"
  fi
}
verify

# ---------------------------------------------------------------------------
# Open the config folder, per OS
# ---------------------------------------------------------------------------
open_config_location() {
  [ "$OPEN_FOLDERS" -eq 1 ] || return 0
  [ "$DRY_RUN" -eq 0 ] || return 0
  [ -t 1 ] || return 0   # only in a real terminal

  case "$OS" in
    linux)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$CONFIG_DIR" >/dev/null 2>&1 &
      else
        info "config folder: $CONFIG_DIR"
        return 0
      fi
      ;;
    macos)
      command -v open >/dev/null 2>&1 && open "$CONFIG_DIR" >/dev/null 2>&1 &
      ;;
    windows)
      if command -v explorer.exe >/dev/null 2>&1; then
        explorer.exe "$(cygpath -w "$CONFIG_DIR" 2>/dev/null || echo "$CONFIG_DIR")" >/dev/null 2>&1 &
      fi
      ;;
    *)
      info "config folder: $CONFIG_DIR"
      return 0
      ;;
  esac
  ok "opened config folder: $CONFIG_DIR"
}
open_config_location

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n'
printf '============================================================\n'
printf ' zen-bridge setup complete\n'
printf '============================================================\n'
printf '  OS            : %s\n' "$OS"
printf '  Config file   : %s\n' "$CONFIG_FILE"
printf '  Plugin path   : %s\n' "$PLUGIN_PATH"
printf '  Server base   : %s\n' "$URL"
printf '  MCP endpoint  : %s\n' "$MCP_URL"
printf '  Default model : missionbarisal/code-guru\n'
printf '  Agents        : 9 Mission Barisal agents (mode: all)\n'
printf '\n'
printf 'Next steps:\n'
printf '  1. Start the Mission Barisal server if it is not running.\n'
printf '  2. Restart OpenCode so it reloads the config.\n'
printf '  3. Run the test suite:  cd %s && node bridge.test.ts\n' "$SCRIPT_DIR"
printf '\n'
printf 'Change the server later:\n'
printf '  %s --url https://new-host/v1\n' "$(basename "$0")"
printf '============================================================\n'
