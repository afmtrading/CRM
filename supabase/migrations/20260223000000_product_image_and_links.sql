-- =============================================================================
-- A picture of the product, and two places to find more about it
--
-- Three columns and a storage bucket.
--
--   image_path          the object key of one photo, held in Supabase Storage
--   folder_url          wherever the paperwork lives — Drive, Dropbox, a share
--   knowledge_base_url  the spec sheet, the manual, the internal write-up
--
-- The two links join barcode_url and the comparison links: stored as typed and
-- rendered through safeUrl(), which is what actually keeps a `javascript:` URL
-- out of an href. Validating on the way in would reject a bare domain somebody
-- pasted out of a browser bar.
--
-- WHY A PATH RATHER THAN A URL
--
-- image_path holds the object key — `<org>/<product>/<random>.jpg` — and the
-- app builds the public URL from it. Storing the whole URL would bake this
-- project's hostname into every row, and moving or restoring the project would
-- leave a catalogue of dead links pointing at somewhere that no longer answers.
-- =============================================================================

alter table products
  /** Object key in the product-images bucket. The URL is built from it. */
  add column if not exists image_path        text,
  add column if not exists folder_url        text,
  add column if not exists knowledge_base_url text;

comment on column products.image_path is
  'Object key in the product-images storage bucket. Never a URL — see 20260223000000.';

-- -----------------------------------------------------------------------------
-- Somewhere to put the photo
--
-- The whole block is skipped when the storage schema is absent, which is how
-- the test database runs: scripts/test-db.sh builds a bare Postgres from these
-- migrations, and bare Postgres has no `storage` schema to put a bucket in.
-- Guarding it here keeps one migration file true of both.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'No storage schema here — skipping the product-images bucket.';
    return;
  end if;

  -- Public, and deliberately so. A product photo is not confidential the way a
  -- contact is, the URL has a random segment in it, and a public URL is the
  -- only kind that renders in an email or a shared export. The limits are set
  -- here as well as in the app: a browser can be told anything, and the bucket
  -- is the last place that can refuse a 200 MB "photo".
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'product-images', 'product-images', true, 5242880,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
  )
  on conflict (id) do update set
    public             = excluded.public,
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

  -- The first segment of the key is the organization that owns the file, and
  -- these policies are what make that mean something rather than being a
  -- naming convention. A manager may write only under their own organization's
  -- folder, whatever key the browser asks for.
  execute $p$drop policy if exists product_images_read on storage.objects$p$;
  execute $p$
    create policy product_images_read on storage.objects
      for select to public
      using (bucket_id = 'product-images')
  $p$;

  execute $p$drop policy if exists product_images_insert on storage.objects$p$;
  execute $p$
    create policy product_images_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'product-images'
        and (storage.foldername(name))[1] = public.current_org_id()::text
        and public.can_manage_records()
      )
  $p$;

  execute $p$drop policy if exists product_images_update on storage.objects$p$;
  execute $p$
    create policy product_images_update on storage.objects
      for update to authenticated
      using (
        bucket_id = 'product-images'
        and (storage.foldername(name))[1] = public.current_org_id()::text
        and public.can_manage_records()
      )
  $p$;

  -- Replacing a photo deletes the one it replaced, so this is used as often as
  -- the insert policy is.
  execute $p$drop policy if exists product_images_delete on storage.objects$p$;
  execute $p$
    create policy product_images_delete on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'product-images'
        and (storage.foldername(name))[1] = public.current_org_id()::text
        and public.can_manage_records()
      )
  $p$;
end
$$;
