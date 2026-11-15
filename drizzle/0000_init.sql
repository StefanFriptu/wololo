CREATE TABLE `arr_instances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`api_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arr_instances_name_unique` ON `arr_instances` (`name`);--> statement-breakpoint
CREATE TABLE `bdmv_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_file_id` integer NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`message` text NOT NULL,
	`title_candidates` text DEFAULT '[]' NOT NULL,
	`movie_candidates` text DEFAULT '[]' NOT NULL,
	`choice` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bdmv_decisions_state_idx` ON `bdmv_decisions` (`state`);--> statement-breakpoint
CREATE INDEX `bdmv_decisions_media_idx` ON `bdmv_decisions` (`media_file_id`);--> statement-breakpoint
CREATE TABLE `device_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`definition` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_profiles_name_unique` ON `device_profiles` (`name`);--> statement-breakpoint
CREATE TABLE `download_client` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'qbittorrent' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`url` text NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`password` text DEFAULT '' NOT NULL,
	`remove_when_goal_met` integer DEFAULT false NOT NULL,
	`category` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`media_file_id` integer,
	`event` text NOT NULL,
	`path` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `job_history_created_idx` ON `job_history` (`created_at`);--> statement-breakpoint
CREATE INDEX `job_history_job_idx` ON `job_history` (`job_id`);--> statement-breakpoint
CREATE INDEX `job_history_media_file_idx` ON `job_history` (`media_file_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`step` text DEFAULT 'waiting' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`trigger` text NOT NULL,
	`media_file_id` integer,
	`library_id` integer,
	`title` text NOT NULL,
	`source_path` text NOT NULL,
	`output_path` text,
	`temp_path` text,
	`rules_key` text,
	`plan` text,
	`bdmv_plan` text,
	`before_streams` text,
	`after_streams` text,
	`lost_features` text DEFAULT '[]' NOT NULL,
	`verification` text,
	`progress` real DEFAULT 0 NOT NULL,
	`speed` real,
	`eta_sec` real,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`log_path` text,
	`bytes_before` integer,
	`bytes_after` integer,
	`recycle_bin_entry_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `jobs_state_idx` ON `jobs` (`state`,`priority`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_media_file_idx` ON `jobs` (`media_file_id`);--> statement-breakpoint
CREATE TABLE `libraries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'movies' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`mode` text DEFAULT 'replace' NOT NULL,
	`keep_languages` text DEFAULT '[]' NOT NULL,
	`keep_original_language` integer DEFAULT true NOT NULL,
	`keep_undetermined` integer DEFAULT true NOT NULL,
	`arr_instance_id` integer,
	`bdmv_enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`arr_instance_id`) REFERENCES `arr_instances`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_name_unique` ON `libraries` (`name`);--> statement-breakpoint
CREATE TABLE `library_profiles` (
	`library_id` integer NOT NULL,
	`profile_id` integer NOT NULL,
	PRIMARY KEY(`library_id`, `profile_id`),
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `device_profiles`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `library_roots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`library_id` integer NOT NULL,
	`path` text NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_roots_path_unique` ON `library_roots` (`path`);--> statement-breakpoint
CREATE TABLE `media_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`library_id` integer NOT NULL,
	`root_id` integer NOT NULL,
	`path` text NOT NULL,
	`kind` text DEFAULT 'file' NOT NULL,
	`size_bytes` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_reason` text,
	`rules_key` text,
	`probe` text,
	`plan` text,
	`plan_action` text,
	`duration_sec` real,
	`format_name` text,
	`video_codec` text,
	`audio_codecs` text DEFAULT '[]' NOT NULL,
	`subtitle_languages` text DEFAULT '[]' NOT NULL,
	`failing_codecs` text DEFAULT '[]' NOT NULL,
	`original_language` text,
	`arr_instance_id` integer,
	`arr_kind` text,
	`arr_item_id` integer,
	`arr_file_id` integer,
	`last_job_id` integer,
	`probed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`root_id`) REFERENCES `library_roots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`arr_instance_id`) REFERENCES `arr_instances`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_path_idx` ON `media_files` (`path`);--> statement-breakpoint
CREATE INDEX `media_files_library_idx` ON `media_files` (`library_id`);--> statement-breakpoint
CREATE INDEX `media_files_status_idx` ON `media_files` (`status`);--> statement-breakpoint
CREATE INDEX `media_files_rules_key_idx` ON `media_files` (`rules_key`);--> statement-breakpoint
CREATE TABLE `path_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`instance_id` integer,
	`remote_path` text NOT NULL,
	`local_path` text NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `arr_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plex_connection` (
	`id` integer PRIMARY KEY NOT NULL,
	`client_identifier` text NOT NULL,
	`account_token` text,
	`username` text,
	`server_machine_id` text,
	`server_name` text,
	`server_url` text,
	`server_token` text,
	`enabled` integer DEFAULT false NOT NULL,
	`partial_scan` integer DEFAULT true NOT NULL,
	`pause_while_streaming` integer DEFAULT false NOT NULL,
	`pending_pin_id` integer,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recycle_bin` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`original_path` text NOT NULL,
	`recycle_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uid` integer,
	`gid` integer,
	`mode` integer,
	`job_id` integer,
	`media_file_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	`restored_at` text,
	`purged_at` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`media_file_id`) REFERENCES `media_files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recycle_bin_recycle_path_unique` ON `recycle_bin` (`recycle_path`);--> statement-breakpoint
CREATE INDEX `recycle_bin_expires_idx` ON `recycle_bin` (`expires_at`);--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`name` text PRIMARY KEY NOT NULL,
	`interval_minutes` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`last_duration_ms` integer,
	`last_result` text,
	`last_message` text,
	`next_run_at` text
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
