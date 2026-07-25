## 1. Problem Statement
Users struggle to balance strict full-time work, freelance goals, learning, and personal time. Static calendars break when reality hits—delays, early finishes, and urgent tasks cause cascading failures in a daily schedule. Existing tools do not dynamically recover missed time or respect complex constraints like commute transitions, interruptible work blocks, and minimum focus sessions. Users need a system that automatically plans their day based on rolling deficits, dynamically adjusts in real-time when reality diverges from the plan, and ensures goals are met without manual schedule micromanagement.

## 2. Solution Overview
A dynamic scheduling application where every activity is a reusable global definition governed by typed rules. The server acts as the source of truth and houses the scheduling engine. It automatically generates daily plans, prioritizes activities based on rolling deficits, and reactively recalculates the schedule when activities finish early, run late, or get displaced. 

The engine uses an Iterative Constraint Relaxation solver to shrink, nudge, or displace lower-priority blocks to make room for reality, ensuring time is always accounted for and optimized.

## 3. Core Architecture & Concepts

### 3.1 Template vs. Execution Separation
The system strictly separates the *definition* of an activity from its *execution* on a given day.
*   **Activity (Template):** A global, recurring definition created by the user (e.g., "Office Work", "Freelance Project"). It contains base properties, an `allowed_days` schedule, and serves as the anchor for rules.
*   **Timeline (Execution):** A concrete instance of a day. When the server generates a timeline, it clones relevant Activity templates into `TimelineActivities`. This ensures historical schedules remain frozen and immutable, even if the user updates the global template tomorrow. Users can also create on-demand, one-off `TimelineActivities` directly on the timeline that have no parent template.

### 3.2 The Rules System
Constraints are not hardcoded boolean flags. They are polymorphic, typed rules attached to an Activity. An Activity can have multiple rules, but only **one rule per type**. Rule types include:
1.  **Overlap Rule:** Defines an overlap budget (in minutes) and permits a set of other activities (guests) to overlap the host activity. (e.g., An 8h "Office Work" host may be overlapped by "Lunch" for up to 60 minutes).
2.  **Window Rule:** Defines a strict or flexible time window (`start_time`, `end_time`). If strict, the activity cannot leave this boundary. If flexible, the solver may relax the window under pressure.
3.  **Sequence Rule:** Defines pre- or post-activities. This replaces traditional "transitions." For example, a "Commute" activity can be linked as a pre-sequence to "Office Work". Because the commute is its own activity, it can carry its own `Overlap Rule` (e.g., allowing a "Learning Podcast" to overlap the commute).
4.  **Tracking Rule:** Defines a daily target goal (in minutes) and whether carry-over is enabled.

### 3.3 Tracking & Carry-Over Logic
*   **Tracking Ledger:** A single, mutating record attached to an Activity Template that stores `rolling_target_minutes` and `rolling_achieved_minutes`.
*   **Lazy Evaluation:** Carry-over is not calculated by a midnight cron job. When the user opens the app on a new day, the server lazily evaluates yesterday's `TimelineActivities`. If a tracked activity missed its target, the deficit is added to the `TrackingLedger` and increases today's target before the new timeline is generated.
*   **Caps & Proration:** Daily targets can be capped to prevent snowballing impossible workloads. Vacation days prorate targets to zero without creating deficits.

### 3.4 Implicit Free Time & Transient State
*   **Free Time:** The system does not generate "Free Time" blocks. Free time is implicitly calculated by the UI as the gaps between explicit `TimelineActivities`.
*   **Spare Time Bank:** When a user finishes an overlapping guest activity early (e.g., finishes lunch in 20 minutes instead of 40), the remaining 20 minutes is a transient solver state. The server holds this in memory to prompt the user with quick-task options, but it is not persisted as a database entity unless the user explicitly selects an activity to fill it.

## 4. System Architecture

*   **Backend & Solver:** The scheduling engine runs on the server. It is a pure function that takes a timeline state and an event (e.g., "Finish Early", "Add Strict Block") and returns the new timeline state. The server handles all constraint resolution, cascade logic, and timeline generation.
*   **Database:** A flat relational database schema (PostgreSQL or Turso/SQLite). UUIDs are used for all primary keys to allow the client to optimistically update the UI before server confirmation.
*   **Client:** A frontend application (Next.js/React) that renders the timeline, handles user interactions, and communicates with the server for state recalculations.

## 5. User Stories

