CREATE TABLE `credentials` (
	`service_id` integer PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`hint` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `services` ADD `collector_id` text;--> statement-breakpoint
ALTER TABLE `services` ADD `collector_config` text;--> statement-breakpoint
ALTER TABLE `services` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `last_run_at` text;--> statement-breakpoint
ALTER TABLE `services` ADD `last_success_at` text;--> statement-breakpoint
ALTER TABLE `services` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `services` ADD `next_run_at` text;