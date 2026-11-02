ALTER TABLE `agent_runs` ADD `redirect_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `stuck_episodes` ADD `redirected_at` text;