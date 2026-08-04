# Feature Specification: Manual Activity Scheduling & Timeline

**Feature Branch**: `[001-manual-activity-scheduling]`

**Created**: 2026-07-25

**Updated**: 2026-07-25 (pivoted to a rules-based architecture; the Phase 4 "Container" model is now the canonical instance of the system-wide Overlap Rule)

**Status**: Draft

**Input**: User description: "Move the system to a rules-based architecture. Activities become global definitions governed by typed rules rather than one-off timeline entries with ad-hoc flags. The Phase 4 'Container' hack is replaced by a system-wide Overlap Rule: a host activity may be overlapped by an allowed-guest set for a bounded total of X minutes, modelling parallel reality (e.g. Lunch and 'Walk to Food Court' overlapping Work) instead of a nested hierarchy. Temporal placement becomes an exclusive choice of Preferred Window (soft) or Strict Window (hard). Recurrence becomes an exclusive choice of Recurring (allowed-days + carry-over) or One-Time (specific date). Phases 1–4 detailed: (1) view timeline + create a strict activity, (2) pre/post transitions, (3) flexible activities with daily target / minimum block / temporal window, (4) the Overlap Rule (host overlap budget + allowed guests). Complexity warning: when overlap is allowed, the system MUST track actual time spent vs. scheduled time so a 30-minute lunch overlapping an 8-hour workday does not count as 8h30m of logged time toward daily targets."

## Rules Model (Cross-Cutting Concept)

Activities in this system are **global definitions** governed by **rules**, not one-off timeline entries. A definition is authored once, and the scheduler instantiates it as one or more **blocks** on a given day. Constraints are expressed as **typed rules** rather than ad-hoc boolean flags, so validation evaluates a block against its rule set instead of special-casing each individual property.

Rules have three defining traits:

- **Scope** — a rule is either **system-wide** (applies across all activities, e.g. the Overlap Rule) or **activity-level** (attached to one activity definition).
- **Category** — rules are grouped into **mutually-exclusive categories**; an activity holds **at most one** rule per category (e.g. an activity may have _either_ a Preferred Window _or_ a Strict Window, never both).
- **Classification** — a rule is **Hard** (immovable; a violating block is rejected) or **Soft** (a preference that may be relaxed when the schedule is worked out).

Three rules are referenced by the phases in this feature:

