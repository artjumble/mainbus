ALTER TABLE `tickets` ADD `setup` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `setup_command` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `setup_timeout_minutes` integer DEFAULT 15 NOT NULL;