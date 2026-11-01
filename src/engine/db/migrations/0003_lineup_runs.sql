CREATE TABLE `ticket_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`roles` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_runs_ticket_idx` ON `ticket_runs` (`ticket_id`);
--> statement-breakpoint
-- Every existing agent run gets its own one-role ticket run, with the same id, so old threads still load.
-- The role is copied from the lineup role of the same name, with the run's own model and effort; a run whose
-- role is no longer in the lineup gets the Implementer's phase and tool profile and no instructions of its own.
INSERT INTO `ticket_runs` (`id`, `ticket_id`, `roles`, `status`, `started_at`, `ended_at`)
SELECT r.`id`, r.`ticket_id`,
	json_array(json_object(
		'id', coalesce(lr.`id`, r.`id`),
		'workspaceId', t.`workspace_id`,
		'lineup', 'change',
		'position', 1,
		'name', r.`role`,
		'instructions', coalesce(lr.`instructions`, 'Make the change and its tests. Run the tests. Commit your work on the branch before handing off.'),
		'activePhase', coalesce(lr.`active_phase`, 'implementing'),
		'onProblem', 'ask_me',
		'handBackTo', NULL,
		'model', r.`model`,
		'effort', r.`effort`,
		'toolProfile', coalesce(lr.`tool_profile`, 'edit')
	)),
	CASE r.`end_reason` WHEN 'handoff' THEN 'done' WHEN 'stopped' THEN 'stopped' WHEN 'failed' THEN 'failed' ELSE 'running' END,
	r.`started_at`, r.`ended_at`
FROM `agent_runs` r
JOIN `tickets` t ON t.`id` = r.`ticket_id`
LEFT JOIN `lineup_roles` lr ON lr.`workspace_id` = t.`workspace_id` AND lr.`lineup` = 'change' AND lower(lr.`name`) = lower(r.`role`);
--> statement-breakpoint
CREATE TABLE `__new_agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`ticket_run_id` text NOT NULL,
	`role_id` text NOT NULL,
	`role` text NOT NULL,
	`session_id` text,
	`model` text,
	`effort` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`end_reason` text,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_run_id`) REFERENCES `ticket_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- rowid is kept: it breaks ties between runs started in the same millisecond.
INSERT INTO `__new_agent_runs` (`rowid`, `id`, `ticket_id`, `ticket_run_id`, `role_id`, `role`, `session_id`, `model`, `effort`, `started_at`, `ended_at`, `end_reason`)
SELECT r.`rowid`, r.`id`, r.`ticket_id`, r.`id`, json_extract(tr.`roles`, '$[0].id'), r.`role`, r.`session_id`, r.`model`, r.`effort`, r.`started_at`, r.`ended_at`, r.`end_reason`
FROM `agent_runs` r
JOIN `ticket_runs` tr ON tr.`id` = r.`id`;
--> statement-breakpoint
DROP TABLE `agent_runs`;
--> statement-breakpoint
ALTER TABLE `__new_agent_runs` RENAME TO `agent_runs`;
--> statement-breakpoint
CREATE INDEX `agent_runs_ticket_idx` ON `agent_runs` (`ticket_id`);
