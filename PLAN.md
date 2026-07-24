# Rules Model (Cross-Cutting Concept)/spe

Activities in this system are **global definitions** governed by **rules**, not one-off timeline entries. A definition is authored once and the scheduler instantiates it as blocks on a given day. Constraints are expressed as typed rules rather than ad-hoc flags, so the solver evaluates a block against its rule set instead of special-casing each property. Rules are scoped either **system-wide** or **per-activity**, grouped into **mutually-exclusive categories** (an activity holds at most one rule per category), and classified **Hard** (immovable, or rejected on violation) or **Soft** (relaxable in the solver cascade).

Two rules recur throughout the phases below:

- **Overlap Rule (system-wide)**: a host activity may be overlapped by a designated allowed-guest set for a bounded total of X minutes. The "Container + interruptible minutes + allowed interrupters" model introduced in Phase 4 is the canonical instance of this rule — the host declares an overlap budget and guest list, and each guest is carved out of the host's span up to the budget.
- **Temporal Placement (activity-level, exclusive)**: an activity carries either a **Preferred Window** (soft, relaxable) or a **Strict Window** (hard boundary the block must stay within, but may float inside) — never both. The flexible activities in Phases 3, 7, and 15 use Preferred Windows.
- **Recurrence (activity-level, exclusive)**: an activity is either **Recurring** (carries an allowed-days set, re-evaluated by the generator every matching day, subject to carry-over) or **One-Time** (bound to a single specific date, placed only on that date, exempt from carry-over). The "Doctor Appointment" in Phase 10 is the canonical one-time instance; the recurring activities throughout the other phases use allowed-days.

# Phase 1
A. Overview
The user opens the Next.js application in their browser. The app initializes and connects to the configured Turso database, querying for any activities scheduled for the current date. Finding none, the main timeline view renders empty. The user clicks an "Add Activity" button. A form appears requesting the Activity Name, Start Time, End Time, and Constraint Type. The user inputs "Morning Standup", selects 10:00 for the start time, 10:30 for the end time, and selects "Strict" from a dropdown. The user clicks "Save". The Next.js client executes an insert query against Turso to persist this activity record. The UI immediately routes back to the timeline view, which now renders a single, solid block labeled "Morning Standup" spanning horizontally from 10:00 to 10:30. The system provides no scheduling logic or conflict checking at this stage; it strictly displays the saved record.

B. USER STORIES

As a user, I want to open the application and view a timeline for the current day, so that I can see what is scheduled.
As a user, I want to add a new activity by inputting a name, start time, end time, and constraint type, so that I can manually record my strict appointments.
As a developer, I want the application to connect to a Turso SQLite database, so that activity data is persisted locally and across sessions.
As a user, I want my newly saved activity to immediately appear on the timeline view, so that I can visually confirm it was saved correctly.

# Phase 2
A. Overview
The user opens the application and clicks "Add Activity". The form now includes checkboxes for "Add Pre-Transition" and "Add Post-Transition". The user checks "Add Pre-Transition", revealing fields for Name, Start Time, and End Time. The user inputs "Commute", 08:00, and 10:00. The user then fills out the main activity fields: "Office Work", Strict, 10:00, and 18:00. The user checks "Add Post-Transition", inputting "Commute Home", 18:00, and 19:30. The user clicks "Save". The Next.js client writes the main activity to the activities table in Turso, then writes the two transitions to a transitions table, linking them via the main activity's ID. The UI routes back to the timeline. The timeline queries the database, retrieves the activity and its nested transitions, and renders three connected blocks sequentially: "Commute" (08:00-10:00), "Office Work" (10:00-18:00), and "Commute Home" (18:00-19:30).

B. USER STORIES

As a user, I want to attach a pre-transition and post-transition to an activity during creation, so that I can model commute times around strict work blocks.
As a developer, I want to store transitions in a separate relational table linked by an activity ID, so that the data structure remains flat and queryable.
As a user, I want the timeline to render pre and post transitions adjacent to their parent activity, so that I can visually verify the complete sequence of my day.

