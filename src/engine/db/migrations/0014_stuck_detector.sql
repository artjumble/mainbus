CREATE TABLE `stuck_episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_run_id` text NOT NULL,
	`rule` text NOT NULL,
	`evidence` text NOT NULL,
	`hit_count` integer NOT NULL,
	`opened_at` text NOT NULL,
	`last_hit_at` text NOT NULL,
	`escalated_at` text,
	`closed_at` text,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stuck_episodes_run_idx` ON `stuck_episodes` (`agent_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stuck_episodes_open_uq` ON `stuck_episodes` (`agent_run_id`) WHERE "stuck_episodes"."closed_at" is null;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `declared_wait` text;