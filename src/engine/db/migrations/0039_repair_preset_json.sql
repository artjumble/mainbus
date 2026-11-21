-- Repair presets that the first version of migration 0032 wrote with excludedRoleIds or roleNames as a JSON string
-- holding the array/object ("[\"id\"]") instead of the array/object itself, on a SQLite build that lost the JSON subtype.
-- Only a value that is a string holding valid JSON of the right kind is rewritten, so correct rows are left alone and a
-- second run changes nothing.
UPDATE `lineup_presets`
SET `settings` = json_set(`settings`, '$.excludedRoleIds', json(json_extract(`settings`, '$.excludedRoleIds')))
WHERE json_valid(`settings`)
	AND json_type(`settings`, '$.excludedRoleIds') = 'text'
	AND json_valid(json_extract(`settings`, '$.excludedRoleIds'))
	AND json_type(json_extract(`settings`, '$.excludedRoleIds')) = 'array';
--> statement-breakpoint
UPDATE `lineup_presets`
SET `settings` = json_set(`settings`, '$.roleNames', json(json_extract(`settings`, '$.roleNames')))
WHERE json_valid(`settings`)
	AND json_type(`settings`, '$.roleNames') = 'text'
	AND json_valid(json_extract(`settings`, '$.roleNames'))
	AND json_type(json_extract(`settings`, '$.roleNames')) = 'object';