# Phase 3
A. Overview
The user opens the app and clicks "Add Activity". In the form, they select the "Flexible" constraint type. The form dynamically updates, replacing strict start/end times with fields for "Daily Target (hours)", "Minimum Block (hours)", and "Preferred Window (Start/End)". The user inputs "Freelance", a Daily Target of 4, a Minimum Block of 2, and a Preferred Window of 18:00 to 23:00. The user saves the activity. The UI routes to the timeline view, which now features a sidebar titled "Flexible Activities". The sidebar lists "Freelance" with a progress indicator showing "0h / 4h" scheduled for today. The user clicks a "Schedule Block" button next to Freelance. A modal prompts for a start time. The user enters 19:00. The system calculates the end time as 21:00 based on the 2-hour minimum block constraint. The user clicks "Confirm". The system validates that 19:00-21:00 falls within the 18:00-23:00 window and does not overlap existing timeline blocks. The system saves this scheduled instance to the database. The timeline updates to show the "Freelance" block from 19:00 to 21:00, and the sidebar progress indicator updates to "2h / 4h".

B. USER STORIES

As a user, I want to create a flexible activity by defining a daily target, minimum block size, and preferred time window, so that I can track non-strict goals.
As a user, I want to choose either a Preferred Window (soft, relaxable) or a Strict Window (hard boundary the block may float inside but never leave) for a flexible activity, but not both, so that I can express whether its time boundaries are negotiable.
As a user, I want to view a list of my flexible activities and their daily progress in a sidebar, so that I can see what goals still need to be scheduled.
As a user, I want to manually schedule a block of a flexible activity by providing a start time, so that I can place it into my timeline.
As a developer, I want the system to validate manually scheduled flexible blocks against their minimum size and preferred window constraints, so that invalid blocks are rejected before saving.
As a user, I want the flexible activity's progress indicator to update when a block is scheduled, so that I can track my daily target completion.

