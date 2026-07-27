## Problem Statement
Users struggle to balance strict full-time work, freelance goals, learning, and personal time. Static calendars break when reality hits—delays, early finishes, and urgent tasks cause cascading failures in a daily schedule. Existing tools do not dynamically recover missed time or respect complex constraints like commute transitions, interruptible work blocks, and un-interruptible focus sessions. Users need a system that automatically plans their day based on fixed durations and priorities, dynamically adjusts in real-time when reality diverges from the plan, and ensures time is accounted for without manual schedule micromanagement.

## Solution
A dynamic scheduling application where every activity is a reusable global definition governed by typed rules. The server acts as the source of truth and houses the scheduling engine. It automatically generates daily plans, prioritizes activities based on explicit ranks, and reactively recalculates the schedule when activities finish early, run late, or get displaced. 

The engine uses an Iterative Constraint Relaxation solver to nudge, shrink, or displace lower-priority blocks to build a schedule. All schedule caluculations happen on the server.

## User Stories

### Activity & Rule Configuration
1. As a user, I want to author global Activity templates (e.g., "Work", "Gym") and define which days of the week they are allowed to occur on, so that my schedule reflects my recurring availability.
2. As a user, I want to assign a priority rank to an Activity template, where i can drag and drop activtities list to rank them, so that the solver knows which activities take precedence when competing for the same time slots.
3. As a user, I want to attach a Strict Window/Flexible Window rule to an activity (mutually exclusive, only one of them allowed on same activity) , defining a strict or flexible time window, so that the solver knows when to place it. strict means that the activity MUST be placed within that window, a  flexible window is like preferred window, the activity can overflow the window or start early a little bit if the schedule is crowded when other activities kick the activitiy of flexible window out of its flexible window, but the flexible window have maximum drift
4. As a user, I want to define a `max_drift_minutes` (maximum number of minutes of the activity that are actually outside of the defined window) property on a flexible Window Rule, so that the solver cannot push the activity into unreasonable hours.
5. As a user, I want to attach an Overlap Rule to a host activity, setting a shared budget in minutes and designating specific guest activities that are allowed to interrupt it, so that overlapping tasks do not overrun my day.
6. As a user, I want to define named Exclusion Windows within an Overlap Rule (e.g., "Focus Hour", "Customer Meeting"), so that the solver treats those specific time slices as un-interruptible by overlapping guests.
7. As a user, I want to link activities together using a Sequence Rule (e.g., linking "Commute" as a pre-activity to "Work"), so they are scheduled adjacently.
8. As a user, I want to attach a Shrink Rule to an activity, defining the minimum duration it can shrink down to, so that the solver respects my need for focused, non-fragmented work blocks. so instead of completly dismissing an activity, we can squize part of an activity, however the resolver might use this to try to cover the activity duration in the system, so it can create multiple TimelineActivity with smaller amounts to cover the whole duration in smaller chunks, however having full durations instead of chunking is always preferred
9. As a user i want to be abble to attach Mandatory Rule to an activity, so that the solver respects my need that this activity is very important and cannot be skipped
10. As a user i want to be able to attach Fixed Rule to an activity, so that the solver respects my need that this activity have fixed start/end time that is not negotiable (mutually exclusive with Strict Window, Flexible Window rules)

### Daily Generation & Execution
9. As a user, I want the server to automatically generate my daily timeline, it always figure out the best possible schedule based on the defined rules
10. As a user, I want the server to backdate and mark activities prior to the current time as "Completed" if I open the app late, so that the schedule advances forward without requiring manual starts for missed time.
11. As a user, I want the server to automatically transition activities to an "Active" state at their scheduled start times, so that the schedule advances even if I forget to open the app.
12. As a user, I want to see an "Active" state UI showing a large countdown timer for the currently running activity, so that I can track my progress without distractions. with actions like "Finish Early", Extend +5m" to extend it
13. As a user, I want to press "Finish Early" on an active activity, so that the server logs my actual time and checks if i can use this free time for something useful based on the activites and rules if possible, otherwise it should keep it as implecitly free gaps in the schedule (no special free block needed, just a time wthout any blocks)
14. As a user, I want to click "Extend +5m" during an active activity, so that the server validates it against subsequent blocks and nudges lower-priority blocks forward if necessary.
15. As a user, I want the server to reschedule the rest of the day when i extend an activity or finish early, so i at all times have a very optimized schedule

### Overlaps & Spare Time
23. As a user, I want Exclusion Windows to act as sub-activities within the host duration, so that marking time as un-interruptible does not consume or extend the host's overall duration or overlap budget.

