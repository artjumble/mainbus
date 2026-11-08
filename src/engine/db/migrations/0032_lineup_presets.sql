CREATE TABLE `lineup_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`settings` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lineup_presets_workspace_idx` ON `lineup_presets` (`workspace_id`);
--> statement-breakpoint
-- Every workspace gets the built-in presets. They are the ones in src/engine/store/presets.ts as they were when this
-- migration was written. A role the lineup lacks is named by a placeholder id (planner, implementer), which no UUID can
-- equal, so applying the preset drops that part with the usual notice.
INSERT INTO `lineup_presets` (`id`, `workspace_id`, `position`, `name`, `settings`, `created_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
	w.`id`, 1, 'Full', '{"excludedRoleIds":[],"roles":{},"extraInstructions":null,"roleNames":{}}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `workspaces` w;
--> statement-breakpoint
INSERT INTO `lineup_presets` (`id`, `workspace_id`, `position`, `name`, `settings`, `created_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
	w.`id`, 2, 'Quick fix',
	CASE WHEN EXISTS (SELECT 1 FROM `lineup_roles` l WHERE l.`workspace_id` = w.`id` AND l.`lineup` = 'change' AND lower(trim(l.`name`)) = 'planner')
	THEN json_object(
		'excludedRoleIds', (SELECT json_group_array(id) FROM (SELECT l.`id` FROM `lineup_roles` l WHERE l.`workspace_id` = w.`id` AND l.`lineup` = 'change' AND lower(trim(l.`name`)) = 'planner' ORDER BY l.`position`)),
		'roles', json_object(), 'extraInstructions', NULL,
		'roleNames', (SELECT json_group_object(l.`id`, l.`name`) FROM `lineup_roles` l WHERE l.`workspace_id` = w.`id` AND l.`lineup` = 'change' AND lower(trim(l.`name`)) = 'planner'))
	ELSE '{"excludedRoleIds":["planner"],"roles":{},"extraInstructions":null,"roleNames":{"planner":"Planner"}}' END,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `workspaces` w;
--> statement-breakpoint
INSERT INTO `lineup_presets` (`id`, `workspace_id`, `position`, `name`, `settings`, `created_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
	w.`id`, 3, 'Docs',
	json_object(
		'excludedRoleIds', (SELECT json_group_array(id) FROM (SELECT l.`id` FROM `lineup_roles` l WHERE l.`workspace_id` = w.`id` AND l.`lineup` = 'change' AND l.`id` IS NOT coalesce(i.`id`, '') ORDER BY l.`position`)),
		'roles', json_object(coalesce(i.`id`, 'implementer'), json_object('model', 'sonnet', 'effort', 'medium')),
		'extraInstructions', NULL,
		'roleNames', json_set((SELECT json_group_object(l.`id`, l.`name`) FROM `lineup_roles` l WHERE l.`workspace_id` = w.`id` AND l.`lineup` = 'change'), '$."' || coalesce(i.`id`, 'implementer') || '"', coalesce(i.`name`, 'Implementer'))),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `workspaces` w
LEFT JOIN `lineup_roles` i ON i.`id` = (SELECT l.`id` FROM `lineup_roles` l WHERE l.`workspace_id` = w.`id` AND l.`lineup` = 'change' AND lower(trim(l.`name`)) = 'implementer' ORDER BY l.`position` LIMIT 1);
