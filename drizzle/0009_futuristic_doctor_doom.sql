CREATE TABLE `telegram_payment_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`telegram_user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`step` text NOT NULL,
	`amount` text,
	`currency` text,
	`network` text,
	`asset` text,
	`order_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `telegram_bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_payment_sessions_user_uidx` ON `telegram_payment_sessions` (`bot_id`,`telegram_user_id`);--> statement-breakpoint
CREATE INDEX `telegram_payment_sessions_expiry_idx` ON `telegram_payment_sessions` (`expires_at`);
