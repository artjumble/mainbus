CREATE TABLE `ticket_owner_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`owner` text NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_owner_changes_ticket_idx` ON `ticket_owner_changes` (`ticket_id`);--> statement-breakpoint
ALTER TABLE `tickets` ADD `owner` text DEFAULT 'agent' NOT NULL;