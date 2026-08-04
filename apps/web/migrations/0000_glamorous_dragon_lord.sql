CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`allowed_days` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `overlap_allowed_guest` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`guest_activity_id` text NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `rule`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guest_activity_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rule` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`rule_type` text NOT NULL,
	`config` text NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_rule_type_idx` ON `rule` (`activity_id`,`rule_type`);--> statement-breakpoint
CREATE TABLE `timeline_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`timeline_id` text NOT NULL,
	`source_activity_id` text,
	`title` text NOT NULL,
	`start_time` integer NOT NULL,
	`end_time` integer NOT NULL,
	`actual_start_time` integer,
	`actual_end_time` integer,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`is_pinned` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`timeline_id`) REFERENCES `timeline`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_activity_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `timeline_overlap_guest` (
	`id` text PRIMARY KEY NOT NULL,
	`timeline_rule_id` text NOT NULL,
	`timeline_guest_activity_id` text NOT NULL,
	FOREIGN KEY (`timeline_rule_id`) REFERENCES `timeline_rule`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`timeline_guest_activity_id`) REFERENCES `timeline_activity`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `timeline_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`timeline_activity_id` text NOT NULL,
	`rule_type` text NOT NULL,
	`config` text NOT NULL,
	FOREIGN KEY (`timeline_activity_id`) REFERENCES `timeline_activity`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `timeline` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `date_idx` ON `timeline` (`date`);--> statement-breakpoint
CREATE TABLE `tracking_ledger` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`rolling_target_minutes` integer DEFAULT 0 NOT NULL,
	`rolling_achieved_minutes` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE cascade
);
