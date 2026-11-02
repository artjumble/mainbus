CREATE TABLE `orchestrator_wakes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`created_at` text NOT NULL,
	`presented_at` text,
	`acked_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orchestrator_wakes_pending_uq` ON `orchestrator_wakes` (`kind`,`ref`) WHERE "orchestrator_wakes"."acked_at" is null;--> statement-breakpoint
CREATE INDEX `orchestrator_wakes_acked_idx` ON `orchestrator_wakes` (`acked_at`);