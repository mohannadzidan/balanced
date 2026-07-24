## Problem Statement

Users struggle to balance strict full-time work, freelance goals, learning, and personal time. Static calendars break when reality hits (delays, early finishes, urgent tasks). Existing tools do not dynamically recover missed time or respect complex constraints like commute transitions, interruptible work blocks, and minimum focus sessions. Users need a system that automatically plans their day based on rolling deficits, dynamically adjusts in real-time when reality diverges from the plan, and ensures goals are met without manual schedule micromanagement.

## Solution

A dynamic, client-side scheduling application that treats time like a physics engine. Every activity is a reusable global definition governed by a set of typed **rules** — some system-wide (such as how far one activity may overlap another) and some activity-specific (such as the time window it may occupy). The solver treats these rules as the constraints of the physics engine: hard rules form the immovable skeleton, soft rules define the space it is free to bend. It automatically generates daily plans based on strict blocks and flexible goals, prioritizes activities based on rolling deficits, and reactively recalculates the schedule in real-time when activities finish early, run late, or get displaced. It uses an Iterative Constraint Relaxation solver to shrink, nudge, or displace lower-priority blocks to make room for reality, ensuring time is always accounted for and optimized.

## Rules Model

Activities are **global definitions**, not one-off calendar entries. A definition is authored once (name, base target, semantics) and the scheduler instantiates it as concrete blocks on a given day. Constraints on where, when, and how an activity may be placed are expressed as **rules** attached to the definition, rather than as ad-hoc boolean flags. This keeps the solver generic: it evaluates a block against its rule set instead of special-casing each property.

Rules have two scopes:

- **System-wide rules** apply across all activities and govern how activities interact. The primary one is the **Overlap Rule**: a *host* activity may be overlapped/interrupted by a designated *allowed-guest* set for a bounded total of X minutes (e.g., an 8h "Office Work" host may be overlapped by "Lunch" for up to 60 minutes, letting the user step out to the food court without deleting or shrinking the work block). This generalizes the earlier "Container + interruptible minutes + allowed interrupters" mechanism: the host declares an overlap budget and a guest set, and each guest is carved out of the host's span for its duration.

- **Activity-level rules** are attached to a single definition. Rules are grouped into **categories**, and within a category the rules are **mutually exclusive** — an activity carries at most one. Two categories are defined initially:
  - **Temporal Placement**, whose exclusive options are:
    - **Preferred Window** (soft): the scheduler tries to place the activity between a start/end time but may relax the window under pressure. This is the current flexible-activity behavior.
    - **Strict Window** (hard boundary): the activity must fall entirely within a start/end time. The boundary is non-negotiable, though the activity may still float freely *inside* the window.
  - **Recurrence**, whose exclusive options are:
    - **Recurring** (default): the definition carries an allowed-days set and is re-evaluated by the daily generator on every matching day. It participates in rolling carry-over.
    - **One-Time**: the definition is bound to a single specific date. It appears only on that date, is invisible to the generator on every other day, and is **exempt from carry-over** — an unmet target simply lapses when the day ends rather than snowballing into a deficit (mirroring vacation-day proration). A one-time activity still carries the same Temporal Placement, Overlap, and block-size rules as any other; only its lifecycle differs. It can be strict (a doctor appointment) or flexible (a one-off "finish taxes, 3h today"). Once its date has passed, the definition is inert.

Every rule is additionally classified as **Hard** (a violation is rejected, or the block is immovable) or **Soft** (a violation is permitted, and the solver relaxes it in cascade order). This classification is exactly what the Iterative Constraint Relaxation solver consumes: hard rules define the skeleton and the rejection conditions; soft rules define the shrink → nudge → relax → displace search space.

## User Stories

