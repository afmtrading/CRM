-- -----------------------------------------------------------------------------
-- One option per value, whatever its casing
--
-- An option list is a vocabulary, and "Kenya" and "kenya" are the same word in
-- it. Uniqueness here was exact, so both could sit in one field: two rows, two
-- colours, two entries in every picker, and no way for anybody to tell why.
--
-- Tags and email suppressions have been folded this way since they were
-- written (tags_org_name_idx, email_suppressions_unique). This is field_options
-- catching up rather than a new idea.
--
-- A unique index rather than a constraint, because a constraint cannot be
-- expressed over lower(value). Postgres reports a violation of either as
-- "duplicate key value violates unique constraint", which is what the
-- application reads to turn it into a sentence.
-- -----------------------------------------------------------------------------

-- Refuse rather than choose. Folding a pair automatically would delete an
-- option that records already carry and silently drop its colour; naming the
-- pairs lets an administrator merge them deliberately, which is a decision
-- about their own vocabulary rather than one this migration should take.
do $$
declare
  clashes text;
begin
  select string_agg(format('%s.%s: %s', entity_type, field_key, variants), '; ')
    into clashes
  from (
    select entity_type,
           field_key,
           string_agg(value, ' + ' order by value) as variants
    from field_options
    group by organization_id, entity_type, field_key, lower(value)
    having count(*) > 1
  ) as folded;

  if clashes is not null then
    raise exception 'field_options holds values that differ only by case: %', clashes
      using hint = 'Delete or rename one of each pair in Settings, then apply this migration again.';
  end if;
end
$$;

alter table field_options drop constraint if exists field_options_unique;

create unique index if not exists field_options_value_unique
  on field_options (organization_id, entity_type, field_key, lower(value));
