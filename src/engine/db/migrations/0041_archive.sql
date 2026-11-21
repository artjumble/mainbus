ALTER TABLE `tickets` ADD `done_at` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `tickets_workspace_archived_idx` ON `tickets` (`workspace_id`,`archived_at`);--> statement-breakpoint
-- Approximate: updated_at is bumped by any later edit (blockers, report file, notes), so old tickets get their last change, not when they reached Done.
UPDATE `tickets` SET `done_at` = `updated_at` WHERE `manual_column` = 'done' AND `done_at` IS NULL;
