CREATE INDEX `jobs_library_idx` ON `jobs` (`library_id`);--> statement-breakpoint
CREATE INDEX `jobs_profile_idx` ON `jobs` (`profile_id`);--> statement-breakpoint
CREATE INDEX `jobs_temp_path_idx` ON `jobs` (`temp_path`);--> statement-breakpoint
CREATE INDEX `jobs_recycle_bin_entry_idx` ON `jobs` (`recycle_bin_entry_id`);--> statement-breakpoint
CREATE INDEX `library_profiles_profile_idx` ON `library_profiles` (`profile_id`,`library_id`);--> statement-breakpoint
CREATE INDEX `media_files_root_idx` ON `media_files` (`root_id`);