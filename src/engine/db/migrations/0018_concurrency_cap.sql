CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `queued_seq` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `queued_prompt` text;