1. As a user, I want to view a visual timeline of my current day, so that I can see what is scheduled.
2. As a user, I want to add strict activities with specific start and end times, so that I can block out immovable appointments.
3. As a user, I want to add pre-transitions and post-transitions to strict activities, so that I can account for commute times or morning routines.
4. As a user, I want to create flexible activities with daily targets, minimum block sizes, and preferred time windows, so that the system can schedule them dynamically.
5. As a user, I want to see my flexible activities and their daily progress in a sidebar, so that I can track my target completion.
6. As a user, I want to manually schedule a block of a flexible activity, so that I can place it at a specific time if I choose.
7. As a user, I want to mark a strict activity as a "Container" with a specific number of interruptible minutes, so that I can model workdays with unpaid breaks.
8. As a user, I want to assign specific flexible activities as "Allowed Interrupters" for a container, so that only designated activities (like Lunch) can be scheduled inside it.
9. As a user, I want to manually schedule an allowed interrupter inside a container, so that I can place my break at a specific time.
10. As a user, I want the timeline to visually render nested blocks inside their parent container, so that I can clearly see my schedule hierarchy.
11. As a user, I want to press "Start" on an upcoming activity to enter a "Focus Mode", so that I can see a large countdown timer without distractions.
12. As a user, I want to click "Finish Early" during an active activity, so that the system logs my actual time spent and frees the remaining gap.
13. As a user, I want to click "Extend +15m" or "+30m" during an active activity, so that I can continue working if I need more time.
14. As a user, I want the app to automatically process yesterday's completed time against daily targets when I open it on a new day, so that my deficits and surpluses roll forward.
15. As a user, I want carry-over to be configurable per activity, so that activities like Sleep reset daily while activities like Freelance accumulate deficits.
16. As a user, I want a daily maximum cap on adjusted targets, so that carry-over deficits cannot snowball into impossible daily loads.
17. As a user, I want to see my adjusted daily target and a carry-over badge in the sidebar, so that I understand why today's target differs from the base target.
18. As a user, I want each activity to have configurable allowed days of the week, so that the scheduler only places activities on appropriate days.
19. As a user, I want the app to automatically generate a daily plan if one does not exist, so that I wake up to a pre-built schedule.
20. As a user, I want the scheduler to place strict activities and their transitions first, so that hard constraints establish the skeleton of the day.
21. As a user, I want the scheduler to fill free gaps with flexible activities whose preferred windows overlap, so that activities land in their preferred times.
22. As a user, I want the scheduler to respect minimum block sizes when placing flexible activities, so that no block is too short to be productive.
23. As a user, I want to see a warning badge when a flexible activity's target cannot be fully scheduled, so that I know my daily goal is at risk.
24. As a user, I want the solver to automatically recalculate my schedule forward when I finish an activity early, so that freed time is either filled or marked as free time.
25. As a user, I want the solver to check flexible activities with outstanding deficits against freed gaps, so that carry-over deficits can be recovered.
26. As a user, I want the solver to respect minimum block sizes when attempting to fill freed gaps, so that activities are not scheduled in unusably small fragments.
27. As a user, I want freed time that cannot be filled to be marked as "Free Time" on the timeline, so that I can visually distinguish available time.
28. As a user, I want the solver to validate extensions against subsequent blocks, so that extending one activity does not silently overwrite another.
29. As a user, I want the solver to nudge subsequent flexible blocks forward when an extension creates an overlap, so that the cascade delay propagates without breaking hard constraints.
30. As a user, I want finishing an interrupter early inside a container to bank the spare time, so that the system can offer me productive micro-tasks.
31. As a user, I want a prominent UI prompt to appear when spare time is banked, so that I can quickly decide whether to use it or discard it.
32. As a user, I want the prompt to only offer allowed interrupters whose minimum block size fits within the banked spare time, so that I am not presented with impossible options.
33. As a user, I want selecting a quick activity from the prompt to immediately enter Focus Mode for that activity, so that I can begin without additional clicks.
34. As a user, I want the system to automatically return me to the parent container's Focus Mode timer when a spare-time activity ends, so that I seamlessly resume my main work.
35. As a user, I want the option to discard banked spare time by clicking "Resume Work" or "Just Rest", so that I am not forced into productivity.
36. As a user, I want the app to reject saving a strict activity that overlaps an immovable block, so that I am forced to resolve the conflict manually.
37. As a user, I want to toggle a "Pin Block" setting on a scheduled flexible activity instance, so that I can protect specific time slots from being displaced.
38. As a user, I want the solver to execute a Full Hybrid Cascade (Shrink, Nudge, Relax, Displace) when a new strict activity overlaps a flexible one, so that conflicts are resolved dynamically.
39. As a user, I want the solver to delete a lower-priority block and bank the missed time as a daily deficit if no shrink, nudge, or relax option is available, so that the time is accounted for.
40. As a user, I want to mark a specific future date as a vacation day for a specific strict activity, so that the system knows not to schedule it.
41. As a user, I want the daily plan generator to exclude activities on a vacation day, so that the timeline remains accurate.
42. As a user, I want the daily carry-over logic to prorate the daily target to 0 for activities on a vacation day, so that taking time off does not create an artificial deficit.
43. As a user, I want to see a "Vacation Day" badge in the sidebar next to the affected activity, so that I can visually confirm the day off is recognized.
44. As a user, I want the system to detect activities that span midnight and freeze their remainder as a fixed anchor in the new day's timeline, so that the overnight schedule generator cannot displace them.
45. As a user, I want to see a lock icon and "Spanning from yesterday" label on overnight activities, so that I can visually distinguish them.
46. As a user, I want to finish a spanning activity early from Focus Mode, so that the system records my actual wake time and frees the remaining gap.
47. As a user, I want to receive an FCM push notification 5 minutes before an activity starts, so that I can mentally prepare.
48. As a user, I want the app to automatically transition an activity to "In Progress" and start its countdown timer at the scheduled start time, so that the schedule advances even if I forget.
49. As a user, I want the system to send a reality-check FCM notification with quick actions if I have not interacted with the app 15 minutes after an activity auto-starts, so that the solver's data does not drift.
50. As a user, I want to tap "Delayed 15m" or "Skip" directly from the notification tray, so that I can adjust the schedule without opening the full app.
51. As a developer, I want the app to evaluate contested gaps using Weighted Deficit Priority, so that the activity furthest behind relative to its base target gets the slot.
52. As a user, I want to author each activity once as a global definition carrying its own rules, so that the scheduler can reuse it across days without re-entering constraints.
53. As a user, I want to set a system-wide Overlap Rule so that a host activity (e.g., Work) can be overlapped by an allowed set of guest activities (e.g., Lunch) for a bounded total of minutes, without shrinking or deleting the host block.
54. As a user, I want to give an activity either a Preferred Window or a Strict Window but never both, so that I can express whether its time boundaries are negotiable or hard.
55. As a developer, I want rules grouped into mutually-exclusive categories, so that an activity cannot hold contradictory constraints (e.g., both a strict and a preferred window) and the solver can assume one rule per category.
56. As a developer, I want every rule classified as Hard or Soft, so that the solver knows which constraints form the immovable skeleton and which are relaxable during the cascade.
57. As a user, I want to add a one-time activity bound to a specific date (either strict like a doctor appointment or flexible like a one-off task), so that I can capture single occurrences without creating a recurring definition.
58. As a user, I want a one-time activity to appear only on its date and be invisible to the daily generator on every other day, so that it does not clutter future schedules.
59. As a user, I want one-time activities to be exempt from carry-over, so that an unmet one-off target lapses cleanly instead of snowballing into a rolling deficit.
60. As a developer, I want the daily generator to pull one-time activities whose date matches today alongside recurring activities whose allowed-days match today, so that both are placed under the same rules.