# Phase 4
A. Overview
The user opens the app and clicks "Add Activity". They create "Fulltime Work", set it as Strict from 10:00 to 18:00, and check a new "Is Container" checkbox. This checkbox is the concrete UI for the system-wide **Overlap Rule**: it makes "Fulltime Work" a *host* that allows a bounded amount of overlap by an allowed-guest set. It reveals an "Interruptible Minutes" field (the host's overlap budget), which they set to 60, and an "Allowed Interrupters" multi-select dropdown (the allowed-guest set), where they select an existing "Lunch" activity. They save the activity. On the timeline view, the user clicks the "Fulltime Work" block. A detail panel opens, displaying "Interruptible Capacity: 60 mins". The user clicks "Schedule Inside". A modal prompts for a start time. The user enters 13:00 and selects the "Lunch" activity (previously created with a 30-minute minimum block). The system validates that "Lunch" is an allowed interrupter, checks that 13:00 + 30 minutes falls within the 10:00-18:00 container bounds, and checks that 30 minutes does not exceed the 60-minute interruptible capacity. The system saves this nested block. The timeline updates, rendering the "Lunch" block visually embedded inside the "Fulltime Work" block from 13:00 to 13:30. The detail panel for "Fulltime Work" updates to show "Interruptible Capacity: 30 mins remaining".

B. USER STORIES

As a user, I want to mark a strict activity as a container with a specific number of interruptible minutes, so that I can model activities like work that contain unpaid breaks.
As a user, I want to assign specific flexible activities as allowed interrupters for a container, so that the system knows which activities are permitted to be scheduled inside it.
As a user, I want to manually schedule an allowed interrupter inside a container block, so that I can place my lunch break at a specific time.
As a developer, I want the system to validate nested interrupter blocks against the container's capacity and allowed list, so that invalid interruptions are rejected.
As a user, I want the timeline to visually render nested blocks inside their parent container, so that I can clearly see my schedule hierarchy.

# Phase 5
A. Overview
The user opens the app at 18:55. The timeline shows the next activity, "Freelance", scheduled from 19:00 to 21:00. At exactly 19:00, a "Start" button appears on the block. The user clicks "Start". The app transitions to "Focus Mode": the timeline collapses, and the screen is dominated by the activity name "Freelance" and a large countdown timer reading "02:00:00". Below the timer are three buttons: "Extend +15m", "Extend +30m", and "Finish Early". The timer begins counting down. At 19:30, the user decides to stop working. They click "Finish Early". A modal prompts: "Mark activity as complete? 1.5 hours will be logged." The user clicks "Confirm". The system records the actual end time as 19:30 and updates the block's status to "Completed" in Turso. The UI routes back to the timeline view. The "Freelance" block now displays from 19:00 to 19:30 with a checkmark. The sidebar progress indicator for "Freelance" updates from "0h / 4h" to "1.5h / 4h".

B. USER STORIES

As a user, I want to initiate an upcoming scheduled activity via a "Start" button, so that I can signal the system that I am actively working on it.
As a user, I want to enter a "Focus Mode" UI showing a large countdown timer and action buttons when an activity starts, so that I can track my remaining time without distraction.
As a user, I want to click "Finish Early" during an active activity to mark it complete before its scheduled end time, so that the system logs my actual time spent.
As a user, I want to click "Extend +15m" or "+30m" during an active activity to increase its scheduled duration, so that I can continue working if I need more time.
As a developer, I want to update the status and actual end time of an activity in the database when it is finished early or extended, so that the true time spent is persisted.

# Phase 6
A. Overview
The user opens the app on Wednesday morning. The client detects it is a new day and that carry-over has not yet been processed for today. It queries Tuesday's completed activity logs from Turso. For "Freelance" (base target 4h, daily maximum 5h, carry-over enabled), it calculates that only 2h were completed on Tuesday, producing a 2h deficit. It computes Wednesday's adjusted target as 4 + 2 = 6h, caps it at the daily maximum of 5h, and carries the remaining 1h deficit forward to Thursday. For "Sleep" (base target 8h, carry-over disabled), it calculates 6h completed but discards the 2h deficit; Wednesday's target resets to 8h. For "Learning" (base target 2h, daily maximum 3h, carry-over enabled), it calculates 3h completed on Tuesday, producing a 1h surplus; Wednesday's adjusted target becomes 2 - 1 = 1h. The system writes a daily_carry_over record to Turso for each activity with the date, deficit/surplus, and adjusted target. The timeline loads empty for the new day. The sidebar now displays "Freelance: 0h / 5h" with a small badge reading "+1h from yesterday", "Sleep: 0h / 8h" with no badge, and "Learning: 0h / 1h" with a badge reading "-1h from yesterday".

B. USER STORIES

As a user, I want the app to automatically process yesterday's completed time against daily targets when I open the app on a new day, so that my deficits and surpluses roll forward without manual intervention.
As a user, I want carry-over to be configurable per activity, so that activities like Sleep reset daily while activities like Freelance accumulate deficits.
As a user, I want a daily maximum cap on adjusted targets, so that carry-over deficits cannot snowball into impossible daily loads.
As a user, I want to see my adjusted daily target and a carry-over badge in the sidebar, so that I understand why today's target differs from the base target.
As a developer, I want to persist daily carry-over records in Turso, so that the system can audit deficit/surplus calculations and avoid reprocessing the same day.

# Phase 7
A. Overview
The user opens the app on Wednesday at 08:00. The client queries Turso for scheduled blocks with today's date. Finding none, it triggers the "Generate Daily Plan" function. The function queries all activities where the allowed_days array includes Wednesday. It retrieves "Morning Routine" (transition, strict, 09:30-10:00), "Office Work" (strict container, 10:00-18:00, pre-transition Morning Routine, post-transition Commute Home 18:00-19:30), "Freelance" (flexible, adjusted target 5h, min block 2h, preferred 19:30-23:00), and "Learning" (flexible, adjusted target 1h, min block 1h, preferred 07:00-09:30). The scheduler places strict blocks and transitions first: Morning Routine at 09:30-10:00, Office Work at 10:00-18:00, Commute Home at 18:00-19:30. It identifies two free gaps: 07:00-09:30 and 19:30-23:00. For the morning gap, it checks which flexible activities prefer a window overlapping 07:00-09:30. Learning matches. It schedules 1h of Learning from 08:30-09:30. For the evening gap, Freelance matches. It schedules a 2h block from 19:30-21:30. Freelance still needs 3h but no remaining gap today fits a 2h minimum block. The system saves all scheduled blocks to Turso with today's date. The timeline renders five blocks sequentially. The sidebar shows "Freelance: 0h / 5h" with a warning badge "3h unschedulable" and "Learning: 0h / 1h".

B. USER STORIES

As a user, I want each activity to have configurable allowed days of the week, so that the scheduler only places activities on appropriate days.
As a developer, I want the app to detect when no plan exists for today and automatically trigger the daily plan generator on load, so that the user wakes up to a pre-built schedule.
As a developer, I want the scheduler to place strict activities and their transitions first, so that hard constraints establish the skeleton of the day.
As a developer, I want the scheduler to identify free gaps between strict blocks and fill them with flexible activities whose preferred windows overlap, so that activities land in their preferred times.
As a developer, I want the scheduler to respect minimum block sizes when placing flexible activities, so that no block is too short to be productive.
As a user, I want to see a warning badge when a flexible activity's target cannot be fully scheduled, so that I know my daily goal is at risk.

# Phase 8
A. Overview
The user's schedule shows Learning (08:30-09:30), Morning Routine (09:30-10:00), Office Work (10:00-18:00), Commute Home (18:00-19:30), Freelance (19:30-21:30), and Sleep (23:00-07:00). At 09:00 the user clicks "Finish Early" on Learning. The system records 30 minutes completed and calculates a 30-minute freed gap from 09:00 to 09:30. The solver wakes up and scans forward from 09:00. The next block is Morning Routine (strict, 09:30-10:00) which is immovable. The solver checks all flexible activities with outstanding deficits against the 30-minute gap. Freelance has a 3h deficit but its minimum block is 2h so it cannot fit. No flexible activity can fit a 30-minute block. The solver marks the gap as "Free Time" on the timeline. The UI returns to the timeline showing a gray "Free Time" block from 09:00 to 09:30. Later at 20:00 during Freelance (Focus Mode, timer showing 01:30:00 remaining), the user clicks "Extend +30m". The solver calculates the new end time as 22:00. It scans forward and finds the next block is Sleep (preferred window 23:00). Since 22:00 does not overlap or push into Sleep's 23:00 start, the extension is allowed. The timer updates to 02:00:00 remaining. The timeline updates to show Freelance from 19:30 to 22:00. If the user instead tried to extend to 23:30, the solver would detect an overlap with Sleep's preferred start of 23:00. Since Sleep is flexible, the solver would attempt to nudge Sleep forward by 30 minutes to 23:30-07:30, checking that 07:30 does not collide with the next day's Morning Routine at 09:30. Finding no collision, it would allow the extension and update Sleep's start time.

B. USER STORIES

As a user, I want the solver to automatically recalculate my schedule forward when I finish an activity early, so that freed time is either filled or marked as free time.
As a developer, I want the solver to check flexible activities with outstanding deficits against freed gaps, so that carry-over deficits can be recovered when time becomes available.
As a user, I want the solver to respect minimum block sizes when attempting to fill freed gaps, so that activities are not scheduled in unusably small fragments.
As a user, I want freed time that cannot be filled to be marked as "Free Time" on the timeline, so that I can visually distinguish available time from scheduled time.
As a user, I want the solver to validate extensions against subsequent blocks, so that extending one activity does not silently overwrite another.
As a developer, I want the solver to nudge subsequent flexible blocks forward when an extension creates an overlap, so that the cascade delay propagates through the timeline without breaking hard constraints.

# Phase 9
A. Overview
The user is in Focus Mode for "Lunch", an allowed interrupter scheduled inside the "Office Work" container from 13:00 to 13:30. The countdown timer shows 18 minutes remaining. At 13:15 the user clicks "Finish Early". The system calculates 15 minutes of spare time. Because "Lunch" is an interrupter nested inside a container, the system does not mark the gap as "Free Time" as it would for a normal activity. Instead it banks the 15 minutes into a "Spare Time Bank" scoped to the parent "Office Work" container instance. A prominent UI prompt appears at the top of the screen: "You have 15 spare minutes. Start a quick activity?" with three buttons: ["Start Learning Podcast", "Resume Work", "Just Rest"]. The options are populated by checking which allowed interrupters for "Office Work" have a minimum block size of 15 minutes or less. "Learning" qualifies with a 15-minute minimum block; "Freelance" does not with a 2-hour minimum block. The user clicks "Start Learning Podcast". The system schedules a 15-minute "Learning" block from 13:15 to 13:30 inside the container, saves it to Turso, and immediately enters Focus Mode with a countdown timer of 15 minutes. The "Office Work" container's interruptible capacity remaining updates from 30 minutes to 15 minutes. When the 15-minute Learning block finishes at 13:30, the system automatically returns the user to the "Office Work" Focus Mode timer, which now shows 04:30:00 remaining until 18:00. If the user had instead clicked "Resume Work", the 15 banked minutes would have been discarded and the system would have immediately returned to the Office Work timer. If the user had clicked "Just Rest", the system would have returned to the Office Work timer but the 15 minutes would still be visible as a nested "Rest" block on the timeline.

B. USER STORIES

As a user, I want finishing an interrupter early inside a container to bank the spare time, so that the system can offer me productive micro-tasks instead of wasting the gap.
As a developer, I want the spare time bank to be scoped to the parent container instance, so that banked minutes expire when the container ends and cannot leak into other parts of the day.
As a user, I want a prominent UI prompt to appear when spare time is banked, so that I can quickly decide whether to use it or discard it.
As a developer, I want the prompt to only offer allowed interrupters whose minimum block size fits within the banked spare time, so that I am not presented with impossible options.
As a user, I want selecting a quick activity from the prompt to immediately enter Focus Mode for that activity, so that I can begin without additional clicks.
As a user, I want the system to automatically return me to the parent container's Focus Mode timer when the spare-time activity ends, so that I seamlessly resume my main work.
As a user, I want the option to discard banked spare time by clicking "Resume Work" or "Just Rest", so that I am not forced into productivity when I need a break.

# Phase 10
A. Overview
The user opens the app and clicks "Add Activity". They create a strict activity titled "Doctor Appointment" from 14:00 to 15:00, marking it **One-Time** and bound to today's date (the canonical instance of the Recurrence rule's One-Time option: it will appear only today, is invisible to the generator on every other day, and is exempt from carry-over). The existing timeline already contains the strict "Office Work" container from 10:00 to 18:00. When the user clicks "Save", the Next.js client runs the Hard Constraint validation function. The function queries Turso for any existing strict or pinned blocks overlapping 14:00 to 15:00. It finds "Office Work". The system rejects the save, prevents the database write, and displays a red validation error on the form: "Cannot schedule Doctor Appointment: overlaps with immovable Office Work." The user edits the form, changing the Doctor Appointment to 18:30 to 19:30, and clicks "Save". The validation function finds no overlaps, so the system persists the record. The timeline renders the new block. Later, the user views an existing scheduled flexible block, "Freelance", from 19:30 to 21:30. They click the block to open its detail panel. The panel contains a toggle switch labeled "Pin Block". The user toggles it to "On". The system updates the is_pinned boolean for that specific scheduled instance in Turso to true. The timeline visually updates the "Freelance" block, adding a pin icon to its corner. If the user subsequently attempts to add a strict activity overlapping 20:00 to 20:30, the validation function now rejects it, citing an overlap with the pinned "Freelance" block.

