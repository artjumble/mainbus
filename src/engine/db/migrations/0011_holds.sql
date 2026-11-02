CREATE TABLE `holds` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text,
	`until` text,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` text NOT NULL,
	`released_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holds_active_uq` ON `holds` (`target_kind`,`target_id`) WHERE "holds"."released_at" is null;--> statement-breakpoint
CREATE INDEX `holds_released_idx` ON `holds` (`released_at`);