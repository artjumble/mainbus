CREATE TABLE `lineup_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`lineup` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`instructions` text NOT NULL,
	`active_phase` text NOT NULL,
	`on_problem` text NOT NULL,
	`hand_back_to` text,
	`model` text,
	`effort` text,
	`tool_profile` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lineup_roles_position_uq` ON `lineup_roles` (`workspace_id`,`lineup`,`position`);
--> statement-breakpoint
-- Each workspace's one role becomes its Change lineup's Implementer, keeping its instructions, model and
-- effort, with the default Planner before it and the default Reviewer after it. The texts are the defaults
-- in src/engine/store/lineups.ts as they were when this migration was written.
INSERT INTO `lineup_roles` (`id`, `workspace_id`, `lineup`, `position`, `name`, `instructions`, `active_phase`, `on_problem`, `hand_back_to`, `model`, `effort`, `tool_profile`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
	`workspace_id`, 'change', 1, 'Planner',
	'Read the ticket and the code it touches. Work out the approach: the files to change, the design, and the tests that will prove it. Don''t change any files. Hand off with the plan as your summary and anything the Implementer must watch for in notes_for_next.',
	'planning', 'ask_me', NULL, NULL, NULL, 'read_only'
FROM `roles`;
--> statement-breakpoint
INSERT INTO `lineup_roles` (`id`, `workspace_id`, `lineup`, `position`, `name`, `instructions`, `active_phase`, `on_problem`, `hand_back_to`, `model`, `effort`, `tool_profile`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
	r.`workspace_id`, 'change', 2, 'Implementer', r.`instructions`, 'implementing', 'hand_back',
	(SELECT p.`id` FROM `lineup_roles` p WHERE p.`workspace_id` = r.`workspace_id` AND p.`lineup` = 'change' AND p.`position` = 1),
	r.`model`, r.`effort`, 'edit'
FROM `roles` r;
--> statement-breakpoint
INSERT INTO `lineup_roles` (`id`, `workspace_id`, `lineup`, `position`, `name`, `instructions`, `active_phase`, `on_problem`, `hand_back_to`, `model`, `effort`, `tool_profile`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
	`workspace_id`, 'change', 3, 'Reviewer',
	'Review the branch''s changes against the user''s words and the acceptance criteria. Read the diff against the base branch, run the tests, and check each criterion. If something is wrong or missing, report it as a problem with specific findings (file, line, what''s wrong) so the Implementer can fix it. Don''t change any files. When it''s right, hand off with a short review summary.',
	'reviewing', 'hand_back',
	(SELECT i.`id` FROM `lineup_roles` i WHERE i.`workspace_id` = `roles`.`workspace_id` AND i.`lineup` = 'change' AND i.`position` = 2),
	NULL, NULL, 'read_only'
FROM `roles`;
--> statement-breakpoint
DROP TABLE `roles`;
