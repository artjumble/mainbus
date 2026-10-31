CREATE TABLE `agent_events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`json` text NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`role` text NOT NULL,
	`session_id` text,
	`model` text,
	`effort` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`end_reason` text,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runs_ticket_idx` ON `agent_runs` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `allow_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`pattern` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `allow_rules_workspace_idx` ON `allow_rules` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `criteria` (
	`ticket_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`ticket_id`, `position`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`agent_run_id` text NOT NULL,
	`kind` text NOT NULL,
	`question` text NOT NULL,
	`options` text NOT NULL,
	`recommended` integer,
	`status` text NOT NULL,
	`answer` text,
	`allow_always` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`answered_at` text,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decisions_ticket_idx` ON `decisions` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `pending_cleanups` (
	`ticket_id` text PRIMARY KEY NOT NULL,
	`repo_path` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`instructions` text NOT NULL,
	`active_phase` text NOT NULL,
	`tool_profile` text NOT NULL,
	`model` text,
	`effort` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`number` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`intent` text NOT NULL,
	`spec` text NOT NULL,
	`labels` text NOT NULL,
	`manual_column` text NOT NULL,
	`branch` text,
	`worktree_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_workspace_number_uq` ON `tickets` (`workspace_id`,`number`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`base_branch` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text NOT NULL
);
