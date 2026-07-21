-- 5.2.1 hardening: cap bug-report screenshot uploads server-side.
--
-- The Report modal now rejects non-image files and files over 10 MB before
-- upload; this mirrors that cap on the report-attachments bucket itself so a
-- raw Storage API call can't bypass it. A plain UPDATE: matches 0 rows and
-- no-ops harmlessly in an environment where the bucket doesn't exist.

update storage.buckets
   set file_size_limit    = 10485760,  -- 10 MB
       allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif']
 where id = 'report-attachments';
