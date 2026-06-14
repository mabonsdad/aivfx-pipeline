# Manual Smoke Checklist

Use this checklist after deploys and before large refactors.

## Preconditions
- Backend/API deployed and reachable.
- Frontend built and serving.
- Test user can sign in with Cognito.
- A short sample source video is available (10-30 seconds recommended).

## Smoke Flow
1. **Login**
   - Sign in and confirm the workflow homepage loads at the root route without console/API auth errors.
   - Confirm the three workflow cards appear: `Previz`, `Character`, and `VFX`.
   - Click the sidebar brand/home logo from an in-task page and confirm it returns to the workflow homepage.
2. **Upload**
   - Create a task and upload a source video.
   - Confirm upload completes and asset appears in task details.
3. **Ingest**
   - Run ingest for the uploaded source.
   - Confirm frame strip/metadata appear and task moves to a usable state.
4. **Edit**
   - Capture/select start frame and submit one full edit.
   - Confirm edited frame variant appears and preview opens.
   - Switch to **Edit Source Video** mode, open **Add / edit reference images**, upload one non-16:9 image, and confirm it appears in **Current Working References**.
   - Reopen the picker and confirm previous uploads plus generated stills/current-task frame captures are listed in the expected tabs.
5. **Generate**
   - Generate one segment video from edited start input.
   - Confirm job completes and generation appears in outputs.
   - Open generation preview and compare once, then switch away and back to the step.
   - Confirm preview playback still opens and output thumbnails do not visibly reload on each tab change.
   - In **Edit Source Video** mode, confirm the prompt shows the reference-order helper line and that changing to a lower-reference model warns instead of clearing the current selection.
6. **Merge**
   - Confirm **Current Working References** has a completed generation selected.
   - Open **Extend generation** and confirm there is no "Previous output" dropdown.
   - Queue one continuation and confirm the page stays in **Post Process** (no forced tab change).
   - Confirm the selected working range does not switch to an internal child segment after queueing.
   - Queue one continuation with `Continue to end of working range` disabled.
   - If the selected generation mode is **first frame + last frame**, toggle `Use source segment last frame as end-frame target` and verify both states can be submitted.
   - Queue one continuation with `Continue to end of working range` enabled and confirm continuation chunks begin queuing automatically.
   - Confirm continuation clips in the Extend grid are ordered newest-first.
   - If an auto-continue run is active, click `Stop auto-continue` and confirm the run stops accepting new chunks.
   - Select generated output, open **Align & Retime**, run **Suggest alignment**, then **Apply suggested**.
   - Confirm controls are not auto-filled before clicking **Apply suggested**.
   - Run reconcile timing or merge/export.
   - Confirm merged export appears and is playable/downloadable.
7. **Report**
   - Create one QC report from an output asset.
   - Confirm report job completes and report artifacts render in Reports.
8. **Off-flow navigation**
   - Open Asset Library and Admin pages.
   - Confirm the sidebar brand/home logo still appears and always returns to the workflow homepage.

## Expected Result
- End-to-end flow completes without blocking errors.
- New jobs transition `queued -> running -> complete`.
- Resulting assets have preview/download URLs.
