from __future__ import annotations

from io import BytesIO
import textwrap
import zipfile
from typing import TYPE_CHECKING, Any

from PIL import Image, ImageOps

from src.quality_match.service import QualityMatchSettings, analyse_quality_match
from src.refine_export.alpha_extract import extract_exact_overlay, fit_image_to_size, load_rgb_image

if TYPE_CHECKING:
    from src.core.assets import AssetStore


def _encode_png(image: Image.Image) -> bytes:
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def _mask_to_layer_rgba(mask_bytes: bytes | None, size: tuple[int, int], rgba: tuple[int, int, int, int]) -> Image.Image | None:
    if not mask_bytes:
        return None
    mask = ImageOps.exif_transpose(Image.open(BytesIO(mask_bytes))).convert("L")
    if mask.size != size:
        mask = ImageOps.contain(mask, size, Image.Resampling.BILINEAR)
        fitted = Image.new("L", size, 0)
        fitted.paste(mask, ((size[0] - mask.size[0]) // 2, (size[1] - mask.size[1]) // 2))
        mask = fitted
    layer = Image.new("RGBA", size, rgba)
    layer.putalpha(mask)
    return layer


def _rgba_to_psd_channels(image: Image.Image) -> dict[int, Any]:
    import numpy as np  # type: ignore
    from pytoshop import enums

    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    return {
        0: rgba[:, :, 0],
        1: rgba[:, :, 1],
        2: rgba[:, :, 2],
        enums.ChannelId.transparency: rgba[:, :, 3],
    }


def _rgb_to_psd_channels(image: Image.Image) -> dict[int, Any]:
    import numpy as np  # type: ignore
    from pytoshop import enums

    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    alpha = np.full((rgb.shape[0], rgb.shape[1]), 255, dtype=np.uint8)
    return {
        0: rgb[:, :, 0],
        1: rgb[:, :, 1],
        2: rgb[:, :, 2],
        enums.ChannelId.transparency: alpha,
    }


def build_manual_refine_layers(
    *,
    original_bytes: bytes,
    edited_bytes: bytes,
    original_mask_bytes: bytes | None = None,
) -> tuple[dict[str, Image.Image], dict[str, Any]]:
    original = load_rgb_image(original_bytes)
    overlay = extract_exact_overlay(original_bytes=original_bytes, edited_bytes=edited_bytes)
    edited_reference = overlay.edited_fitted

    quality = analyse_quality_match(
        original_bytes=original_bytes,
        generated_bytes=edited_bytes,
        settings=QualityMatchSettings.from_payload(None),
        original_mask_bytes=original_mask_bytes,
    )

    diff_map = load_rgb_image(quality["artifacts"]["diffHeatmap"])
    edge_map = ImageOps.exif_transpose(Image.open(BytesIO(quality["artifacts"]["binaryChangeMask"]))).convert("L")
    auto_map = ImageOps.exif_transpose(Image.open(BytesIO(quality["artifacts"]["restorationMap"]))).convert("RGBA")

    edge_rgba = Image.new("RGBA", original.size, (245, 205, 63, 0))
    edge_rgba.putalpha(edge_map)
    gen_mask_rgba = _mask_to_layer_rgba(original_mask_bytes, original.size, (0, 214, 255, 255))

    layers: dict[str, Image.Image] = {
        "Original": original,
        "Edited Overlay": overlay.overlay_rgba,
        "Generated Edited Frame": fit_image_to_size(edited_reference, original.size),
        "Auto Map": auto_map,
        "Diff Map": diff_map,
        "Edge Map": edge_rgba,
    }
    if gen_mask_rgba is not None:
        layers["Gen Mask"] = gen_mask_rgba
    meta = {
        "width": original.width,
        "height": original.height,
        "changedPixelPct": overlay.changed_pixel_pct,
        "includedLayers": list(layers.keys()),
    }
    return layers, meta


def build_manual_refine_psd(
    *,
    original_bytes: bytes,
    edited_bytes: bytes,
    original_mask_bytes: bytes | None = None,
) -> tuple[bytes, dict[str, Any]]:
    import numpy as np  # type: ignore
    from pytoshop import image_data, image_resources
    from pytoshop import enums
    from pytoshop.user import nested_layers

    layers_by_name, meta = build_manual_refine_layers(
        original_bytes=original_bytes,
        edited_bytes=edited_bytes,
        original_mask_bytes=original_mask_bytes,
    )
    original = layers_by_name["Original"]

    layers: list[Any] = [
        nested_layers.Image(
            name="Edited Overlay",
            visible=True,
            color_mode=enums.ColorMode.rgb,
            channels=_rgba_to_psd_channels(layers_by_name["Edited Overlay"]),
        ),
        nested_layers.Image(
            name="Generated Edited Frame",
            visible=False,
            color_mode=enums.ColorMode.rgb,
            channels=_rgb_to_psd_channels(layers_by_name["Generated Edited Frame"]),
        ),
        nested_layers.Image(
            name="Original",
            visible=True,
            color_mode=enums.ColorMode.rgb,
            channels=_rgb_to_psd_channels(layers_by_name["Original"]),
        ),
        nested_layers.Group(
            name="Diagnostics",
            visible=False,
            closed=True,
            layers=[
                nested_layers.Image(
                    name="Auto Map",
                    visible=False,
                    color_mode=enums.ColorMode.rgb,
                    channels=_rgba_to_psd_channels(layers_by_name["Auto Map"]),
                ),
                nested_layers.Image(
                    name="Diff Map",
                    visible=False,
                    color_mode=enums.ColorMode.rgb,
                    channels=_rgb_to_psd_channels(layers_by_name["Diff Map"]),
                ),
                nested_layers.Image(
                    name="Edge Map",
                    visible=False,
                    color_mode=enums.ColorMode.rgb,
                    channels=_rgba_to_psd_channels(layers_by_name["Edge Map"]),
                ),
            ],
        ),
    ]
    if "Gen Mask" in layers_by_name:
        diagnostic_group = layers[-1]
        diagnostic_group.layers.append(
            nested_layers.Image(
                name="Gen Mask",
                visible=False,
                color_mode=enums.ColorMode.rgb,
                channels=_rgba_to_psd_channels(layers_by_name["Gen Mask"]),
            )
        )

    psd = nested_layers.nested_layers_to_psd(
        layers,
        color_mode=enums.ColorMode.rgb,
        size=original.size,
        compression=enums.Compression.raw,
    )
    flattened = np.asarray(layers_by_name["Generated Edited Frame"].convert("RGB"), dtype=np.uint8)
    psd.image_data = image_data.ImageData(
        channels=np.stack([flattened[:, :, 0], flattened[:, :, 1], flattened[:, :, 2]], axis=0),
        compression=enums.Compression.raw,
    )
    if psd.image_resources is not None:
        psd.image_resources.blocks.append(
            image_resources.VersionInfo(
                version=1,
                has_real_merged_data=True,
                writer="AI VFX Micro Pipeline",
                reader="Adobe Photoshop",
                file_version=1,
            )
        )
    out = BytesIO()
    psd.write(out)
    return out.getvalue(), meta


def build_manual_refine_png_zip(
    *,
    original_bytes: bytes,
    edited_bytes: bytes,
    original_mask_bytes: bytes | None = None,
) -> tuple[bytes, dict[str, Any]]:
    layers_by_name, meta = build_manual_refine_layers(
        original_bytes=original_bytes,
        edited_bytes=edited_bytes,
        original_mask_bytes=original_mask_bytes,
    )
    out = BytesIO()
    with zipfile.ZipFile(out, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        readme = textwrap.dedent(
            f"""\
            Manual refine layer bundle

            Recommended workflow
            - Open the PNG layers in Photoshop or similar.
            - Keep the document at {meta['width']}x{meta['height']} pixels for the cleanest round-trip.
            - The Edited Overlay layer should reconstruct the generated image exactly over Original.
            - The Generated Edited Frame layer is the full edited frame as a hidden reference.
            - Export a flattened final image when uploading back into Refine Frames.

            Included layers
            - {", ".join(meta["includedLayers"])}
            """
        ).strip()
        zf.writestr("README.txt", readme.encode("utf-8"))
        for index, name in enumerate(meta["includedLayers"], start=1):
            safe_name = name.lower().replace(" ", "_")
            zf.writestr(f"{index:02d}_{safe_name}.png", _encode_png(layers_by_name[name]))
    return out.getvalue(), meta


def create_manual_refine_psd_for_variant(
    *,
    asset_store: AssetStore,
    frame: dict[str, Any],
    variant: dict[str, Any],
) -> tuple[bytes, dict[str, Any]]:
    original_bytes = asset_store.read_bytes(frame["captureKey"])
    edited_bytes = asset_store.read_bytes(variant["outputKey"])
    patch_meta = variant.get("patchMeta") if isinstance(variant.get("patchMeta"), dict) else {}
    original_mask_key = patch_meta.get("maskKey") if isinstance(patch_meta, dict) else None
    original_mask_bytes = asset_store.read_bytes(original_mask_key) if isinstance(original_mask_key, str) and original_mask_key else None
    return build_manual_refine_psd(
        original_bytes=original_bytes,
        edited_bytes=edited_bytes,
        original_mask_bytes=original_mask_bytes,
    )


def create_manual_refine_png_zip_for_variant(
    *,
    asset_store: AssetStore,
    frame: dict[str, Any],
    variant: dict[str, Any],
) -> tuple[bytes, dict[str, Any]]:
    original_bytes = asset_store.read_bytes(frame["captureKey"])
    edited_bytes = asset_store.read_bytes(variant["outputKey"])
    patch_meta = variant.get("patchMeta") if isinstance(variant.get("patchMeta"), dict) else {}
    original_mask_key = patch_meta.get("maskKey") if isinstance(patch_meta, dict) else None
    original_mask_bytes = asset_store.read_bytes(original_mask_key) if isinstance(original_mask_key, str) and original_mask_key else None
    return build_manual_refine_png_zip(
        original_bytes=original_bytes,
        edited_bytes=edited_bytes,
        original_mask_bytes=original_mask_bytes,
    )
