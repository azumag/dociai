#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required. Install it and run: gh auth login"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login"
  exit 1
fi

create_label() {
  local name="$1"
  local color="$2"
  local description="$3"
  gh label create "$name" --color "$color" --description "$description" --force >/dev/null
}

create_label "type:feature" "0E8A16" "Feature implementation"
create_label "type:task" "1D76DB" "General task"
create_label "area:core" "5319E7" "Core application flow"
create_label "area:ai" "A2EEEF" "AI connectors and prompting"
create_label "area:context" "FBCA04" "Comments, screen, and stream context"
create_label "area:news" "D93F0B" "News reader"
create_label "area:ui" "C5DEF5" "User interface"
create_label "area:security" "B60205" "Security and secrets"
create_label "priority:p0" "B60205" "Must have for first PoC"
create_label "priority:p1" "D93F0B" "Important next step"
create_label "priority:p2" "FBCA04" "Useful follow-up"

gh issue create --title "Local HTML PoC shell" --body-file issues/001-local-poc-shell.md --label "type:feature,area:core,area:ui,priority:p0"
gh issue create --title "Load local config without storing API keys" --body-file issues/002-config-loader.md --label "type:feature,area:core,area:security,priority:p0"
gh issue create --title "AI connector abstraction for multiple providers" --body-file issues/003-ai-connectors.md --label "type:feature,area:ai,priority:p0"
gh issue create --title "Persona router for multiple AI personalities" --body-file issues/004-persona-router.md --label "type:feature,area:ai,area:core,priority:p0"
gh issue create --title "Comment history store and stream summary state" --body-file issues/005-comment-store.md --label "type:feature,area:context,priority:p0"
gh issue create --title "Context builder for comments, screen, and news" --body-file issues/006-context-builder.md --label "type:feature,area:context,area:ai,priority:p1"
gh issue create --title "Trigger engine for keywords, hotkeys, intervals, and random reactions" --body-file issues/007-trigger-engine.md --label "type:feature,area:core,priority:p0"
gh issue create --title "Speech queue with Web Speech API" --body-file issues/008-speech-queue.md --label "type:feature,area:core,priority:p0"
gh issue create --title "Screen capture and visual context" --body-file issues/009-screen-capture-context.md --label "type:feature,area:context,area:ai,priority:p1"
gh issue create --title "News reader based on RSS and soviet_now research" --body-file issues/010-news-reader.md --label "type:feature,area:news,priority:p1"
gh issue create --title "Comment source adapters for YouTube and Twitch" --body-file issues/011-comment-source-adapters.md --label "type:task,area:context,priority:p2"
gh issue create --title "Settings UI for connectors, personas, triggers, and logs" --body-file issues/012-settings-ui.md --label "type:feature,area:ui,priority:p1"
gh issue create --title "API key handling and secret safety checks" --body-file issues/013-api-key-security.md --label "type:task,area:security,priority:p0"
gh issue create --title "OBS and streaming display mode" --body-file issues/014-obs-and-streaming-mode.md --label "type:feature,area:ui,priority:p2"

echo "Created GitHub issues."

