# Draft: file retention in Terms and Privacy (S3D-24)

Status: DRAFT for owner review. Not published. `src/app/terms/page.tsx`
and `src/app/privacy/page.tsx` are unchanged until the owner approves.

What the app already does (web, branch `feat/lifelike-web`):

- Project cards show "Files deleted on <date> · Keep" when the gateway's
  `files_delete_at` is within 14 days. Keep calls
  `POST /v1/projects/{id}/keep`.
- Delete project asks: "Deleting this project deletes its files. You won't
  be able to download them again."

Settled (coordinator, 2026-11-03):

1. "Use" means opening the project, starting a run or downloading. The
   gateway's clock must count the same three things.
2. The original upload is deleted with the project's other files.
3. Billing records (invoices, charges) are kept as the law requires.

---

## Terms of Service

### 4. Your content (new paragraph, after the first)

> **Files you don't use are deleted.** If a project goes 90 days without
> use (opening it, starting a run in it or downloading from it), we delete
> its files: the video you uploaded and every 3D file made from it. We email you 14 days and 3 days before
> that happens, and the project shows the date. Choose Keep, or use the
> project, and the 90 days start again. Download anything you want to
> keep for good: we are not a storage service.

### 4. Your content (new paragraph, after the one above)

> **Deleting a project deletes its files.** When you delete a project, you
> can no longer download its files, including the video you uploaded. We
> erase them from our systems within 30 days. Invoices and records of
> charges are kept as the law requires (see the Privacy Policy).

### 13. Termination (append)

> When your account is deleted, your projects and their files are deleted
> as described in section 4.

---

## Privacy Policy

### 5. Retention and deletion (replaces the first two sentences)

> Uploads and the 3D files made from them are kept while the project that
> owns them is in use. If a project goes 90 days without use (opening it,
> starting a run in it or downloading from it), its files, including the
> video you uploaded, are deleted; we email you 14 days and 3 days before,
> and you can keep them with one click. When you delete a project, or ask
> us to delete your account, its files are erased from our systems within
> 30 days, including backups. Billing records (invoices and charges) are
> kept as long as tax and accounting law requires, and are not deleted
> with your projects.

### Notices (new sentence in the section on how we contact you, or in 5)

> We use your email address to tell you before your files are deleted.
> These messages are part of the Service and are sent even if you have
> opted out of marketing email.
