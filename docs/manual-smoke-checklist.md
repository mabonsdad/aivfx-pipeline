# Manual Smoke Checklist

Use this checklist after deploys and before large refactors.

## Preconditions
- Backend/API deployed and reachable.
- Frontend built and serving.
- Test user can sign in with Cognito.
- A short sample source video is available (10-30 seconds recommended).

## Smoke Flow
1. **Login**
   - Sign in and confirm task list and navigation load without console/API auth errors.
2. **Upload**
   - Create a task and upload a source video.
   - Confirm upload completes and asset appears in task details.
3. **Ingest**
   - Run ingest for the uploaded source.
   - Confirm frame strip/metadata appear and task moves to a usable state.
4. **Edit**
   - Capture/select start frame and submit one full edit.
   - Confirm edited frame variant appears and preview opens.
5. **Generate**
   - Generate one segment video from edited start input.
   - Confirm job completes and generation appears in outputs.
6. **Merge**
   - Select generated output, open **Align & Retime**, run **Suggest alignment**, then **Apply suggested**.
   - Confirm controls are not auto-filled before clicking **Apply suggested**.
   - Run reconcile timing or merge/export.
   - Confirm merged export appears and is playable/downloadable.
7. **Report**
   - Create one QC report from an output asset.
   - Confirm report job completes and report artifacts render in Reports.

## Expected Result
- End-to-end flow completes without blocking errors.
- New jobs transition `queued -> running -> complete`.
- Resulting assets have preview/download URLs.
