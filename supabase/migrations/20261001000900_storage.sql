-- =============================================================================
-- 0009 STORAGE: private bucket for invoice photos / PDFs.
-- No storage policies are granted to API roles: files are uploaded and read
-- only by the web server (server-only key) AFTER a database function has
-- authorized the specific action (register_invoice_document /
-- can_view_invoice_document). Viewing uses short-lived signed URLs.
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 15728640,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
