CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`period_key` text NOT NULL,
	`level` text NOT NULL,
	`notified_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_unique` ON `alerts` (`kind`,`subject`,`period_key`);--> statement-breakpoint
ALTER TABLE `services` ADD `free_tier_ends_at` text;--> statement-breakpoint
ALTER TABLE `services` ADD `pause_on_free_tier_end` integer DEFAULT false NOT NULL;