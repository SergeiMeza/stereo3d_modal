# Proposal: "Try with a sample video" on the new-project upload box

Status: PROPOSAL for owner review. Nothing is built.

## Why it isn't a small change

The obvious version, a button in `UploadDropzone` that fetches a sample
from the CDN and feeds it to the normal upload, does not work:

- The CDN bucket (`spatial_video_studio_showcase`) sends no CORS headers,
  so the browser cannot `fetch()` the file from stereo3d.studio. Adding
  CORS changes bucket settings, which this task was not allowed to do.
- Even with CORS it would download ~30 MB to the visitor and upload it
  back again, then charge them for converting our clip.

## Proposed design

1. Gateway: `POST /v1/projects` accepts `{ "sample": "<slug>" }` instead
   of `gcs_key`. The gateway copies `samples/<slug>.mp4` (a private
   prefix in the app bucket, not the public CDN) to the user's upload
   key server side and creates the project as usual. No transfer through
   the browser.
2. Web: under "Choose video", a line "No video at hand? Try a sample"
   with the five sample posters (`src/lib/samples.ts`). Picking one calls
   the new route and opens the project.
3. Pricing decision for the owner, one of:
   - a. normal prices (the sample is just a convenient source);
   - b. the preview is free for samples, the full render costs as usual;
   - c. the finished 3D files are already made (the landing samples), so
     the sample project opens with its outputs ready at no charge and no
     GPU run: the visitor sees the whole studio flow for free.
   Option c costs nothing per visitor and shows the result instantly; it
   needs the gateway to attach prepared outputs to a project.
4. Analytics: `sample_project_created { clip }`.

Effort: gateway route + copy (small), web picker (small), option c adds
prepared-output attachment in the gateway (medium).
