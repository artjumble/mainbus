CREATE TABLE `ticket_dependencies` (
	`ticket_id` text NOT NULL,
	`blocked_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `blocked_by_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_by_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_dependencies_blocker_idx` ON `ticket_dependencies` (`blocked_by_id`);--> statement-breakpoint
CREATE TABLE `ticket_dependency_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` text NOT NULL,
	`blockers` text NOT NULL,
	`via` text,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_dependency_notes_ticket_idx` ON `ticket_dependency_notes` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `ticket_dependency_notes_kind_idx` ON `ticket_dependency_notes` (`kind`,`at`);