B. USER STORIES

As a developer, I want the system to validate new strict activities against existing strict and pinned blocks before saving, so that impossible overlaps are prevented at the input level.
As a user, I want the app to reject saving an activity that overlaps an immovable block and display a clear error message, so that I am forced to resolve the conflict manually.
As a user, I want to toggle a "Pin Block" setting on a scheduled flexible activity instance, so that I can protect specific time slots from being displaced or interrupted.
As a developer, I want pinned blocks to be treated as Hard Constraints by the solver and validation logic, so that they are excluded from the shrink, nudge, relax, and displace cascade steps.

# Phase 11
A. Overview
The user opens the app to their daily timeline, which contains a "Freelance" block scheduled from 10:00 to 12:00 (minimum block 2h, preferred window 10:00-14:00). The user suddenly needs to handle an urgent strict task. They click "Add Activity", input "Emergency Task", select "Strict", and set the time from 11:00 to 12:00. The user clicks "Save". The client-side solver intercepts the save event to process the overlap. It executes the Full Hybrid Cascade:

Shrink: The solver attempts to shrink the "Freelance" block. Since its minimum block size is 2h, it cannot be reduced to 1h (10:00-11:00).
Nudge: The solver attempts to nudge "Freelance" to a later time today. It scans for a 2-hour gap within its preferred window (10:00-14:00). The timeline is occupied from 12:00 onward.
Relax: The solver drops the preferred window constraint and scans the entire remaining day for a 2-hour gap. It finds a 2-hour open gap from 18:00 to 20:00.
Displace & Bank: Instead of deleting "Freelance", the solver displaces it. It updates the "Freelance" scheduled instance in Turso to 18:00-20:00, and persists the new "Emergency Task" from 11:00 to 12:00.
The UI updates: the timeline shows "Freelance" moved to the evening, and "Emergency Task" occupies the 11:00-12:00 slot.
Later, the user adds another strict activity, "Urgent Meeting", from 18:30 to 19:30, overlapping the newly moved "Freelance" block. The solver runs the cascade again. Shrink fails (needs 2h). Nudge fails (no other 2h gaps today). Relax fails (no gaps at all today). The solver reaches the Displace & Bank step: it deletes the "Freelance" block from today, adds 2 hours to "Freelance's" daily deficit, and saves the "Urgent Meeting". The timeline updates to show the meeting, and the sidebar updates the "Freelance" progress to show a "+2h" deficit warning.

