ALTER TABLE `workspaces` ADD `unattended_on` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `removed_at` text;--> statement-breakpoint
UPDATE `workspaces` SET `unattended_on` = 1 WHERE EXISTS (SELECT 1 FROM `app_settings` WHERE `key` = 'unattended' AND `value` = 'on');--> statement-breakpoint
DELETE FROM `app_settings` WHERE `key` = 'unattended';--> statement-breakpoint
UPDATE `workspaces` SET `slug` = `slug` || '-' || `rowid` WHERE `rowid` NOT IN (SELECT MIN(`rowid`) FROM `workspaces` GROUP BY `slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_uq` ON `workspaces` (`slug`);
