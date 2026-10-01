-- =============================================================================
-- 0010 ADMIN EVENTS
-- Login accounts are created/changed by the web server with the server-only
-- admin key after it verified the caller is an owner. This function records
-- WHICH owner did it in the audit log (the admin key itself has no identity).
-- =============================================================================
create or replace function public.log_admin_event(p_action text, p_summary text, p_entity_id text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor app.actor := app.require_actor('accounts.manage');
begin
  if not app.is_owner() then
    perform app.fail('FORBIDDEN', 'Owner only.');
  end if;
  if p_action not in ('account.created', 'account.password_reset') then
    perform app.fail('VALIDATION', 'Unknown admin event.');
  end if;
  perform app.audit(v_actor, p_action, 'security', app.actor_label(v_actor) || ' ' || left(p_summary, 200),
    'account_profiles', p_entity_id);
end;
$$;
revoke execute on function public.log_admin_event(text, text, text) from public, anon;
grant execute on function public.log_admin_event(text, text, text) to authenticated;