B. USER STORIES

As a developer, I want the solver to intercept overlapping activity saves and execute the Full Hybrid Cascade, so that conflicts are resolved dynamically rather than just rejected.
As a developer, I want the solver to attempt shrinking the lower-priority block down to its minimum block size, so that an activity can be partially preserved if possible.
As a developer, I want the solver to attempt nudging the lower-priority block to another gap within its preferred window, so that the activity can be moved without violating soft constraints.
As a developer, I want the solver to relax preferred window constraints and scan the entire day for a valid gap, so that the activity can be displaced rather than immediately deleted.
As a developer, I want the solver to delete the lower-priority block and bank the missed time as a daily deficit if no shrink, nudge, or relax option is available, so that the time is accounted for in future carry-over calculations.
As a user, I want the timeline and sidebar progress indicators to immediately reflect displaced or deleted blocks, so that I have an accurate view of my remaining targets.

# Phase 12
A. Overview
The user opens the app on Monday and navigates to the date picker, selecting the upcoming Tuesday. The timeline for Tuesday is currently empty pending the 2:00 AM generation, but the user wants to proactively manage their schedule. They click a "Mark Day Off" button. A modal appears asking them to select which activities are affected. The user selects "Fulltime Work" and clicks "Confirm". The system saves a vacation_day record to Turso for Tuesday linked to the "Fulltime Work" activity. The user then clicks a "Generate Plan" button to test the schedule for Tuesday. The scheduler runs, queries the activities, and sees the vacation_day flag for "Fulltime Work". It skips placing the "Fulltime Work" block, the "Morning Routine" transition, and the "Commute Home" transition. Because the strict 10:00-18:00 block is absent, the solver identifies a massive free gap from 07:00 to 23:00. It fills this gap with flexible activities based on their preferred windows and adjusted daily targets (which carry over from Monday). "Learning" is scheduled from 09:00 to 11:00. "Freelance" is scheduled from 11:00 to 16:00. The sidebar for Tuesday displays "Fulltime Work: 0h / 0h" with a "Vacation Day" badge. On Wednesday morning at 2:00 AM, the carry-over logic processes Tuesday's logs. Since Tuesday's target for "Fulltime Work" was prorated to 0 hours, completing 0 hours generates zero deficit. Wednesday's "Fulltime Work" target resets normally to 8 hours, unaffected by the day off.

