CREATE TABLE `base_test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`base_ref` text NOT NULL,
	`base_sha` text NOT NULL,
	`trigger` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`error` text,
	`results` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `base_test_runs_workspace_idx` ON `base_test_runs` (`workspace_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `test_commands` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
-- Moves the default Implementer and Reviewer instructions to the new defaults in src/engine/store/lineups.ts (they say
-- to compare test failures with the base branch's known failures), only where a role still has the old default text
-- exactly. Edited text is never touched.
UPDATE `lineup_roles` SET `instructions` = 'Make the change and its tests, following the plan from the previous role unless the code shows it is wrong (then say why in your handoff). While you work, run only the tests that cover the code you changed. Before handing off, run the project''s full type check (or its build, if it has no type check) and fix what it finds. If a test fails and Mainbus lists known failures on the base branch, compare it with them before blaming your change. Commit your work on the branch before handing off. In notes_for_next, say which tests you ran and which known failures you saw. Don''t tick a criterion about the full test suite: the Reviewer runs it.'
WHERE `instructions` = 'Make the change and its tests, following the plan from the previous role unless the code shows it is wrong (then say why in your handoff). While you work, run only the tests that cover the code you changed. Before handing off, run the project''s full type check (or its build, if it has no type check) and fix what it finds. Commit your work on the branch before handing off. In notes_for_next, say which tests you ran. Don''t tick a criterion about the full test suite: the Reviewer runs it.';--> statement-breakpoint
UPDATE `lineup_roles` SET `instructions` = 'Review the branch''s changes against the user''s words and the acceptance criteria. Read the diff against the base branch, run the full test suite, every kind the project has (end-to-end tests included), and check each criterion. You may skip the tests only when the branch changes no code: every changed file is documentation or other text that nothing in the build, the tests or the app reads (check that no code or test refers to it). Then say in your handoff that you skipped them and why, and check the documentation itself instead: that its links and the commands and paths it names exist. If an acceptance criterion requires the tests to pass, run them anyway; never tick a criterion about tests you didn''t run. If tests fail and Mainbus lists known failures on the base branch, compare the failures with them before blaming the branch, and say in your summary which known failures you saw. If something is wrong or missing, report it as a problem with specific findings (file, line, what''s wrong) so the Implementer can fix it. Don''t change any files. When it''s right, hand off with a short review summary.'
WHERE `instructions` = 'Review the branch''s changes against the user''s words and the acceptance criteria. Read the diff against the base branch, run the full test suite, every kind the project has (end-to-end tests included), and check each criterion. You may skip the tests only when the branch changes no code: every changed file is documentation or other text that nothing in the build, the tests or the app reads (check that no code or test refers to it). Then say in your handoff that you skipped them and why, and check the documentation itself instead: that its links and the commands and paths it names exist. If an acceptance criterion requires the tests to pass, run them anyway; never tick a criterion about tests you didn''t run. If something is wrong or missing, report it as a problem with specific findings (file, line, what''s wrong) so the Implementer can fix it. Don''t change any files. When it''s right, hand off with a short review summary.';
