ALTER TABLE `tickets` ADD `pr_url` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `pr_number` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `pr_error` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `open_pr_on_review` integer DEFAULT false NOT NULL;