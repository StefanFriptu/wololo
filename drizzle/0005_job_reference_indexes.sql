CREATE INDEX `media_files_last_job_idx` ON `media_files` (`last_job_id`);--> statement-breakpoint
CREATE INDEX `recycle_bin_job_idx` ON `recycle_bin` (`job_id`);--> statement-breakpoint
CREATE INDEX `recycle_bin_media_file_idx` ON `recycle_bin` (`media_file_id`);