# Draft: file retention in Terms and Privacy (S3D-24)

Status: DRAFT for owner review. Not published. `src/app/terms/page.tsx`
and `src/app/privacy/page.tsx` are unchanged until the owner approves.

What the app already does (web, branch `feat/lifelike-web`):

- Project cards show "Files deleted on <date> · Keep" when the gateway's
  `files_delete_at` is within 14 days. Keep calls
  `POST /v1/projects/{id}/keep`.
- Delete project asks: "Deleting this project deletes its files. You won't
  be able to download them again."

Open points for the owner:

1. What counts as "use": the draft says opening the project, downloading,
   or making 3D. The gateway decides; the text must match it.
2. Whether the original upload is deleted with the 3D files, or kept so
   the project can be made again. The draft says both go.
3. Billing records stay (tax law), as today.

---

## Terms of Service

### 4. Your content (new paragraph, after the first)

> **Files you don't use are deleted.** If a project goes 90 days without
> use (opening it, downloading from it or making 3D in it), we delete its
> uploaded video and 3D files. We email you 14 days and 3 days before
> that happens, and the project shows the date. Choose Keep, or use the
> project, and the 90 days start again. Download anything you want to
> keep for good: we are not a storage service.

### 4. Your content (new paragraph, after the one above)

> **Deleting a project deletes its files.** When you delete a project, you
> can no longer download its files. We erase them from our systems within
> 30 days.

### 13. Termination (append)

> When your account is deleted, your projects and their files are deleted
> as described in section 4.

---

## Privacy Policy

### 5. Retention and deletion (replaces the first two sentences)

> Uploads and the 3D files made from them are kept while the project that
> owns them is in use. If a project goes 90 days without use (opening it,
> downloading from it or making 3D in it), its files are deleted; we email
> you 14 days and 3 days before, and you can keep them with one click.
> When you delete a project, or ask us to delete your account, its files
> are erased from our systems within 30 days, including backups. Billing
> records are retained as long as tax and accounting law requires.

### Notices (new sentence in the section on how we contact you, or in 5)

> We use your email address to tell you before your files are deleted.
> These messages are part of the Service and are sent even if you have
> opted out of marketing email.
