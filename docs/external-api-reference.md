# External API Reference

This app exposes browser-tested external API routes behind Cognito auth:

- `POST /api/v1/assets/uploads/init`
- `POST /api/v1/image-edits/full`
- `POST /api/v1/image-edits/patch`
- `POST /api/v1/video-generations/reference-video`
- `GET /api/v1/requests`
- `GET /api/v1/requests/{requestId}`

## Upload flow

1. Call `POST /api/v1/assets/uploads/init` with the file metadata.
2. `PUT` the bytes to the returned `uploadUrl`.
3. Use the returned `assetKey` in the later workflow request body.

Example:

```json
{
  "filename": "style-board.png",
  "contentType": "image/png",
  "assetType": "image"
}
```

## Ordered reference images

Some routes accept `referenceAssetKeys`.

Rules:

- `referenceAssetKeys` preserves order exactly as supplied.
- Upload each reference image separately and then build the final `referenceAssetKeys` array in the exact order you want the model to receive them.
- If your prompt refers to the first, second, or third reference image, that means:
  - `referenceAssetKeys[0]`
  - `referenceAssetKeys[1]`
  - `referenceAssetKeys[2]`
- Keep prompt wording explicit when order matters.

Example upload sequence:

1. Upload `character.png` and keep its returned `assetKey`.
2. Upload `wardrobe.png` and keep its returned `assetKey`.
3. Upload `background.png` and keep its returned `assetKey`.
4. Submit:

```json
{
  "referenceAssetKeys": [
    "users/me/uploads/apiasset_character.png",
    "users/me/uploads/apiasset_wardrobe.png",
    "users/me/uploads/apiasset_background.png"
  ]
}
```

That means:

- `referenceAssetKeys[0]` is the character reference
- `referenceAssetKeys[1]` is the wardrobe reference
- `referenceAssetKeys[2]` is the background reference

## Full image edit

Endpoint:

- `POST /api/v1/image-edits/full`

Body:

```json
{
  "model": "chatgpt_latest",
  "prompt": "Edit the input image. Use the first additional reference for styling and the second for wardrobe.",
  "inputAssetKey": "users/me/uploads/apiasset_input.png",
  "referenceAssetKeys": [
    "users/me/uploads/apiasset_style.png",
    "users/me/uploads/apiasset_wardrobe.png"
  ]
}
```

Notes:

- `inputAssetKey` is always the base image being edited.
- `referenceAssetKeys` are additional ordered reference images.
- The backend preserves duplicates and exact order. If you intentionally send the same `assetKey` twice, both positions are kept.
- Supported with ordered references in this route:
  - `nano_banana` up to 3
  - `nano_banana_pro` up to 9
  - `chatgpt` up to 9
  - `chatgpt_latest` up to 9
- `luma_uni_1`, `luma_uni_1_max`, and `luma_uni_1_1` do not use `referenceAssetKeys` in this route.

## Patch image edit

Endpoint:

- `POST /api/v1/image-edits/patch`

Body:

```json
{
  "model": "chatgpt_latest",
  "prompt": "Replace the masked region. Use the first additional reference for texture and the second for colour treatment.",
  "inputAssetKey": "users/me/uploads/apiasset_full.png",
  "patchAssetKey": "users/me/uploads/apiasset_patch.png",
  "maskAssetKey": "users/me/uploads/apiasset_mask.png",
  "referenceAssetKeys": [
    "users/me/uploads/apiasset_texture.png",
    "users/me/uploads/apiasset_palette.png"
  ],
  "patchRect": {
    "x": 0,
    "y": 0,
    "width": 1024,
    "height": 1024
  },
  "featherPx": 0,
  "bleedPx": 0,
  "edgeAwareRefine": true,
  "edgeAwareStrength": 0.45,
  "edgeAwareRadiusPx": 6,
  "maskGrowPx": 0
}
```

Notes:

- `patchAssetKey` is the editable patch image.
- `referenceAssetKeys` are additional ordered reference images.
- If both `referenceAssetKey` and `referenceAssetKeys` are sent, the plural `referenceAssetKeys` field is used.
- Supported with ordered references in this route:
  - `nano_banana_pro` up to 9
  - `chatgpt` up to 9
  - `chatgpt_latest` up to 9
- `runware_ace_pp` accepts one reference image only.
- `runware_flux_fill` does not use `referenceAssetKeys` in this route.
- Backward compatibility: the older singular `referenceAssetKey` still works, but new clients should use `referenceAssetKeys`.

## Reference video generation

Endpoint:

- `POST /api/v1/video-generations/reference-video`

Base body:

```json
{
  "model": "seedance-2.0-reference-to-video",
  "mode": "seedance_reference_to_video",
  "prompt": "Use @Video1 as the motion source. Use @Image1 for the hero character look, @Image2 for the costume palette, and @Image3 for the background styling.",
  "videoAssetKey": "users/me/uploads/apiasset_source.mp4",
  "firstFrameAssetKey": "users/me/uploads/apiasset_first-frame.png",
  "referenceAssetKeys": [
    "users/me/uploads/apiasset_character.png",
    "users/me/uploads/apiasset_costume.png",
    "users/me/uploads/apiasset_background.png"
  ]
}
```

Notes:

- `videoAssetKey` stays the motion/source-video input when the selected model uses source video.
- `firstFrameAssetKey` remains the edited first frame image.
- `referenceAssetKeys` is the ordered additional image-reference array.

Prompt token mapping by model:

- `seedance-2.0-reference-to-video`
  - `@Video1` -> `videoAssetKey`
  - `@Image1..@Image3` -> `referenceAssetKeys[0..2]`
- `happy-horse-video-edit`
  - `@Image1..@Image3` -> `referenceAssetKeys[0..2]`
- `kling-o1`
  - `<<<video_1>>>` -> `videoAssetKey`
  - `<<<image_1>>>..<<<image_3>>>` -> `referenceAssetKeys[0..2]`
- `kling-v3-omni-video`
  - `<<<video_1>>>` -> `videoAssetKey`
  - `<<<image_1>>>..<<<image_3>>>` -> `referenceAssetKeys[0..2]`

Fallback behavior:

- For the models above, if `referenceAssetKeys` is omitted, the route falls back to using `firstFrameAssetKey` as the provider-side image reference.

Current ordered-reference support in this route:

- `happy-horse-video-edit` up to 3
- `kling-o1` up to 3
- `kling-v3-omni-video` up to 3
- `seedance-2.0-reference-to-video` up to 3

Models that do not use `referenceAssetKeys` in this route:

- `ray-2`
- `ray-flash-2`
- `runway-gen4.5`
- `runway-gen4-aleph`
- `sora-2-image-to-video`
- `happy-horse-image-to-video`
- `kling-2.6`
- `veo-3.1`
- `veo-3.1-fast`
- `wan2.2-a14b`
- `wan2.2-animate`
- `wan2.7-videoedit`
- `wan2.7-i2v`
- `ltx-2.3-pro`

## Inspecting results

- `GET /api/v1/requests`
- `GET /api/v1/requests/{requestId}`

The returned request record includes:

- request metadata
- provider/job status
- input assets
- prepared assets
- output assets
- logs and error messages
