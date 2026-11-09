CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`file_name` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`raw_bytes` integer DEFAULT 0 NOT NULL,
	`includes_config` integer DEFAULT false NOT NULL,
	`level_name` text NOT NULL,
	`worlds` text DEFAULT '[]' NOT NULL,
	`note` text,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `backups_server_created_idx` ON `backups` (`server_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `mods` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `auto_start` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `backup_interval_hours` integer;--> statement-breakpoint
ALTER TABLE `servers` ADD `backup_keep_last` integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `backup_include_config` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `backup_schedule_since` integer;