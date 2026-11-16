ALTER TABLE `media_files` ADD `stream_codecs` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `media_files` SET `stream_codecs` = (SELECT json_group_array(DISTINCT json_extract(`value`, '$.codec')) FROM json_each(`media_files`.`probe`, '$.streams') WHERE json_extract(`value`, '$.codec') IS NOT NULL) WHERE `probe` IS NOT NULL;
