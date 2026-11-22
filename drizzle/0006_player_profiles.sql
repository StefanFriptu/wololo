INSERT INTO `library_profiles` (`library_id`, `profile_id`)
SELECT `libraries`.`id`, (SELECT `id` FROM `device_profiles` WHERE `builtin` = 1 ORDER BY `id` LIMIT 1)
FROM `libraries`
WHERE NOT EXISTS (SELECT 1 FROM `library_profiles` WHERE `library_profiles`.`library_id` = `libraries`.`id`)
	AND EXISTS (SELECT 1 FROM `device_profiles` WHERE `builtin` = 1);--> statement-breakpoint
ALTER TABLE `device_profiles` DROP COLUMN `builtin`;--> statement-breakpoint
ALTER TABLE `jobs` ADD `profile_id` integer REFERENCES `device_profiles`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `media_files` ADD `profile_results` text;--> statement-breakpoint
UPDATE `media_files` SET `rules_key` = NULL WHERE `kind` = 'file';
