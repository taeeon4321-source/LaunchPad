-- The app's login role must be able to SET ROLE app_user for row-level security. Managed hosts (e.g. Render)
-- don't use a superuser, so grant membership explicitly. Ignored where it isn't permitted (then grant it manually).
do $$ begin execute format('grant app_user to %I', current_user); exception when others then raise notice 'grant app_user skipped: %', sqlerrm; end $$;
