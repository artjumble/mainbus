ALTER TABLE `decisions` ADD `answered_by` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `answered_via` text;--> statement-breakpoint
UPDATE `decisions` SET `answered_by` = 'user', `answered_via` = 'thread' WHERE `status` = 'answered';
