ALTER TABLE `tickets` ADD `rank` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `tickets` SET `rank` = `number`;
