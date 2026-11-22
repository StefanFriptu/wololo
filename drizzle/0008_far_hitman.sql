CREATE TABLE `torrent_removals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hash` text NOT NULL,
	`name` text NOT NULL,
	`condition` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `torrent_removals_hash_idx` ON `torrent_removals` (`hash`);--> statement-breakpoint
CREATE INDEX `torrent_removals_state_idx` ON `torrent_removals` (`state`);