B. USER STORIES

As a user, I want to mark a specific future date as a vacation day for a specific strict activity, so that the system knows not to schedule it.
As a developer, I want the daily plan generator to query vacation_day records and exclude the associated strict activities and their transitions, so that the timeline remains accurate.
As a developer, I want the daily carry-over logic to prorate the daily target to 0 for activities on a vacation day, so that taking time off does not create an artificial deficit.
As a user, I want to see a "Vacation Day" badge in the sidebar next to the affected activity, so that I can visually confirm the day off is recognized by the system.

# Phase 13
A. Overview
The user has a "Sleep" activity scheduled from 23:00 on Tuesday to 07:00 on Wednesday. At midnight, the client detects the date change to Wednesday. It queries Turso for any in-progress activities whose start date is Tuesday but whose end time falls into Wednesday. It finds the "Sleep" block. The system freezes the remainder of the block (00:00 to 07:00) as a fixed, unmovable anchor for Wednesday's timeline. It marks the block with a lock icon and a "Spanning from yesterday" label. When the 2:00 AM daily plan generator runs for Wednesday, it queries the timeline and sees the frozen "Sleep" anchor from 00:00 to 07:00. The scheduler skips that window entirely and places all strict and flexible activities only in the 07:00 onward window. At 06:30 on Wednesday, the user wakes up early and opens the app. They are in Focus Mode for "Sleep" with 30 minutes remaining on the timer. The user clicks "Finish Early". The system records the actual end time as 06:30 and unfreezes the remaining 30 minutes. The solver wakes up and runs a forward-only recalculation starting from 06:30. It scans all flexible activities with outstanding deficits. "Learning" has a 1h deficit from Tuesday and its minimum block is 1h, so it cannot fit in 30 minutes. "Freelance" has a deficit but its minimum block is 2h. No activity can fit. The solver marks 06:30 to 07:00 as "Free Time" on the timeline. The rest of Wednesday's schedule remains unchanged because 07:00 was already the boundary of the frozen sleep block and the next activity ("Morning Routine") starts at 09:30.

