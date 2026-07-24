# Feature Specification: Manual Activity Scheduling & Timeline

**Feature Branch**: `[001-manual-activity-scheduling]`

**Created**: 2026-07-25

**Status**: Draft

**Input**: User description: "A. Overview
The user opens the Next.js application in their browser. The app initializes and connects to the configured Turso database, querying for any activities scheduled for the current date. Finding none, the main timeline view renders empty. The user clicks an \"Add Activity\" button. A form appears requesting the Activity Name, Start Time, End Time, and Constraint Type. The user inputs \"Morning Standup\", selects 10:00 for the start time, 10:30 for the end time, and selects \"Strict\" from a dropdown. The user clicks \"Save\". [...] The system provides no scheduling logic or conflict checking at this stage; it strictly displays the saved record.

[...four progressively richer overviews and user-story sets covering: (1) basic strict activity creation and timeline display, (2) pre/post transitions attached to an activity, (3) flexible activities with daily targets, minimum blocks, preferred windows, sidebar progress, and manual block scheduling, (4) container activities with interruptible minutes, allowed interrupters, and nested block scheduling — see conversation history for full text.]"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View the daily timeline and record a strict activity (Priority: P1)

A user opens the application and sees a timeline for the current day. If nothing is scheduled yet, the timeline is empty. The user adds a new activity by providing a name, a start time, an end time, and choosing "Strict" as its constraint type. After saving, the activity appears immediately on the timeline as a single block spanning its start and end time.

**Why this priority**: This is the foundational capability — without a visible timeline and the ability to record a fixed appointment, no other scheduling feature has anything to attach to or display against. It is the smallest possible slice that delivers real value (a persisted, visible daily record).

**Independent Test**: Can be fully tested by opening the app with no existing data (empty timeline), creating one Strict activity with a name/start/end, saving it, and confirming it renders as a single correctly-positioned block on the timeline after the save.

**Acceptance Scenarios**:

1. **Given** no activities exist for the current date, **When** the user opens the application, **Then** the timeline view renders with no blocks.
2. **Given** the timeline view is open, **When** the user clicks "Add Activity", fills in Name = "Morning Standup", Start = 10:00, End = 10:30, Constraint Type = "Strict", and clicks "Save", **Then** the activity is persisted and the user is returned to the timeline view.
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

The user creates an activity with constraint type "Flexible", specifying a daily target duration, a minimum block duration, and a preferred time window instead of fixed start/end times. The activity appears in a "Flexible Activities" sidebar showing progress toward its daily target. The user then manually schedules a block for it by choosing a start time; the system computes the end time from the minimum block duration, validates the result against the preferred window and existing blocks, and — if valid — saves it and updates the timeline and the sidebar progress.

**Why this priority**: Flexible activities are a distinct scheduling model from strict, fixed-time activities and depend on the timeline already existing (Story 1). They deliver goal-tracking value independently of transitions or containers.

**Independent Test**: Can be fully tested by creating one Flexible activity, confirming it appears in the sidebar at "0h / target", scheduling one manual block for it, and confirming both the timeline and the sidebar progress update to reflect the new block.

**Acceptance Scenarios**:

1. **Given** the Add Activity form is open, **When** the user selects Constraint Type = "Flexible", **Then** the Start/End Time fields are replaced with Daily Target (hours), Minimum Block (hours), and Preferred Window (start/end) fields.
2. **Given** the user enters "Freelance", Daily Target = 4h, Minimum Block = 2h, Preferred Window = 18:00–23:00, and saves, **When** the timeline view renders, **Then** the "Flexible Activities" sidebar lists "Freelance" with progress "0h / 4h".
3. **Given** the "Freelance" activity exists, **When** the user clicks "Schedule Block", enters a start time of 19:00, and confirms, **Then** the system computes an end time of 21:00 (using the 2-hour minimum block), validates it falls within 18:00–23:00 and does not overlap existing blocks, and saves it.
4. **Given** a block was successfully scheduled, **When** the timeline and sidebar re-render, **Then** the timeline shows the "Freelance" block from 19:00–21:00 and the sidebar shows "2h / 4h".
5. **Given** a proposed block's computed time range falls outside the preferred window or overlaps an existing block, **When** the user confirms, **Then** the system rejects the block and does not persist it.

---

### User Story 4 - Model container activities with interruptible capacity (Priority: P4)

The user creates a Strict activity and marks it as a container, specifying how many of its minutes are interruptible and which existing Flexible activities are allowed to interrupt it. From the container's detail panel, the user schedules an allowed interrupter inside the container at a specific start time. The system validates that the interrupter is allowed, fits within the container's bounds, and does not exceed remaining interruptible capacity, then saves it and renders it nested inside the container's block, reducing the displayed remaining capacity.

