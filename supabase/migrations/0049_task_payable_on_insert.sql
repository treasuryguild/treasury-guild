-- A native task is payable exactly when it sits in its board's payable
-- column. Moving a card sets audited / pay_state from the column
-- (useBoardMutations.moveTask), but the browser insert is column-granted to
-- (workgroup_id, title, column_id) (0046), so a task typed straight into
-- Audited stayed not payable and never reached Payday. Derive it on insert.
--
-- Only a native task still at 'none' is touched: finalize_call inserts
-- 'payable', the chain import 'paid', and GitHub tasks follow their label.
create function public.task_payable_from_column() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.source = 'native' and new.pay_state = 'none' and new.column_id is not null
     and exists (select 1 from board_columns where id = new.column_id and marks_payable) then
    new.audited := true;
    new.pay_state := 'payable';
  end if;
  return new;
end $$;
create trigger task_payable_from_column before insert on public.tasks
  for each row execute function public.task_payable_from_column();
revoke all on function public.task_payable_from_column() from public, anon, authenticated;
