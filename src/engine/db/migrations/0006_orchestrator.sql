CREATE TABLE `orchestrator_events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`json` text NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `orchestrator_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `orchestrator_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`end_reason` text
);
