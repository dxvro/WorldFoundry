CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `update_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_version` text NOT NULL,
	`to_version` text NOT NULL,
	`result` text NOT NULL,
	`message` text,
	`stopped_servers` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `update_history_finished_idx` ON `update_history` (`finished_at`);