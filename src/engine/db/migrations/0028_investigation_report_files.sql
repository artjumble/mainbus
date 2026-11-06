ALTER TABLE `tickets` ADD `report_file` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `report_commit` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `report_file_error` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `save_reports` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `reports_folder` text DEFAULT 'docs/investigations' NOT NULL;