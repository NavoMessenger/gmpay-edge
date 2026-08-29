ALTER TABLE `payment_ingresses` ADD `last_payment_scan_at` integer;--> statement-breakpoint
ALTER TABLE `payment_ingresses` ADD `last_payment_scan_error_code` text;