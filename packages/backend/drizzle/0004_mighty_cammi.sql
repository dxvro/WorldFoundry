ALTER TABLE `backups` ADD `note_ref` text;--> statement-breakpoint
ALTER TABLE `backups` ADD `error_ref` text;--> statement-breakpoint
ALTER TABLE `mod_update_log` ADD `error_ref` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `install_error_ref` text;--> statement-breakpoint
ALTER TABLE `update_history` ADD `message_ref` text;