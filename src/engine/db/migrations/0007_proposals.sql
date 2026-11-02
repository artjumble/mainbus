CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`orchestrator_run_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`evidence` text,
	`status` text NOT NULL,
	`result` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`orchestrator_run_id`) REFERENCES `orchestrator_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proposals_decided_idx` ON `proposals` (`status`,`decided_at`);