**Why this priority**: This is the most advanced scheduling model in this feature set — it composes strict activities (Story 1) and flexible activities (Story 3) into a nested relationship, and is the least essential for a minimally usable daily timeline.

**Independent Test**: Can be fully tested by creating a container activity with an allowed interrupter, scheduling that interrupter inside it, and confirming the nested block renders inside the container while the container's remaining capacity updates correctly.

**Acceptance Scenarios**:

1. **Given** the Add Activity form is open and Constraint Type = "Strict", **When** the user checks "Is Container", **Then** an "Interruptible Minutes" field and an "Allowed Interrupters" multi-select of existing Flexible activities appear.
2. **Given** the user creates "Fulltime Work" (Strict, 10:00–18:00, Is Container, Interruptible Minutes = 60, Allowed Interrupters = ["Lunch"]) and saves, **When** the user opens its detail panel, **Then** it displays "Interruptible Capacity: 60 mins".
3. **Given** the container's detail panel is open, **When** the user clicks "Schedule Inside", enters start time 13:00, and selects "Lunch" (minimum block 30 minutes), **Then** the system validates that "Lunch" is an allowed interrupter, that 13:00–13:30 falls within 10:00–18:00, and that 30 minutes does not exceed the 60-minute remaining capacity, then saves the nested block.
4. **Given** a nested block was successfully saved, **When** the timeline and detail panel re-render, **Then** the timeline shows "Lunch" embedded inside "Fulltime Work" from 13:00–13:30, and the detail panel shows "Interruptible Capacity: 30 mins remaining".
5. **Given** the user selects an activity that is not in the container's allowed interrupters list, or a time/duration that would exceed the container's bounds or remaining capacity, **When** the user attempts to save, **Then** the system rejects the nested block and does not persist it.

---

### Edge Cases

- What happens when the user provides an End Time at or before the Start Time for a strict activity or a transition? The system MUST reject the save.
- What happens when a pre- or post-transition's time range does not exactly abut the main activity's start/end (e.g., leaves a gap)? The system displays it positioned at its own recorded times; no adjacency enforcement is performed.
- What happens when a Flexible activity has no manually scheduled blocks yet? It appears only in the sidebar at "0h / target" with no corresponding timeline block.
- What happens when manually scheduled blocks push a Flexible activity's total scheduled time beyond its daily target? The system allows it and reflects the over-target progress in the sidebar (no cap is enforced by this feature).
- What happens when the "Allowed Interrupters" list is empty at the time a container is created? The container is saved with zero allowed interrupters; the user cannot yet schedule anything inside it.
- What happens when a user attempts to designate a container activity as its own allowed interrupter? The container's own activity MUST be excluded from its Allowed Interrupters selection.
- What happens when the selected interrupter's minimum block duration would extend past the container's own end time? The system MUST reject the nested block.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST render a timeline view showing all activities and blocks scheduled for the current calendar date.
- **FR-002**: The system MUST display an empty timeline when no activities are scheduled for the current date.
- **FR-003**: Users MUST be able to open an "Add Activity" form from the timeline view.
- **FR-004**: The Add Activity form MUST require an Activity Name and a Constraint Type selection of either "Strict" or "Flexible".
- **FR-005**: When Constraint Type is "Strict", the form MUST require a Start Time and an End Time, and MUST reject a save where the End Time is not after the Start Time.
- **FR-006**: The system MUST persist a saved activity so it remains available across app sessions and page reloads.
- **FR-007**: Upon saving an activity, the system MUST return the user to the timeline view, which MUST immediately reflect the newly saved activity without requiring a manual page refresh.
- **FR-008**: The timeline MUST render each Strict activity as a single block positioned and sized according to its Start Time and End Time.
- **FR-009**: The Add Activity form MUST offer optional "Add Pre-Transition" and "Add Post-Transition" toggles, each revealing Name, Start Time, and End Time fields when enabled.
- **FR-010**: The system MUST persist each transition as a distinct record linked to the parent activity it was created with.
- **FR-011**: The timeline MUST render an activity's pre-transition (if present), the activity itself, and its post-transition (if present) as sequential blocks in chronological order.
- **FR-012**: When Constraint Type is "Flexible", the form MUST replace the Start/End Time fields with required Daily Target (hours), Minimum Block (hours), and Preferred Window (start and end time) fields.
- **FR-013**: The system MUST display a "Flexible Activities" sidebar listing each Flexible activity with its progress for the current date, expressed as hours scheduled versus its Daily Target.
- **FR-014**: Users MUST be able to manually schedule a block for a Flexible activity by supplying a start time, from which the system computes the end time using the activity's Minimum Block duration.
- **FR-015**: The system MUST reject and not persist a manually scheduled Flexible block whose computed time range falls outside the activity's Preferred Window or overlaps an existing block on the timeline.
- **FR-016**: Upon successfully saving a manually scheduled Flexible block, the system MUST update both the timeline and the Flexible Activities sidebar progress indicator.
- **FR-017**: The Add Activity form MUST offer an "Is Container" option for Strict activities, which, when enabled, reveals an "Interruptible Minutes" field and an "Allowed Interrupters" multi-select of existing Flexible activities (excluding the activity being created).
- **FR-018**: The system MUST persist a container activity's interruptible-minutes capacity and its list of allowed interrupter activities.
- **FR-019**: Users MUST be able to open a detail panel for a container activity showing its current remaining Interruptible Capacity.
- **FR-020**: From a container's detail panel, users MUST be able to schedule an allowed interrupter inside the container by supplying a start time and selecting one of its allowed interrupter activities.
- **FR-021**: The system MUST reject and not persist a nested interrupter block if: the selected activity is not in the container's allowed interrupters list; the block's time range falls outside the container's own time bounds; or the block's duration exceeds the container's remaining Interruptible Capacity.
- **FR-022**: Upon successfully saving a nested interrupter block, the system MUST reduce the container's remaining Interruptible Capacity by the block's duration and reflect the updated value in the detail panel.
- **FR-023**: The timeline MUST render nested interrupter blocks visually embedded within their parent container's block, distinguishable from the container's own time.

