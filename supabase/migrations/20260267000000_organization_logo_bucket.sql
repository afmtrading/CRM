-- =============================================================================
-- Somewhere to put the logo
--
-- `organizations.logo_url` has always been a box to paste a URL into, which
-- asks an administrator to first host the image somewhere else. For the one
-- image this business is most likely to have sitting on a desktop, that is the
-- wrong question. A bucket answers it.
--
-- The column does not change. An upload writes a URL into exactly the same
-- place a pasted one goes, so everything that reads a logo — the printed
-- document, the campaign emails — goes on reading one thing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Only where there is a storage schema
--
-- `npm run test:db` runs these migrations against a bare Postgres with the
-- handful of Supabase objects that 00_bootstrap.sql recreates, and storage is
-- not among them — it is a whole extension's worth of tables, and recreating
-- it to test a bucket would be testing the recreation.
--
-- So the storage half is skipped when the schema is absent. That keeps the
-- suite honest about what it covers rather than quietly not running: the
-- bucket and its policies are exercised in a real project, and nowhere else.
-- -----------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'no storage schema — skipping the logo bucket (expected under test:db)';
    return;
  end if;

  /*
   * Public, because the logo is on documents sent to customers and in the
   * footer of marketing email. Nothing about it is confidential, and a signed
   * URL would expire out from under an email somebody opens next week.
   *
   * The limits are on the bucket rather than only in the action, so they hold
   * against a request that never goes near this application's code. PNG and
   * JPEG only: the PDF renderer embeds those two and silently draws nothing
   * for an SVG, which would be discovered by a customer holding a letterhead
   * with a hole in it.
   */
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'org-logos',
    'org-logos',
    true,
    2 * 1024 * 1024,
    array['image/png', 'image/jpeg']
  )
  on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  /*
   * Writing is an administrator's, and only inside their own organization's
   * folder. The first path segment is the organization id, so
   * `foldername(name)[1]` is the tenancy check — the same question every
   * policy in this database asks, asked about an object key instead of a row.
   *
   * The read policy is spelled out even though a public bucket's object
   * endpoint never consults storage.objects — it is what the API's own
   * listing goes through, and product-images next door declares one for the
   * same reason. Two buckets in one project disagreeing about that is a
   * question somebody has to answer twice.
   */
  execute $p$drop policy if exists org_logos_read on storage.objects$p$;
  execute $p$
    create policy org_logos_read on storage.objects
      for select to public
      using (bucket_id = 'org-logos')
  $p$;

  execute $p$drop policy if exists org_logos_insert on storage.objects$p$;
  execute $p$
    create policy org_logos_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'org-logos'
        and (select public.is_org_admin())
        and (storage.foldername(name))[1] = (select public.current_org_id())::text
      )
  $p$;

  execute $p$drop policy if exists org_logos_update on storage.objects$p$;
  execute $p$
    create policy org_logos_update on storage.objects
      for update to authenticated
      using (
        bucket_id = 'org-logos'
        and (select public.is_org_admin())
        and (storage.foldername(name))[1] = (select public.current_org_id())::text
      )
      with check (
        bucket_id = 'org-logos'
        and (select public.is_org_admin())
        and (storage.foldername(name))[1] = (select public.current_org_id())::text
      )
  $p$;

  /*
   * Delete, so replacing a logo can take the old object with it rather than
   * leaving every logo this organization has ever had sitting in the bucket.
   */
  execute $p$drop policy if exists org_logos_delete on storage.objects$p$;
  execute $p$
    create policy org_logos_delete on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'org-logos'
        and (select public.is_org_admin())
        and (storage.foldername(name))[1] = (select public.current_org_id())::text
      )
  $p$;
end;
$$;
