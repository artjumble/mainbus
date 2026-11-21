CREATE TABLE `archive_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`older_than_days` integer NOT NULL,
	`count` integer NOT NULL,
	`created_at` text NOT NULL,
	`notice_closed_at` text,
	`restored_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `archive_batches_workspace_idx` ON `archive_batches` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `tickets` ADD `archive_batch_id` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `restored_at` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `auto_archive_days` integer;