### Activity & Rule Configuration
1.  As a user, I want to author global Activity templates (e.g., "Work", "Gym") and define which days of the week they are allowed to occur on.
2.  As a user, I want to attach a Window Rule to an activity, defining a strict or flexible time window so the solver knows when to place it.
3.  As a user, I want to attach an Overlap Rule to a host activity, setting a budget in minutes and designating specific guest activities that are allowed to interrupt it.
4.  As a user, I want to link activities together using a Sequence Rule (e.g., linking "Commute" as a pre-activity to "Work") so they are scheduled adjacently.
5.  As a user, I want to attach a Tracking Rule to an activity to set a daily target goal in minutes and enable rolling carry-over for deficits.

### Daily Generation & Carry-Over
6.  As a user, I want the server to automatically generate my daily timeline when I open the app, placing strict blocks first and filling gaps with flexible, tracked activities based on priority.
7.  As a user, I want the server to lazily evaluate yesterday's completed timeline when I open the app, rolling any missed time forward to increase today's target.
8.  As a user, I want my daily target capped by a maximum limit so that rolling deficits cannot snowball into impossible daily loads.
9.  As a user, I want to mark a future date as a vacation day for a specific activity so its target is prorated to zero and it is excluded from the timeline.

### Execution & Reality Divergence
10. As a user, I want to create a one-off, on-demand activity directly on the timeline that does not affect my global templates.
11. As a user, I want to press "Finish Early" on an active activity so the server logs my actual time and recalculates the forward schedule.
12. As a user, I want the server to automatically fill the freed gap with another tracked activity that has an outstanding deficit.
13. As a user, I want the server to respect minimum block sizes when attempting to fill freed gaps so my schedule isn't fragmented.
14. As a user, I want to click "Extend +15m" during an active activity so the server validates it against subsequent blocks and nudges lower-priority blocks forward if necessary.
15. As a user, I want to toggle a "Pin Block" setting on a scheduled flexible activity so the solver treats it as an immovable hard constraint.

### Overlaps & Spare Time
16. As a user, I want the timeline to visually render nested blocks inside their parent host container so I can clearly see my schedule hierarchy.
17. As a user, I want the server to automatically detect when I finish an interrupting guest activity early and bank the spare time.
18. As a user, I want a UI prompt to appear when spare time is banked, offering quick allowed-interrupters whose minimum block size fits the spare time.
19. As a user, I want to select a quick activity from the prompt so it immediately enters Focus Mode, or discard the spare time to just rest.

### Manual Scheduling
20. As a user, I want to manually schedule a block of a flexible activity into a specific time slot, so that I can place it myself rather than relying on the solver.
21. As a user, I want to manually place an allowed guest activity inside a host's Overlap Rule budget, so that I can dictate exactly when my interrupter (like Lunch) occurs.

### Validation & Warning States
22. As a user, I want to see a warning badge on a flexible activity when its daily target cannot be fully scheduled, so that I know my daily goal is at risk.
23. As a user, I want the server to reject saving a strict activity if it overlaps an immovable block, so that I am forced to resolve the conflict manually.

### Midnight Spanning
24. As a user, I want the system to detect activities that span midnight and freeze their remainder as a fixed anchor in the new day's timeline, so that the overnight schedule generator cannot displace them.
25. As a user, I want to see a lock icon and "Spanning from yesterday" label on overnight activities, so that I can visually distinguish them.
26. As a user, I want to finish a spanning activity early from Focus Mode, so that the system records my actual wake time and frees the remaining gap.

### Notifications & Auto-Start
27. As a user, I want to receive an FCM push notification 5 minutes before an activity starts, so that I can mentally prepare.
28. As a user, I want the app to automatically transition an activity to "In Progress" and start its countdown timer at the scheduled start time, so that the schedule advances even if I forget.
29. As a user, I want the system to send a reality-check FCM notification if I have not interacted with the app 15 minutes after an activity auto-starts, so that the solver's data does not drift.
30. As a user, I want to tap "Delayed 15m" or "Skip" directly from the notification tray, so that I can adjust the schedule without opening the full app.

### Focus Mode UI
31. As a user, I want to press "Start" on an upcoming activity to enter a "Focus Mode", so that I can see a large countdown timer without distractions.
32. As a user, I want selecting a quick activity from a spare-time prompt to immediately enter Focus Mode for that activity, so that I can begin without additional clicks.
33. As a user, I want the system to automatically return me to the parent container's Focus Mode timer when a spare-time activity ends, so that I seamlessly resume my main work.

## 6. Out of Scope
*   **Client-side generation:** The client does not calculate schedules; all solver logic is server-side.
*   **Complex RRULE scheduling:** (e.g., "Every 3rd Tuesday of the month"). Only simple `allowed_days` arrays are supported.
*   **Multi-user collaboration:** Schedules are single-tenant.
*   **Automated external time-tracking:** Time logged must be triggered by user action (e.g., pressing "Finish Early" or auto-starting at the scheduled time).