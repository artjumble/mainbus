CREATE TABLE `ticket_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`orchestrator_run_id` text NOT NULL,
	`at` text NOT NULL,
	`fields` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`intent_added` text NOT NULL,
	`ticket_updated_at` text NOT NULL,
	`undone_at` text,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`orchestrator_run_id`) REFERENCES `orchestrator_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_edits_ticket_idx` ON `ticket_edits` (`ticket_id`);