# Phase 10 — Notifications & Auto-Start

**Status:** Not Started
**Depends on:** 05
**PRD refs:** §5 stories 27–30

## Goal

The app pushes an FCM notification 5 minutes before an activity starts,
auto-transitions activities to "In Progress" at their scheduled start even
if the user hasn't opened the app, sends a reality-check notification if
there's no interaction 15 minutes after auto-start, and supports "Delayed
15m" / "Skip" actions directly from the notification tray.

## Scope

- FCM integration (token registration, send path) — new infrastructure, not
  present in the repo yet.
- A scheduled/triggered job (or on-open catch-up logic) for the 5-minute
  pre-start notification and the auto-start transition.
- Reality-check notification after 15 minutes of no interaction.
- Notification action handlers for "Delayed 15m" / "Skip" that call into
  the Phase 05 execution actions.

## Explicit non-goals

- No notification preferences/settings UI beyond what's needed to test this
  phase.

## First vertical slice

1. FCM token registration + a manually-triggered test notification, proven
   to arrive on a real device before any scheduling logic is built.
2. Auto-start transition logic (can run on app-open catch-up first, before
   true background scheduling).
3. Pre-start + reality-check notifications.
4. Tray action handlers.
