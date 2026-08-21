ALTER TABLE `inference_usage_ledger_entries` ADD `model_id` varchar(255);--> statement-breakpoint
ALTER TABLE `inference_usage_ledger_entries` ADD `provider_id` varchar(255);--> statement-breakpoint
ALTER TABLE `inference_usage_ledger_entries` ADD `input_tokens` int;--> statement-breakpoint
ALTER TABLE `inference_usage_ledger_entries` ADD `output_tokens` int;--> statement-breakpoint
ALTER TABLE `inference_usage_ledger_entries` ADD `total_tokens` int;