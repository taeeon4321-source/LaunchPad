-- Entitlement checks look up subscriptions by user on most requests; webhooks look them up by Paddle id alone.
create index if not exists subscriptions_user on subscriptions (user_id);
create index if not exists subscriptions_provider_id on subscriptions (provider_subscription_id);
