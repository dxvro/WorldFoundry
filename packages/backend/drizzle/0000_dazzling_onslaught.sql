CREATE TABLE `mod_dependencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mod_id` text NOT NULL,
	`dependency_type` text NOT NULL,
	`project_id` text,
	`version_id` text,
	`file_name` text,
	`depends_on_mod_id` text,
	FOREIGN KEY (`mod_id`) REFERENCES `mods`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_mod_id`) REFERENCES `mods`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `mod_dependencies_mod_id_idx` ON `mod_dependencies` (`mod_id`);--> statement-breakpoint
CREATE INDEX `mod_dependencies_depends_on_mod_id_idx` ON `mod_dependencies` (`depends_on_mod_id`);--> statement-breakpoint
CREATE TABLE `mod_update_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`mod_id` text,
	`mod_name` text NOT NULL,
	`from_version_id` text,
	`to_version_id` text,
	`from_file_name` text,
	`to_file_name` text,
	`backup_path` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mod_id`) REFERENCES `mods`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `mod_update_log_server_created_idx` ON `mod_update_log` (`server_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mods` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`source` text NOT NULL,
	`project_id` text,
	`version_id` text,
	`version_number` text,
	`name` text NOT NULL,
	`file_name` text NOT NULL,
	`sha512` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`is_dependency` integer DEFAULT false NOT NULL,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mods_server_file_name_uq` ON `mods` (`server_id`,`file_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `mods_server_sha512_uq` ON `mods` (`server_id`,`sha512`);--> statement-breakpoint
CREATE UNIQUE INDEX `mods_server_project_uq` ON `mods` (`server_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`loader` text NOT NULL,
	`mc_version` text NOT NULL,
	`loader_version` text,
	`install_state` text DEFAULT 'pending' NOT NULL,
	`install_error` text,
	`port` integer DEFAULT 25565 NOT NULL,
	`java_path` text,
	`min_ram_mb` integer DEFAULT 1024 NOT NULL,
	`max_ram_mb` integer DEFAULT 2048 NOT NULL,
	`use_aikar_flags` integer DEFAULT false NOT NULL,
	`extra_jvm_args` text DEFAULT '' NOT NULL,
	`eula_accepted` integer DEFAULT false NOT NULL,
	`last_started_at` integer,
	`last_exit_code` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `servers_port_idx` ON `servers` (`port`);