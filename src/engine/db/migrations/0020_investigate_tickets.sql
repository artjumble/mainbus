ALTER TABLE `tickets` ADD `report` text;--> statement-breakpoint
-- Every workspace gets the Investigate lineup: one read-only Investigator. The text is the default in
-- src/engine/store/lineups.ts as it was when this migration was written.
INSERT INTO `lineup_roles` (`id`, `workspace_id`, `lineup`, `position`, `name`, `instructions`, `active_phase`, `on_problem`, `hand_back_to`, `model`, `effort`, `tool_profile`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
	`id`, 'investigate', 1, 'Investigator',
	'Find out what''s going on and write it up; don''t change code. Your report may recommend changes but does not authorize them.',
	'planning', 'ask_me', NULL, NULL, NULL, 'read_only'
FROM `workspaces`
WHERE NOT EXISTS (SELECT 1 FROM `lineup_roles` l WHERE l.`workspace_id` = `workspaces`.`id` AND l.`lineup` = 'investigate');