B. USER STORIES

As a developer, I want the system to detect activities that span midnight and freeze their remainder as a fixed anchor in the new day's timeline, so that the overnight plan generator cannot displace or overlap them.
As a developer, I want the daily plan generator to skip frozen anchor blocks when placing new activities, so that the overnight schedule respects in-progress spanning activities.
As a user, I want to see a lock icon and "Spanning from yesterday" label on overnight activities, so that I can visually distinguish them from normally scheduled blocks.
As a user, I want to finish a spanning activity early from Focus Mode, so that the system records my actual wake time and frees the remaining gap.
As a developer, I want finishing a spanning activity early to trigger a forward-only recalculation, so that the newly freed gap is evaluated for flexible activity placement just like any other freed time.

# Phase 14
A. Overview
The user has a "Freelance" block scheduled on their timeline from 19:00 to 21:00. The user closes the app and goes about their evening. At 18:55, the Next.js client's background service worker detects the impending start time and sends an FCM push notification to the user's device: "Freelance starts in 5 mins." At exactly 19:00, the client wakes up and automatically transitions the "Freelance" block's status to "In Progress". It begins counting down the 2-hour timer in the background. The system sets a 15-minute inactivity check. At 19:15, the system notes that the user has not explicitly opened the app or interacted with the Focus Mode UI. It sends a second FCM notification: "Are you working on Freelance?" with quick-action buttons: ["Yes, started", "Delayed 15m", "Skip"]. The user pulls down the notification tray on their phone and taps "Delayed 15m". The app receives the intent in the background. It stops the background timer, recalculates the block's start time to 19:15 and end time to 21:15, and triggers the forward-only solver to ensure no subsequent blocks are illegally overlapped. The schedule updates silently in the database. If the user had tapped "Yes, started", the background timer would simply continue running without interruption.

