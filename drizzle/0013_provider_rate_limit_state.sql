ALTER TABLE `payment_ingresses` ADD `rate_limited_until` integer;
--> statement-breakpoint
ALTER TABLE `payment_ingresses` ADD `consecutive_rate_limits` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `payment_ingresses` ADD `last_retry_after_ms` integer;
--> statement-breakpoint
ALTER TABLE `payment_ingresses` ADD `last_provider_success_at` integer;
