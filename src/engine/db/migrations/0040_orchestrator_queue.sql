CREATE TABLE `orchestrator_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`images` text DEFAULT '[]' NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`queued_at` text NOT NULL,
	`held_reason` text
);
