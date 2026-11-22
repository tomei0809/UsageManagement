CREATE TABLE `app_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`type` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collector_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer,
	`collector_id` text NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`error_message` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collector_runs_service_time` ON `collector_runs` (`service_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`unit` text NOT NULL,
	`kind` text DEFAULT 'cumulative' NOT NULL,
	`limit_value` real,
	`reset_type` text DEFAULT 'monthly' NOT NULL,
	`reset_anchor` integer,
	`reset_timezone` text DEFAULT 'UTC' NOT NULL,
	`caution_pct` real DEFAULT 80 NOT NULL,
	`warning_pct` real DEFAULT 95 NOT NULL,
	`stale_after_hours` integer DEFAULT 48 NOT NULL,
	`collector_id` text,
	`polling_enabled` integer DEFAULT true NOT NULL,
	`poll_interval_hours` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_service_key` ON `metrics` (`service_id`,`key`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`url` text,
	`notes` text,
	`polling_enabled` integer DEFAULT true NOT NULL,
	`paused_until` text,
	`pause_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`metric_id` integer NOT NULL,
	`value` real NOT NULL,
	`collected_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`period_start` text,
	`period_end` text,
	`source` text NOT NULL,
	`collector_run_id` integer,
	`note` text,
	FOREIGN KEY (`metric_id`) REFERENCES `metrics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_metric_time` ON `snapshots` (`metric_id`,`collected_at`);