### Manual Scheduling & Ad-hoc Changes
24. As a user, I want to create a one-off, ad-hoc activity directly on the timeline, so that I can handle sudden tasks without mutating my global templates.
25. As a user, I want to apply the same complex rule to ad-hoc activities at creation time, so that they participate fully in the solver's constraint logic.
26. As a user, I want to explicitly edit a host TimelineActivity's Overlap Rule instance to permit an ad-hoc activity as a guest, so that I can dictate overlaps for a single day without affecting the global template.

### Validation & Reality Divergence
28. As a user, I want the server to reject saving a strict activity if it overlaps another strict activity and cannot be resolved, so that I am forced to resolve hard conflicts manually.
29. As a user, I want the server to skip the pre-activity if the host activity is displaced entirely, so that the system does not schedule a commute to a skipped location.
30. As a user, I want the server to mark an activity as "Skipped" for today if it cannot fit within its constraints, so that it disappears from the timeline and notifies me rather than snowballing.
31. As a user, I want to finish a midnight-spanning activity early, so that the system records my actual time and frees the remaining gap as implicit Free Time.
32. As a user, I want to see a lock icon and "Spanning from yesterday" label on overnight activities, so that I can visually distinguish them as fixed anchors in the new day's timeline.

## Implementation Decisions

### Architecture & Client/Server Boundary
*   **No Optimistic UI Updates:** The client must wait for the server's calculated timeline state before rendering changes. A local loading/skeleton state is shown on modified blocks while waiting for the API response.
*   **Pure Solver Function:** The scheduling engine runs on the server as a pure function. It takes a timeline state and an event (e.g., "Finish Early", "Add Strict Block") and returns the new timeline state.
*   **Auto-Start Assumptions:** If an activity auto-starts and finishes without user interaction, the server assumes perfect completion. No reality-check notifications exist to correct this.

### Data Model & Rules System
*   **Template vs. Execution:** `Activity` templates are global definitions. `TimelineActivity` instances are cloned for a specific day. Historical schedules remain immutable.
*   **Priority-Based Scheduling:** Activities are prioritized by an explicit `priority` integer. The solver schedules based purely on fixed `duration` and `priority`. There are no tracking ledgers, goals, or rolling deficits.
*   **Rule Instances:** Rules can be mutated on the `TimelineActivity` instance for a specific day. These mutations override global template rules and are respected by all subsequent solver recalculations.
*   **Exclusion Windows:** Named sub-activities inside a host activity. They do not affect the host's total duration. They define un-interruptible regions where no overlapping guest activities can be placed.
*   **Overlap Budgets:** Allowed guest activities share a single pool of overlap time defined on the host (e.g., 60 minutes total for all guests combined).
*   **Sequence Binding:** The Sequence Rule binds the end time of a pre-activity to the start time of a host activity. If the host is displaced (skipped), the pre-activity is also skipped.
*   **Shrink Floors:** The `Shrink Rule` defines a hard minimum duration. The solver cannot shrink an activity below this floor.

### Solver Constraint Resolution Hierarchy
When the schedule is under pressure (e.g., a strict block runs late and pushes into a flexible block), the solver uses the following strict order of relaxation:
1.  **Nudge:** Delay lower-priority blocks forward.
2.  **Shrink:** Reduce duration of lower-priority blocks down to their `Shrink Rule` floor.
3.  **Displace:** Skip lower-priority blocks entirely, marking them as "Skipped" for the day.

### Strict Rule Rejections
The server returns hard validation errors (rejecting the operation) under the following conditions:
*   Two strict activities overlap.
*   Extending an active activity pushes a subsequent activity outside its strict Window Rule.
*   Extending a pre-activity pushes the host outside its strict Window Rule.
*   Moving a host with a nested guest causes the guest to violate its strict Window Rule.

## Testing Decisions
All testing for this feature will be conducted manually by the developer. Focus manual testing on the following external behaviors:
*   **Solver Constraint Resolution:** Verify the solver correctly applies the Nudge -> Shrink -> Displace hierarchy when schedule conflicts arise.
*   **Rule Rejections:** Verify the server rejects operations that violate strict Window Rules (e.g., overlapping two strict blocks, extending an activity past a strict window).
*   **Instance Mutations:** Verify that mutating a rule on a `TimelineActivity` instance persists through subsequent solver recalculations without reverting to the template.
*   **Client/Server Sync:** Verify the client renders the loading state and does not optimistically update the UI while waiting for the server's response.
