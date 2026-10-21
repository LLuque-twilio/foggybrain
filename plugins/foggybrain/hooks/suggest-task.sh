#!/usr/bin/env bash
# Nudges Claude to offer a FoggyBrain task when a prompt reads like trackable
# work, and supplies open tasks so it can spot an existing one. Never creates.
set -u

COOLDOWN_SECS=600
CACHE_TTL_SECS=60

command -v foggy >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
prompt=$(jq -r '.prompt // empty' <<<"$input" 2>/dev/null) || exit 0
[ -n "$prompt" ] || exit 0
session_id=$(jq -r '.session_id // "nosession"' <<<"$input" 2>/dev/null | tr -cd 'A-Za-z0-9_-')

trimmed=$(printf '%s' "$prompt" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

case "$trimmed" in
  /*) exit 0 ;;
esac

# "can you ...?" is a polite request, so only other questions are skipped.
if [[ "$trimmed" == *"?" ]] && ! printf '%s' "$trimmed" | grep -Eiq '^(can|could|would|will) you '; then
  exit 0
fi

# Wrapped in non-alphanumeric boundaries so "later" doesn't match "latest".
phrases="need to|remind me|remember to|don't forget|todo|to-do|follow[ -]up|later|at some point|eventually|should (add|fix|update|refactor|look|check)|we should|i should|can you (add|fix|build|create|write)|let's (add|fix|build|create)"
printf '%s' "$prompt" | grep -Eiq "(^|[^[:alnum:]])($phrases)([^[:alnum:]]|\$)" || exit 0

state_dir="${TMPDIR:-/tmp}/foggybrain-hook-$(id -u)"
(umask 077; mkdir -p "$state_dir") 2>/dev/null || exit 0
[ -O "$state_dir" ] || exit 0
find "$state_dir" -type f -mtime +1 -delete 2>/dev/null

# GNU stat first: BSD's `stat -f` means something else on GNU and can succeed with junk.
age_secs() {
  local mtime
  mtime=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null) || return 1
  echo $(( $(date +%s) - mtime ))
}

marker="$state_dir/nudged-$session_id"
if age=$(age_secs "$marker") && [ "$age" -lt "$COOLDOWN_SECS" ]; then
  exit 0
fi

# The default workspace follows the cwd, so the cache is per directory.
cache="$state_dir/open-tasks-$(pwd | cksum | cut -d' ' -f1)"
if age=$(age_secs "$cache") && [ "$age" -lt "$CACHE_TTL_SECS" ]; then
  open_tasks=$(cat "$cache")
else
  raw=$(foggy --json task list 2>/dev/null) || exit 0
  open_tasks=$(jq -r '[.[] | select(.status != "completed")]
                      | sort_by(.updatedAt) | reverse | .[:20]
                      | map("- \(.id) [\(.status)] \(.title)") | join("\n")' <<<"$raw" 2>/dev/null) || exit 0
  printf '%s' "$open_tasks" >"$cache"
fi

touch "$marker"

jq -n --arg tasks "$open_tasks" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: ("FoggyBrain task check. If the user'\''s message describes work worth tracking, compare it to the open tasks below (default workspace, 20 most recently updated). If one already covers it, name it and offer /foggybrain:foggy-do <id>. If none does, ask once: \"Create a FoggyBrain task for this?\" Never create a task without a yes. Skip this if the message is a question, is already being tracked, or you already asked about this topic.\n\nOpen tasks:\n" + (if $tasks == "" then "(none)" else $tasks end))
  }
}'