- **Overlap Rule (system-wide)** — a **host** activity may be overlapped by a designated **allowed-guest set** for a bounded total of **X minutes** (the host's _overlap budget_). Each guest block is carved out of the host's span, consuming part of the budget. This replaces the earlier "Container + interruptible minutes + allowed interrupters" model; the two describe the same behaviour, but the Overlap Rule frames it as **parallel reality** (guest and host occupy the same wall-clock time) rather than a nested hierarchy. **Consequence for accounting**: overlapping time is counted once, not twice — a 30-minute guest overlapping an 8-hour host does not produce 8h30m of logged time toward any daily target.
- **Temporal Placement (activity-level, exclusive)** — an activity carries either a **Preferred Window** (Soft; a block should fall inside it but may be placed outside) or a **Strict Window** (Hard; a block must stay within it but may float to any position inside it) — never both.
- **Recurrence (activity-level, exclusive)** — an activity is either **Recurring** (carries an allowed-days set and is re-evaluated on each matching day, subject to carry-over) or **One-Time** (bound to a single specific date). Recurrence is introduced here as part of the model; the phases that exercise it are **out of scope for this feature** (see Assumptions) and are not covered by the user stories below.

The user stories below reframe the four detailed phases in terms of this model.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - View the daily timeline and record a fixed activity (Priority: P1)

A user opens the application and sees a timeline for the current day. If nothing is scheduled yet, the timeline is empty. The user adds a new activity by providing a name, a start time, an end time, and choosing "Strict" as its constraint type — creating an activity whose Temporal Placement is a **Strict Window** at fixed exact times. After saving, the activity appears immediately on the timeline as a single block spanning its start and end time.

**Why this priority**: This is the foundational capability — without a visible timeline and the ability to record a fixed appointment, no other rule has anything to attach to or display against. It is the smallest possible slice that delivers real value (a persisted, visible daily record).

**Independent Test**: Can be fully tested by opening the app with no existing data (empty timeline), creating one Strict activity with a name/start/end, saving it, and confirming it renders as a single correctly-positioned block on the timeline after the save.

**Acceptance Scenarios**:

1. **Given** no activities exist for the current date, **When** the user opens the application, **Then** the timeline view renders with no blocks.
2. **Given** the timeline view is open, **When** the user clicks "Add Activity", fills in Name = "Morning Standup", Start = 10:00, End = 10:30, Constraint Type = "Strict", and clicks "Save", **Then** the activity definition is persisted and the user is returned to the timeline view.
3. **Given** an activity was just saved, **When** the timeline view renders, **Then** it displays exactly one block labeled with the activity's name, positioned from its start time to its end time.
4. **Given** the user provides an End Time that is not after the Start Time, **When** the user attempts to save, **Then** the system rejects the save and the activity is not persisted.

---

### User Story 2 - Attach pre- and post-transitions to an activity (Priority: P2)

While creating an activity, the user optionally adds a pre-transition (e.g., a commute before the activity) and/or a post-transition (e.g., a commute after it), each with its own name, start time, and end time. On save, the transitions are stored linked to the parent activity, and the timeline renders them as adjacent blocks surrounding the main activity.

**Why this priority**: Transitions extend the core activity model from Story 1 and are only meaningful once basic activity creation and display exist. They add real-world accuracy (commute/prep time) but are not required for the timeline to be useful at all.

**Independent Test**: Can be fully tested by creating an activity with both a pre-transition and a post-transition, saving it, and confirming the timeline shows three sequential, adjacent blocks in the correct chronological order.

**Acceptance Scenarios**:

1. **Given** the Add Activity form is open, **When** the user checks "Add Pre-Transition", **Then** fields for the transition's Name, Start Time, and End Time appear.
2. **Given** the user has filled in a pre-transition ("Commute", 08:00–10:00), the main activity ("Office Work", Strict, 10:00–18:00), and a post-transition ("Commute Home", 18:00–19:30), **When** the user clicks "Save", **Then** the main activity and both transitions are persisted, with each transition linked to the main activity.
3. **Given** an activity with both transitions was saved, **When** the timeline view renders, **Then** it displays three blocks in chronological order — pre-transition, main activity, post-transition — positioned according to their respective times.
4. **Given** the user only checks "Add Pre-Transition" (not post), **When** the activity is saved, **Then** only the main activity and the pre-transition are persisted and rendered.

---

### User Story 3 - Define and manually schedule flexible activities (Priority: P3)

The user creates an activity with constraint type "Flexible", specifying a daily target duration and a minimum block duration instead of fixed start/end times, and choosing its **Temporal Placement** rule — either a **Preferred Window** (soft; blocks should fall inside it) or a **Strict Window** (hard; blocks must stay inside it). The activity appears in a "Flexible Activities" sidebar showing progress toward its daily target. The user then manually schedules a block for it by choosing a start time; the system computes the end time from the minimum block duration, validates the result against the chosen temporal-placement rule and existing blocks, and — if valid — saves it and updates the timeline and the sidebar progress.

**Why this priority**: Flexible activities are a distinct scheduling model from fixed-time activities and depend on the timeline already existing (Story 1). They deliver goal-tracking value independently of transitions or the Overlap Rule.

**Independent Test**: Can be fully tested by creating one Flexible activity, confirming it appears in the sidebar at "0h / target", scheduling one manual block for it, and confirming both the timeline and the sidebar progress update to reflect the new block.

**Acceptance Scenarios**:

1. **Given** the Add Activity form is open, **When** the user selects Constraint Type = "Flexible", **Then** the Start/End Time fields are replaced with Daily Target (hours), Minimum Block (hours), and a Temporal Placement choice offering either a Preferred Window or a Strict Window (start/end).
2. **Given** the user is defining a Flexible activity, **When** they choose a Temporal Placement, **Then** they may set **either** a Preferred Window **or** a Strict Window but not both (the categories are mutually exclusive).
3. **Given** the user enters "Freelance", Daily Target = 4h, Minimum Block = 2h, Preferred Window = 18:00–23:00, and saves, **When** the timeline view renders, **Then** the "Flexible Activities" sidebar lists "Freelance" with progress "0h / 4h".
4. **Given** the "Freelance" activity exists, **When** the user clicks "Schedule Block", enters a start time of 19:00, and confirms, **Then** the system computes an end time of 21:00 (using the 2-hour minimum block), validates it against the activity's temporal-placement rule (falls within 18:00–23:00) and that it does not overlap existing blocks, and saves it.
5. **Given** a block was successfully scheduled, **When** the timeline and sidebar re-render, **Then** the timeline shows the "Freelance" block from 19:00–21:00 and the sidebar shows "2h / 4h".
6. **Given** a proposed block violates the activity's temporal-placement rule — outside a **Strict Window**, or outside a **Preferred Window** — or overlaps an existing block, **When** the user confirms, **Then** the system rejects the block for a Strict Window violation or an overlap, and does not persist it. (A Preferred Window is soft; see Edge Cases for how a soft violation is handled.)

---

### User Story 4 - Overlap a host activity with allowed guests (Overlap Rule) (Priority: P4)

The user creates a Strict activity and enables the system-wide **Overlap Rule** on it, making it a **host**: they set an **overlap budget** (a bounded number of minutes the host may be overlapped) and an **allowed-guest set** (the activities permitted to overlap it). From the host's detail panel, the user schedules an allowed guest at a specific start time. The system validates that the activity is an allowed guest, that the guest block fits within the host's bounds, and that its duration does not exceed the host's remaining overlap budget, then saves it and renders it overlapping the host's block. The host's span and logged duration are unchanged by the overlap — the guest and host occupy the same wall-clock time (parallel reality), so the overlapping minutes are counted once, not added on top of the host.

**Why this priority**: This is the most advanced scheduling rule in this feature set — it composes fixed activities (Story 1) and flexible activities (Story 3) into a parallel-time relationship, and is the least essential for a minimally usable daily timeline.

**Independent Test**: Can be fully tested by creating a host activity with an overlap budget and one allowed guest, scheduling that guest to overlap it, and confirming the guest block renders over the host while the host's remaining overlap budget decreases and the host's own logged duration is unchanged.

**Acceptance Scenarios**:

1. **Given** the Add Activity form is open and Constraint Type = "Strict", **When** the user enables the Overlap Rule ("Is Container" / "Allow overlap"), **Then** an overlap-budget field ("Interruptible Minutes") and an allowed-guest multi-select ("Allowed Interrupters") of existing Flexible activities appear.
2. **Given** the user creates "Fulltime Work" (Strict, 10:00–18:00, Overlap Rule enabled, overlap budget = 60 minutes, allowed guests = ["Lunch"]) and saves, **When** the user opens its detail panel, **Then** it displays "Interruptible Capacity: 60 mins" (remaining overlap budget).
3. **Given** the host's detail panel is open, **When** the user clicks "Schedule Inside", enters start time 13:00, and selects "Lunch" (minimum block 30 minutes), **Then** the system validates that "Lunch" is an allowed guest, that 13:00–13:30 falls within the host bounds 10:00–18:00, and that 30 minutes does not exceed the 60-minute remaining budget, then saves the overlapping guest block.
4. **Given** a guest block was successfully saved, **When** the timeline and detail panel re-render, **Then** the timeline shows "Lunch" overlapping "Fulltime Work" from 13:00–13:30, the detail panel shows "Interruptible Capacity: 30 mins remaining", and the host "Fulltime Work" still reports its full 10:00–18:00 span (no added minutes from the overlap).
5. **Given** the user selects an activity that is not in the host's allowed-guest set, or a time/duration that would exceed the host's bounds or remaining overlap budget, **When** the user attempts to save, **Then** the system rejects the guest block and does not persist it.

---

### Edge Cases

- What happens when the user provides an End Time at or before the Start Time for a strict activity or a transition? The system MUST reject the save.
- What happens when a pre- or post-transition's time range does not exactly abut the main activity's start/end (e.g., leaves a gap)? The system displays it positioned at its own recorded times; no adjacency enforcement is performed.
- What happens when a Flexible activity has no manually scheduled blocks yet? It appears only in the sidebar at "0h / target" with no corresponding timeline block.
- What happens when manually scheduled blocks push a Flexible activity's total scheduled time beyond its daily target? The system allows it and reflects the over-target progress in the sidebar (no cap is enforced by this feature).
- How does a **Strict Window** differ from a **Preferred Window** on a manually placed block? A block violating a **Strict Window** (Hard) MUST be rejected; a block violating a **Preferred Window** (Soft) is accepted and persisted, but MUST be surfaced to the user as a preference violation (e.g., visually flagged) rather than silently allowed.
- What happens when the allowed-guest set is empty at the time the Overlap Rule is enabled on a host? The host is saved with an overlap budget but zero allowed guests; the user cannot yet schedule any guest to overlap it.
- What happens when a user attempts to designate a host activity as its own allowed guest? The host's own activity MUST be excluded from its allowed-guest set (no self-overlap).
- What happens when the selected guest's minimum-block duration would extend past the host's own end time? The system MUST reject the guest block (it must fit within the host bounds).
- How is time accounted when a guest overlaps a host? The overlapping wall-clock minutes are counted once. The guest's minutes contribute to the guest activity's own daily progress, and the host's logged duration remains its own span; the overlap MUST NOT inflate total logged time (e.g., a 30-minute lunch inside an 8-hour workday yields 8h of work + 30m of lunch across the same clock window, never 8h30m of combined logged time).

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST render a timeline view showing all activities and blocks scheduled for the current calendar date.
- **FR-002**: The system MUST display an empty timeline when no activities are scheduled for the current date.
- **FR-003**: Users MUST be able to open an "Add Activity" form from the timeline view.
- **FR-004**: The Add Activity form MUST require an Activity Name and a Constraint Type selection of either "Strict" or "Flexible".
- **FR-005**: When Constraint Type is "Strict", the form MUST require a Start Time and an End Time, and MUST reject a save where the End Time is not after the Start Time.
- **FR-006**: The system MUST treat each activity as a reusable **global definition** carrying a set of typed rules, and MUST persist it so it remains available across app sessions and page reloads.
- **FR-007**: Upon saving an activity, the system MUST return the user to the timeline view, which MUST immediately reflect the newly saved activity without requiring a manual page refresh.
- **FR-008**: The timeline MUST render each fixed (Strict-Window) activity as a single block positioned and sized according to its Start Time and End Time.
- **FR-009**: The Add Activity form MUST offer optional "Add Pre-Transition" and "Add Post-Transition" toggles, each revealing Name, Start Time, and End Time fields when enabled.
- **FR-010**: The system MUST persist each transition as a distinct record linked to the parent activity it was created with.
- **FR-011**: The timeline MUST render an activity's pre-transition (if present), the activity itself, and its post-transition (if present) as sequential blocks in chronological order.
- **FR-012**: When Constraint Type is "Flexible", the form MUST replace the Start/End Time fields with required Daily Target (hours) and Minimum Block (hours) fields, plus a **Temporal Placement** choice.
- **FR-013**: The system MUST enforce that an activity's **Temporal Placement** is exactly one of a **Preferred Window** (Soft) or a **Strict Window** (Hard) — never both and (for a Flexible activity) never neither.
- **FR-014**: The system MUST display a "Flexible Activities" sidebar listing each Flexible activity with its progress for the current date, expressed as hours scheduled versus its Daily Target.
- **FR-015**: Users MUST be able to manually schedule a block for a Flexible activity by supplying a start time, from which the system computes the end time using the activity's Minimum Block duration.
- **FR-016**: The system MUST reject and not persist a manually scheduled Flexible block that violates a **Strict Window** (Hard) temporal-placement rule or that overlaps an existing block on the timeline.
- **FR-017**: When a manually scheduled Flexible block falls outside a **Preferred Window** (Soft) temporal-placement rule, the system MUST persist the block but MUST flag it to the user as a preference violation rather than rejecting it silently.
- **FR-018**: Upon successfully saving a manually scheduled Flexible block, the system MUST update both the timeline and the Flexible Activities sidebar progress indicator.
- **FR-019**: The Add Activity form MUST offer, for Strict activities, an option to enable the system-wide **Overlap Rule**, which when enabled reveals an **overlap-budget** field (interruptible minutes) and an **allowed-guest** multi-select of existing Flexible activities (excluding the activity being created — no self-overlap).
- **FR-020**: The system MUST persist a host activity's overlap budget and its allowed-guest set as part of its Overlap Rule.
- **FR-021**: Users MUST be able to open a detail panel for a host activity showing its current **remaining overlap budget**.
- **FR-022**: From a host's detail panel, users MUST be able to schedule an allowed guest to overlap the host by supplying a start time and selecting one activity from the host's allowed-guest set.
- **FR-023**: The system MUST reject and not persist an overlapping guest block if: the selected activity is not in the host's allowed-guest set; the block's time range falls outside the host's own time bounds; or the block's duration exceeds the host's remaining overlap budget.
- **FR-024**: Upon successfully saving an overlapping guest block, the system MUST reduce the host's remaining overlap budget by the block's duration and reflect the updated value in the detail panel.
- **FR-025**: The timeline MUST render overlapping guest blocks visually over their host's block (parallel-time overlap), distinguishable from the host's own uncovered time.
- **FR-026**: The system MUST account for overlapping time only once: an overlapping guest block MUST NOT add its duration to the host activity's logged duration or otherwise inflate total logged time for the day. The guest's duration counts toward the guest activity's own daily progress; the host's logged duration remains its own span.

### Key Entities

- **Activity Definition**: A reusable, global schedulable item identified by a name and a constraint type (Strict or Flexible), carrying a set of typed **rules**. Strict definitions carry a Strict-Window temporal placement at fixed times and may host the Overlap Rule; Flexible definitions carry a daily target duration, a minimum block duration, and exactly one Temporal Placement rule (Preferred or Strict Window).
- **Rule**: A typed constraint attached to an activity or applied system-wide, characterized by its scope (system-wide vs. activity-level), its mutually-exclusive category (at most one rule per category per activity), and its classification (Hard vs. Soft). Categories referenced here: **Temporal Placement**, **Overlap**, **Recurrence**.
- **Temporal Placement Rule**: An activity-level rule that is either a **Preferred Window** (Soft) or a **Strict Window** (Hard), defining the start/end bounds a block should or must respect.
- **Overlap Rule (host settings)**: The system-wide rule instantiated on a host activity: an **overlap budget** (bounded minutes) and an **allowed-guest set** (activities permitted to overlap the host).
- **Transition**: A named time block linked to exactly one parent Activity, marked as occurring before (pre) or after (post) it, with its own start and end time.
- **Scheduled Block**: A specific, manually placed occurrence of a Flexible activity on a given date's timeline, with a start time and end time, contributing to that activity's daily progress.
- **Overlapping Guest Block**: A specific occurrence of an allowed-guest activity scheduled to overlap a particular host block, with a start time and end time, consuming part of the host's remaining overlap budget while counting only once toward total logged time.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Users can create a Strict activity and see it correctly positioned on the timeline immediately after saving, with no manual refresh needed.
- **SC-002**: 100% of activities saved with a pre- and/or post-transition display all associated blocks adjacent to one another and in correct chronological order on the timeline.
- **SC-003**: Users can create a Flexible activity, choose exactly one Temporal Placement rule (Preferred or Strict Window), and immediately see it listed in the sidebar with accurate "0h / target" progress before any block is scheduled.
- **SC-004**: 100% of manually scheduled Flexible blocks that violate a Strict Window or overlap an existing block are rejected before being saved; and 100% of blocks that only violate a Preferred Window are saved and visibly flagged rather than silently accepted.
- **SC-005**: Sidebar progress for a Flexible activity reflects newly scheduled hours in the same interaction as the save, with no discrepancy between displayed and actual scheduled time.
- **SC-006**: 100% of overlapping guest block attempts that violate the allowed-guest set, host time bounds, or remaining overlap budget are rejected before being saved.
- **SC-007**: For any host with one or more overlapping guests, the host's reported logged duration equals its own span (overlap adds zero extra logged minutes), verifiable in 100% of overlap cases.
- **SC-008**: Users can visually distinguish top-level activities, transitions, and overlapping guest blocks on the timeline without additional explanation.
- **SC-009**: A user unfamiliar with the feature can complete the full flow of creating a host activity, assigning an allowed guest, and scheduling that guest to overlap it in under 2 minutes.

## Assumptions

- Only the current calendar date's timeline is in scope for this feature; navigating to or viewing past/future dates is out of scope.
- The **Recurrence** rule (Recurring with allowed-days + carry-over vs. One-Time on a specific date), the automated **generator/solver**, and any multi-day behaviour are introduced in the Rules Model as forward-looking concepts but are **out of scope for this feature** — all scheduling here is manual, single-day, current-date-only. The soft/hard classification of rules is enforced only for the specific validations described (Strict Window, overlap bounds/budget/allowed-guest); no automated relaxation cascade is built in this feature.
- Only creation and viewing are covered; editing or deleting existing activities, transitions, scheduled blocks, or overlapping guest blocks is out of scope for this feature.
- The Overlap Rule can be enabled only on Strict-type activities acting as hosts; Flexible activities cannot themselves be hosts in this feature. Allowed guests are selected only from existing Flexible activities, whose configured Minimum Block value determines the duration of an overlapping guest block.
- General overlap/conflict checking across arbitrary activities and transitions is out of scope; only the specific validations described are enforced (Flexible block temporal-placement/overlap; host overlap budget, bounds, and allowed-guest set).
- Saved data persists across sessions using the project's existing database backend, consistent with the project's established architecture.
- This is a single-user application; no multi-user permissions, sharing, or access-control concerns apply.
