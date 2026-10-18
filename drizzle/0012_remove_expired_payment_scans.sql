DROP INDEX `orders_payment_scan_idx`;
--> statement-breakpoint
CREATE INDEX `orders_payment_scan_idx` ON `orders` (`last_payment_scan_at`,`created_at`,`id`) WHERE "orders"."status" IN ('pending', 'confirming', 'partially_paid', 'paid', 'overpaid');