B. USER STORIES

As a user, I want to receive an FCM push notification 5 minutes before an activity starts, so that I can mentally prepare and wrap up what I am doing.
As a developer, I want the app to automatically transition an activity to "In Progress" and start its countdown timer at the scheduled start time, so that the schedule advances even if the user forgets to manually press "Start".
As a developer, I want the system to send a reality-check FCM notification with quick actions if the user has not interacted with the app 15 minutes after an activity auto-starts, so that the solver's data does not silently drift from reality.
As a user, I want to tap "Delayed 15m" directly from the notification tray, so that I can push back the activity start time without unlocking my phone and opening the full app.
As a developer, I want a notification quick-action to update the activity's start time in the database and trigger the forward-only solver, so that downstream blocks are immediately recalculated.

# Phase 15
A. Overview
The user wakes up at 07:30 on Thursday and opens the app. The client checks the current date against the last generated date in Turso. Seeing it is Thursday, past 02:00, and no daily_plan record exists for Thursday, it triggers the generation sequence. First, it processes Wednesday's carry-overs. "Freelance" has an adjusted target of 5h (4h base + 1h deficit). "Learning" has an adjusted target of 4h (2h base + 2h deficit). It places strict blocks and transitions. It finds a 3-hour gap from 19:00 to 22:00. Both "Freelance" and "Learning" have preferred windows overlapping this gap. The solver checks the Weighted Deficit Priority. "Learning" has a 100% deficit relative to its base target (2h deficit / 2h base), while "Freelance" has a 25% deficit (1h deficit / 4h base). The solver prioritizes "Learning". It schedules a 2h Learning block (19:00-21:00). It then evaluates the remaining 1h gap (21:00-22:00). "Learning" still needs 2h, but its minimum block is 1h, so it fits. "Freelance" also needs 5h, min block 2h, so it cannot fit the 1h gap. The solver schedules another 1h "Learning" block (21:00-22:00). "Freelance" receives an "unschedulable" warning badge in the sidebar. The timeline renders the new plan. The user sees the prioritized schedule.

B. USER STORIES

As a developer, I want the app to detect on open that the current date is past the 02:00 generation threshold and no plan exists, so that it triggers the daily plan generation automatically without needing a background server process.
As a developer, I want the plan generator to evaluate contested gaps using Weighted Deficit Priority, so that the activity furthest behind relative to its base target gets the slot.
As a user, I want the system to prioritize filling gaps with the most behind activity, so that my rolling deficits are recovered efficiently.
As a developer, I want the generator to respect minimum block sizes when assigning secondary blocks in a remaining gap, so that activities aren't fragmented.
As a user, I want to see which activities were prioritized and which were left unschedulable, so that I understand the system's scheduling decisions.