### Key Entities

- **Activity**: A schedulable item with a name and a constraint type (Strict or Flexible). Strict activities carry a start time and end time, and may optionally be marked as a container with an interruptible-minutes capacity and a list of allowed interrupter activities. Flexible activities carry a daily target duration, a minimum block duration, and a preferred time window instead of fixed times.
- **Transition**: A named time block linked to exactly one parent Activity, marked as occurring before (pre) or after (post) it, with its own start and end time.
- **Scheduled Block**: A specific, manually placed occurrence of a Flexible activity on a given date's timeline, with a start time and end time, contributing to that activity's daily progress.
- **Container Settings**: The interruptible-minutes capacity and allowed-interrupter list associated with a Strict activity marked as a container.
- **Nested Block**: A specific occurrence of an allowed interrupter activity scheduled inside a particular container instance, with a start time and end time, consuming part of the container's interruptible capacity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can create a Strict activity and see it correctly positioned on the timeline immediately after saving, with no manual refresh needed.
- **SC-002**: 100% of activities saved with a pre- and/or post-transition display all associated blocks adjacent to one another and in correct chronological order on the timeline.
- **SC-003**: Users can create a Flexible activity and immediately see it listed in the sidebar with accurate "0h / target" progress before any block is scheduled.
- **SC-004**: 100% of manually scheduled Flexible blocks that fall outside the preferred window or overlap an existing block are rejected before being saved.
- **SC-005**: Sidebar progress for a Flexible activity reflects newly scheduled hours in the same interaction as the save, with no discrepancy between displayed and actual scheduled time.
- **SC-006**: 100% of nested interrupter block attempts that violate the allowed-interrupters list, container time bounds, or remaining capacity are rejected before being saved.
- **SC-007**: Users can visually distinguish top-level activities, transitions, and nested interrupter blocks on the timeline without additional explanation.
- **SC-008**: A user unfamiliar with the feature can complete the full flow of creating a container activity, assigning an allowed interrupter, and scheduling that interrupter inside it in under 2 minutes.

## Assumptions

- Only the current calendar date's timeline is in scope for this feature; navigating to or viewing past/future dates is out of scope.
- Only creation and viewing are covered; editing or deleting existing activities, transitions, scheduled blocks, or nested blocks is out of scope for this feature.
- The "Is Container" option is available only for Strict-type activities; Flexible activities cannot themselves be containers.
- Allowed Interrupters are selected only from existing Flexible activities, whose configured Minimum Block value determines the duration of a nested block.
- General overlap/conflict checking across arbitrary activities and transitions is out of scope for this feature; only the specific validations described (Flexible block window/overlap; container capacity, bounds, and allowed-list) are enforced.
- Saved data persists across sessions using the project's existing database backend, consistent with the project's established architecture.
- This is a single-user application; no multi-user permissions, sharing, or access-control concerns apply.
