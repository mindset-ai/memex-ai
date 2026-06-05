#!/bin/sh
# Memex MCP installer bootstrap (Unix). Verifies Node ≥18, then runs the latest
# memex-ai installer via npx. Re-runnable; only side-effects are config-file edits.
#
# Source: {{API_BASE_URL}}/install.sh
set -eu

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

# shellcheck disable=SC2059
printf "\n  ${BOLD}Memex MCP Installer${RESET}\n\n"

if ! command -v node >/dev/null 2>&1; then
  printf "  ${RED}Node.js is not installed.${RESET}\n"
  printf "  Install Node 18+ first:\n"
  printf "    ${BOLD}macOS${RESET}: brew install node   (or https://nodejs.org)\n"
  printf "    ${BOLD}Linux${RESET}: see https://nodejs.org/en/download/package-manager\n\n"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  printf "  ${RED}Node ${NODE_MAJOR} is too old; need ≥18.${RESET}\n"
  printf "  Upgrade Node and re-run this command.\n\n"
  exit 1
fi

printf "  ${DIM}Node $(node --version) detected.${RESET}\n"
printf "  ${DIM}Running: npx -y memex-ai${RESET}\n\n"

exec npx -y memex-ai "$@"
