ALTER TABLE `webhook_attempts` ADD `diagnostic_detail` text;
--> statement-breakpoint
DROP INDEX `webhook_attempts_delivery_attempt_uidx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_attempts_delivery_attempt_request_uidx` ON `webhook_attempts` (`delivery_id`,`attempt`,`request_id`);