## Implementation Decisions

- **Architecture**: Next.js/React frontend with a client-side solver. Turso (SQLite) for persistence. FCM for push notifications.
- **Solver Engine**: The scheduler runs entirely in the browser as a pure function. It takes the current timeline state and an event (e.g., "Finish Early", "Overlap Detected") and returns the new timeline state.
- **Rules Model**: Activities are global definitions carrying typed rules. Each rule is scoped system-wide or per-activity, grouped into mutually-exclusive categories (at most one rule per category per activity), and classified Hard or Soft. The solver consumes this classification directly rather than branching on named activity flags.
- **Overlap Rule (system-wide)**: A host activity declares an overlap budget (minutes) and an allowed-guest set. Guests are carved out of the host's span up to the budget. The budget is scoped per host *instance* and expires when that instance ends. This supersedes the standalone "Is Container" flag; the container in the phased plan is its canonical instance.
- **Temporal Placement Rule (activity-level, exclusive)**: An activity carries either a Preferred Window (soft, relaxable by the cascade) or a Strict Window (hard boundary, but the block floats inside it) — never both. Absence of either means the activity may be placed anywhere.
- **Recurrence Rule (activity-level, exclusive)**: An activity is either Recurring (allowed-days set, re-evaluated by the generator every matching day, subject to carry-over) or One-Time (bound to a single date, placed only on that date, exempt from carry-over). One-time definitions are queried by date rather than by allowed-days and become inert after their date passes. This subsumes the existing allowed-days property under the Recurring option.
- **Iterative Constraint Relaxation Cascade**: When a high-priority activity needs a slot occupied by a lower-priority one, the solver applies: 1. Shrink (down to min block), 2. Nudge (within preferred window), 3. Relax (drop preferred window), 4. Displace & Bank (delete and add to deficit).
- **Hard Constraints**: Strict activities, Pinned blocks, and frozen midnight-spanning blocks are immovable. The solver rejects overlaps between two Hard Constraints.
- **Spare Time Bank**: Scoped to the parent container instance. Expires when the container ends. Triggers a UI prompt for quick actions.
- **Carry-over Logic**: Two-way rolling daily carry-over. Configurable per activity. Capped by a Daily Maximum. Prorated to 0 for vacation days.
- **Daily Generation**: Runs automatically on app open if the current date is past 2:00 AM and no plan exists. Places strict blocks/transitions first, then fills gaps with flexible activities based on Weighted Deficit Priority.
- **FCM Integration**: 5-minute pre-start warnings. Auto-start at scheduled time. 15-minute reality-check notification with quick actions if app is inactive.

## Testing Decisions

- **Good Test Definition**: Tests should verify external behavior (timeline state transitions, deficit calculations, validation rejections) rather than implementation details (specific function calls).
- **Primary Seam - Solver Engine**: The core logic will be tested via unit tests passing mock timeline states and events, asserting the output state. This is the highest priority seam.
- **Secondary Seam - UI/E2E**: End-to-end tests will simulate user interactions (clicking "Finish Early", "Extend", adding overlapping activities) to verify the UI correctly triggers the solver and renders the updated state.
- **Prior Art**: The solver tests will resemble reducer/state machine tests (input state + action = output state).

## Out of Scope

- Server-side background jobs (all generation and recalculation happens on client open or via FCM intents).
- Multi-user or shared scheduling.
- Complex recurring rules (RRULE) for strict activities.
- Automated time-tracking via external APIs or device sensors.

## Further Notes

The success of this application relies heavily on the performance of the client-side solver. Because it runs on every UI interaction and FCM event, it must be highly optimized. The Turso database schema should be flat, using relational links for activities to their transitions and scheduled instances to their parent containers.