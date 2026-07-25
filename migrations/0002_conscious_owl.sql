CREATE TABLE `vacation_day` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`date` text NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activity`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_vacation_date_idx` ON `vacation_day` (`activity_id`,`date`);--> statement-breakpoint
ALTER TABLE `timeline_activity` ADD `warning_message` text;--> statement-breakpoint
ALTER TABLE `tracking_ledger` ADD `last_evaluated_date` text;