from __future__ import annotations

import json
import os
import subprocess
import math
import shutil
from fractions import Fraction
from pathlib import Path
from typing import Any


def _resolve_binary(env_name: str, fallback_name: str) -> str:
    env_value = os.getenv(env_name)
    if env_value:
        return env_value
    for candidate in (
        f"/opt/bin/{fallback_name}",
        f"/opt/{fallback_name}",
        f"/usr/bin/{fallback_name}",
    ):
        if os.path.exists(candidate):
            return candidate
    return shutil.which(fallback_name) or fallback_name


FFMPEG_BIN = _resolve_binary("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = _resolve_binary("FFPROBE_BIN", "ffprobe")


class FFmpegError(RuntimeError):
    pass


def _target_for_orientation(source_width: int, source_height: int, *, landscape: tuple[int, int], portrait: tuple[int, int]) -> tuple[int, int]:
    source_ratio = (source_width / source_height) if source_height else 1.0
    landscape_ratio = landscape[0] / landscape[1]
    portrait_ratio = portrait[0] / portrait[1]
    # Pick whichever target AR is closest to the source AR, then pad to fit.
    landscape_delta = abs(math.log(source_ratio / landscape_ratio))
    portrait_delta = abs(math.log(source_ratio / portrait_ratio))
    return landscape if landscape_delta <= portrait_delta else portrait


def _scale_pad_filter(target_width: int, target_height: int) -> str:
    return (
        f"scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,"
        f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:color=black"
    )


def _run(command: list[str]) -> None:
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(f"Command failed: {' '.join(command)}\n{proc.stderr}")


def ffprobe_video(input_path: str) -> dict[str, Any]:
    cmd = [
        FFPROBE_BIN,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        input_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(proc.stderr)
    payload = json.loads(proc.stdout)
    video_stream = next((s for s in payload.get("streams", []) if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in payload.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not video_stream:
        raise FFmpegError("No video stream found")

    fps = Fraction(video_stream.get("avg_frame_rate", "0/1"))
    r_fps = Fraction(video_stream.get("r_frame_rate", "0/1"))
    is_vfr = fps != r_fps
    nb_frames = video_stream.get("nb_frames")
    duration = float(video_stream.get("duration") or payload.get("format", {}).get("duration") or 0)

    return {
        "width": int(video_stream["width"]),
        "height": int(video_stream["height"]),
        "fps_num": fps.numerator,
        "fps_den": fps.denominator,
        "r_fps_num": r_fps.numerator,
        "r_fps_den": r_fps.denominator,
        "duration_sec": duration,
        "frame_count": int(nb_frames) if nb_frames else int(duration * float(fps or Fraction(30, 1))),
        "is_vfr_input": is_vfr,
        "codec": video_stream.get("codec_name"),
        "has_audio": audio_stream is not None,
    }


def _format_seconds(value: float) -> str:
    return f"{max(0.0, float(value)):.6f}"


def _atempo_chain(ratio: float) -> str:
    clamped = max(0.05, min(20.0, float(ratio)))
    factors: list[float] = []
    while clamped < 0.5:
        factors.append(0.5)
        clamped /= 0.5
    while clamped > 2.0:
        factors.append(2.0)
        clamped /= 2.0
    factors.append(clamped)
    filtered = [f for f in factors if abs(f - 1.0) > 1e-6]
    if not filtered:
        return "anull"
    return ",".join(f"atempo={f:.6f}" for f in filtered)


def transcode_to_cfr(
    input_path: str,
    output_path: str,
    fps: Fraction,
    *,
    target_width: int | None = None,
    target_height: int | None = None,
    crf: int = 16,
    preset: str = "medium",
    audio_bitrate: str = "192k",
) -> None:
    fps_num = fps.numerator if fps.numerator > 0 else 30
    fps_den = fps.denominator if fps.denominator > 0 else 1
    vf_parts = [f"fps={fps_num}/{fps_den}"]
    if target_width and target_height:
        vf_parts.append(_scale_pad_filter(target_width, target_height))
    vf_parts.append("setsar=1")

    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        input_path,
        "-vf",
        ",".join(vf_parts),
        "-vsync",
        "cfr",
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        audio_bitrate,
        output_path,
    ]
    _run(cmd)


def transcode_preserving_frame_count(
    input_path: str,
    output_path: str,
    *,
    source_fps: Fraction,
    target_fps: Fraction,
    target_width: int | None = None,
    target_height: int | None = None,
    crf: int = 16,
    preset: str = "medium",
    audio_bitrate: str = "192k",
) -> None:
    src_num = source_fps.numerator if source_fps.numerator > 0 else 30
    src_den = source_fps.denominator if source_fps.denominator > 0 else 1
    dst_num = target_fps.numerator if target_fps.numerator > 0 else 30
    dst_den = target_fps.denominator if target_fps.denominator > 0 else 1
    if src_num == dst_num and src_den == dst_den:
        transcode_to_cfr(
            input_path,
            output_path,
            target_fps,
            target_width=target_width,
            target_height=target_height,
            crf=crf,
            preset=preset,
            audio_bitrate=audio_bitrate,
        )
        return

    duration_scale = float(source_fps / target_fps)
    vf_parts = [f"setpts={duration_scale:.12f}*PTS"]
    if target_width and target_height:
        vf_parts.append(_scale_pad_filter(target_width, target_height))
    vf_parts.append("setsar=1")
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        input_path,
        "-vf",
        ",".join(vf_parts),
        "-r",
        f"{dst_num}/{dst_den}",
        "-fps_mode",
        "cfr",
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
    ]
    try:
        probe = ffprobe_video(input_path)
    except FFmpegError:
        probe = {}
    if bool(probe.get("has_audio")):
        cmd.extend(["-filter:a", _atempo_chain(float(target_fps) / float(source_fps)), "-c:a", "aac", "-b:a", audio_bitrate])
    else:
        cmd.append("-an")
    cmd.append(output_path)
    _run(cmd)


def trim_and_retime_video_uniform(
    input_path: str,
    output_path: str,
    *,
    fps: Fraction,
    playback_rate: float,
    trim_start_frames: int = 0,
    trim_end_frames: int = 0,
    target_width: int | None = None,
    target_height: int | None = None,
    crf: int = 16,
    preset: str = "medium",
    audio_bitrate: str = "192k",
) -> list[str]:
    probe = ffprobe_video(input_path)
    fps_num = fps.numerator if fps.numerator > 0 else 30
    fps_den = fps.denominator if fps.denominator > 0 else 1
    fps_str = f"{fps_num}/{fps_den}"
    one_frame_sec = float(Fraction(1, max(1, fps_num)))
    input_duration_sec = max(one_frame_sec, float(probe.get("duration_sec") or one_frame_sec))
    trim_start_sec = max(0.0, float(Fraction(max(0, trim_start_frames), 1) / fps))
    trim_end_sec = max(0.0, float(Fraction(max(0, trim_end_frames), 1) / fps))
    max_trim_sec = max(0.0, input_duration_sec - one_frame_sec)
    trim_start_sec = min(trim_start_sec, max_trim_sec)
    trim_end_sec = min(trim_end_sec, max(0.0, max_trim_sec - trim_start_sec))
    input_start_sec = trim_start_sec
    input_end_sec = max(input_start_sec + one_frame_sec, input_duration_sec - trim_end_sec)
    effective_playback_rate = max(0.05, min(20.0, float(playback_rate or 1.0)))
    video_setpts_scale = 1.0 / effective_playback_rate

    vf_parts = [
        f"trim={_format_seconds(input_start_sec)}:{_format_seconds(input_end_sec)}",
        f"setpts={video_setpts_scale:.12f}*PTS",
        f"fps={fps_str}",
    ]
    if target_width and target_height:
        vf_parts.append(f"scale={target_width}:{target_height}:flags=lanczos")
    vf_parts.extend(["setsar=1", "format=yuv420p"])

    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        input_path,
        "-vf",
        ",".join(vf_parts),
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
    ]
    if bool(probe.get("has_audio")):
        cmd.extend(["-filter:a", _atempo_chain(effective_playback_rate), "-c:a", "aac", "-b:a", audio_bitrate])
    else:
        cmd.append("-an")
    cmd.append(output_path)
    _run(cmd)
    return cmd


def extract_frame_png(
    input_path: str,
    frame_index: int,
    output_path: str,
    *,
    crop_x: int | None = None,
    crop_y: int | None = None,
    crop_width: int | None = None,
    crop_height: int | None = None,
    output_width: int | None = None,
    output_height: int | None = None,
) -> None:
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    vf_parts = [f"select=eq(n\\,{frame_index})"]
    if (
        crop_x is not None
        and crop_y is not None
        and crop_width is not None
        and crop_height is not None
        and crop_width > 0
        and crop_height > 0
    ):
        vf_parts.append(f"crop={crop_width}:{crop_height}:{crop_x}:{crop_y}")
    if output_width and output_height:
        vf_parts.append(f"scale={output_width}:{output_height}:flags=lanczos")
    vf_parts.append("setsar=1")
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        input_path,
        "-vf",
        ",".join(vf_parts),
        "-vframes",
        "1",
        output_path,
    ]
    _run(cmd)


def extract_segment_by_frames(
    input_path: str,
    output_path: str,
    *,
    start_frame: int,
    end_frame_exclusive: int,
    fps_num: int,
    fps_den: int,
    target_width: int | None = None,
    target_height: int | None = None,
    crop_x: int | None = None,
    crop_y: int | None = None,
    crop_width: int | None = None,
    crop_height: int | None = None,
    crf: int = 16,
    preset: str = "slow",
    audio_bitrate: str = "192k",
) -> None:
    fps = Fraction(fps_num, fps_den)
    start_sec = Fraction(start_frame, 1) / fps
    duration_sec = Fraction(max(0, end_frame_exclusive - start_frame), 1) / fps
    vf_parts: list[str] = []
    if (
        crop_x is not None
        and crop_y is not None
        and crop_width is not None
        and crop_height is not None
        and crop_width > 0
        and crop_height > 0
    ):
        vf_parts.append(f"crop={crop_width}:{crop_height}:{crop_x}:{crop_y}")
    if target_width and target_height:
        vf_parts.append(f"scale={target_width}:{target_height}:flags=lanczos")
    vf_parts.append("setsar=1")
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-ss",
        f"{float(start_sec):.6f}",
        "-i",
        input_path,
        "-t",
        f"{float(duration_sec):.6f}",
        "-vf",
        ",".join(vf_parts),
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        audio_bitrate,
        output_path,
    ]
    _run(cmd)


def compose_cropped_generated_segment(
    edit_source_path: str,
    generated_segment_path: str,
    output_path: str,
    *,
    start_frame: int,
    fps_num: int,
    fps_den: int,
    output_width: int,
    output_height: int,
    crop_x: int,
    crop_y: int,
    crop_width: int,
    crop_height: int,
    crop_feather_px: int = 0,
    generated_trim_start_frames: int = 0,
    generated_trim_end_frames: int = 0,
) -> list[str]:
    fps = Fraction(fps_num, fps_den)
    fps_str = f"{fps_num}/{fps_den}"
    one_frame_sec = float(Fraction(1, max(1, fps_num)))
    generated_probe = ffprobe_video(generated_segment_path)
    generated_duration_sec = max(one_frame_sec, float(generated_probe.get("duration_sec") or one_frame_sec))
    trim_start_sec = max(0.0, float(Fraction(max(0, generated_trim_start_frames), 1) / fps))
    trim_end_sec = max(0.0, float(Fraction(max(0, generated_trim_end_frames), 1) / fps))
    max_trim_sec = max(0.0, generated_duration_sec - one_frame_sec)
    trim_start_sec = min(trim_start_sec, max_trim_sec)
    trim_end_sec = min(trim_end_sec, max(0.0, max_trim_sec - trim_start_sec))
    generated_input_start_sec = trim_start_sec
    generated_input_end_sec = max(generated_input_start_sec + one_frame_sec, generated_duration_sec - trim_end_sec)
    generated_effective_duration_sec = max(one_frame_sec, generated_input_end_sec - generated_input_start_sec)
    start_sec = float(Fraction(max(0, start_frame), 1) / fps)
    end_sec = start_sec + generated_effective_duration_sec

    norm_original = f"fps={fps_str},scale={output_width}:{output_height}:flags=lanczos,setsar=1,format=yuv420p"
    norm_generated = f"fps={fps_str},scale={crop_width}:{crop_height}:flags=lanczos,setsar=1,format=yuv420p"
    filter_complex: list[str] = [
        f"[0:v]trim={_format_seconds(start_sec)}:{_format_seconds(end_sec)},{norm_original},setpts=PTS-STARTPTS[vorig]",
        (
            f"[1:v]trim={_format_seconds(generated_input_start_sec)}:{_format_seconds(generated_input_end_sec)},"
            f"{norm_generated},setpts=PTS-STARTPTS[vgen]"
        ),
    ]

    feather_px = max(0, min(int(crop_feather_px), min(crop_width // 2, crop_height // 2, 128)))
    if feather_px > 0:
        inner_w = max(1, crop_width - (feather_px * 2))
        inner_h = max(1, crop_height - (feather_px * 2))
        filter_complex.extend(
            [
                (
                    f"color=black:s={crop_width}x{crop_height}:r={fps_str}:d={_format_seconds(generated_effective_duration_sec)},"
                    f"format=gray,drawbox=x={feather_px}:y={feather_px}:w={inner_w}:h={inner_h}:color=white:t=fill,"
                    f"boxblur={feather_px}:1[vcropmask]"
                ),
                "[vgen]format=rgba[vgen_rgba]",
                "[vgen_rgba][vcropmask]alphamerge[vgen_alpha]",
                f"[vorig][vgen_alpha]overlay={crop_x}:{crop_y}:format=auto:shortest=1[vout]",
            ]
        )
    else:
        filter_complex.append(f"[vorig][vgen]overlay={crop_x}:{crop_y}:format=auto:shortest=1[vout]")

    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        edit_source_path,
        "-i",
        generated_segment_path,
        "-filter_complex",
        ";".join(filter_complex),
        "-map",
        "[vout]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "16",
        "-preset",
        "slow",
        output_path,
    ]
    _run(cmd)
    return cmd


def transcode_for_preview(
    input_path: str,
    output_path: str,
    *,
    fps: Fraction,
    source_width: int,
    source_height: int,
) -> tuple[int, int]:
    target_w, target_h = _target_for_orientation(
        source_width,
        source_height,
        landscape=(960, 540),
        portrait=(540, 960),
    )
    transcode_to_cfr(
        input_path,
        output_path,
        fps,
        target_width=target_w,
        target_height=target_h,
        crf=30,
        preset="veryfast",
        audio_bitrate="96k",
    )
    return target_w, target_h


def transcode_for_provider(
    input_path: str,
    output_path: str,
    *,
    fps: Fraction,
    source_width: int,
    source_height: int,
    landscape_target: tuple[int, int],
    portrait_target: tuple[int, int],
    crf: int = 22,
) -> tuple[int, int]:
    target_w, target_h = _target_for_orientation(
        source_width,
        source_height,
        landscape=landscape_target,
        portrait=portrait_target,
    )
    transcode_to_cfr(
        input_path,
        output_path,
        fps,
        target_width=target_w,
        target_height=target_h,
        crf=crf,
        preset="medium",
        audio_bitrate="128k",
    )
    return target_w, target_h


def generate_thumbnail_strip(input_path: str, output_dir: str, fps: int = 1, width: int = 320) -> list[dict[str, Any]]:
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    pattern = str(Path(output_dir) / "thumb_%06d.jpg")
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        input_path,
        "-vf",
        f"fps={fps},scale={width}:-1",
        "-q:v",
        "2",
        pattern,
    ]
    _run(cmd)

    files = sorted(Path(output_dir).glob("thumb_*.jpg"))
    frames: list[dict[str, Any]] = []
    for idx, file in enumerate(files):
        frames.append({"index": idx, "filename": file.name, "timeSec": idx / fps})
    return frames


def merge_with_segment_replacement(
    edit_source_path: str,
    segment_path: str,
    output_path: str,
    *,
    start_frame: int,
    end_frame_exclusive: int,
    fps_num: int,
    fps_den: int,
    output_width: int,
    output_height: int,
    temporal_feather_frames: int,
    insert_start_frame: int | None = None,
    generated_trim_start_frames: int = 0,
    generated_trim_end_frames: int = 0,
) -> list[str]:
    epsilon = 1e-4
    fps = Fraction(fps_num, fps_den)
    default_start_sec = float(Fraction(start_frame, 1) / fps)
    default_end_sec = float(Fraction(end_frame_exclusive, 1) / fps)
    fps_str = f"{fps_num}/{fps_den}"
    orig_probe = ffprobe_video(edit_source_path)
    generated_probe = ffprobe_video(segment_path)
    original_duration_sec = max(default_end_sec, float(orig_probe.get("duration_sec") or 0.0))
    one_frame_sec = float(Fraction(1, max(1, fps_num)))
    generated_duration_sec = max(one_frame_sec, float(generated_probe.get("duration_sec") or (default_end_sec - default_start_sec)))
    trim_start_sec = max(0.0, float(Fraction(max(0, generated_trim_start_frames), 1) / fps))
    trim_end_sec = max(0.0, float(Fraction(max(0, generated_trim_end_frames), 1) / fps))
    max_trim_sec = max(0.0, generated_duration_sec - one_frame_sec)
    trim_start_sec = min(trim_start_sec, max_trim_sec)
    trim_end_sec = min(trim_end_sec, max(0.0, max_trim_sec - trim_start_sec))
    generated_input_start_sec = trim_start_sec
    generated_input_end_sec = max(generated_input_start_sec + one_frame_sec, generated_duration_sec - trim_end_sec)
    generated_effective_duration_sec = max(one_frame_sec, generated_input_end_sec - generated_input_start_sec)

    start_frame_resolved = start_frame if insert_start_frame is None else insert_start_frame
    start_frame_resolved = max(0, start_frame_resolved)
    start_sec = float(Fraction(start_frame_resolved, 1) / fps)
    start_sec = min(start_sec, original_duration_sec)
    end_sec = start_sec + generated_effective_duration_sec

    norm_original = f"fps={fps_str},scale={output_width}:{output_height}:flags=lanczos,setsar=1,format=yuv420p"
    norm_generated = f"fps={fps_str},scale={output_width}:{output_height}:flags=lanczos,setsar=1,format=yuv420p"
    filter_complex: list[str] = []
    video_parts: list[str] = []

    if temporal_feather_frames > 0:
        feather_sec = float(Fraction(temporal_feather_frames, 1) / fps)
        blend_in_sec = min(feather_sec, generated_effective_duration_sec)
        blend_out_sec = min(feather_sec, generated_effective_duration_sec, max(0.0, original_duration_sec - end_sec))

        if start_sec > epsilon:
            filter_complex.append(
                f"[0:v]trim=0:{_format_seconds(start_sec)},{norm_original},setpts=PTS-STARTPTS[vpre]"
            )
            video_parts.append("vpre")

        if blend_in_sec > epsilon:
            filter_complex.append(
                f"[0:v]trim={_format_seconds(start_sec)}:{_format_seconds(start_sec + blend_in_sec)},{norm_original},setpts=PTS-STARTPTS[vorig_in]"
            )
            filter_complex.append(
                f"[1:v]trim={_format_seconds(generated_input_start_sec)}:{_format_seconds(generated_input_start_sec + blend_in_sec)},{norm_generated},setpts=PTS-STARTPTS[vgen_in]"
            )
            filter_complex.append(
                "[vorig_in][vgen_in]blend=all_expr='if(lte(T,{d}),A*(1-T/{d})+B*(T/{d}),B)'[vblend_in]".format(
                    d=_format_seconds(blend_in_sec)
                )
            )
            video_parts.append("vblend_in")

        middle_start_sec = generated_input_start_sec + blend_in_sec
        middle_end_sec = max(middle_start_sec, generated_input_end_sec - blend_out_sec)
        if middle_end_sec - middle_start_sec > epsilon:
            filter_complex.append(
                f"[1:v]trim={_format_seconds(middle_start_sec)}:{_format_seconds(middle_end_sec)},{norm_generated},setpts=PTS-STARTPTS[vgen_mid]"
            )
            video_parts.append("vgen_mid")

        if blend_out_sec > epsilon:
            filter_complex.append(
                f"[1:v]trim={_format_seconds(generated_input_end_sec - blend_out_sec)}:{_format_seconds(generated_input_end_sec)},{norm_generated},setpts=PTS-STARTPTS[vgen_out]"
            )
            filter_complex.append(
                f"[0:v]trim={_format_seconds(end_sec)}:{_format_seconds(end_sec + blend_out_sec)},{norm_original},setpts=PTS-STARTPTS[vpost_in]"
            )
            filter_complex.append(
                "[vgen_out][vpost_in]blend=all_expr='if(lte(T,{d}),A*(1-T/{d})+B*(T/{d}),B)'[vblend_out]".format(
                    d=_format_seconds(blend_out_sec)
                )
            )
            video_parts.append("vblend_out")

        post_tail_start_sec = end_sec + blend_out_sec
    else:
        if start_sec > epsilon:
            filter_complex.append(
                f"[0:v]trim=0:{_format_seconds(start_sec)},{norm_original},setpts=PTS-STARTPTS[vpre]"
            )
            video_parts.append("vpre")
        filter_complex.append(
            f"[1:v]trim={_format_seconds(generated_input_start_sec)}:{_format_seconds(generated_input_end_sec)},{norm_generated},setpts=PTS-STARTPTS[vgen]"
        )
        video_parts.append("vgen")
        post_tail_start_sec = end_sec

    if original_duration_sec - post_tail_start_sec > epsilon:
        filter_complex.append(
            f"[0:v]trim={_format_seconds(post_tail_start_sec)},{norm_original},setpts=PTS-STARTPTS[vpost]"
        )
        video_parts.append("vpost")

    if not video_parts:
        filter_complex.append(
            f"[1:v]trim=0:{_format_seconds(generated_duration_sec)},{norm_generated},setpts=PTS-STARTPTS[vout]"
        )
    elif len(video_parts) == 1:
        filter_complex.append(f"[{video_parts[0]}]setpts=PTS-STARTPTS[vout]")
    else:
        filter_complex.append("".join(f"[{label}]" for label in video_parts) + f"concat=n={len(video_parts)}:v=1:a=0[vout]")

    has_audio = bool(orig_probe.get("has_audio"))
    if has_audio:
        audio_parts: list[str] = []
        if start_sec > epsilon:
            filter_complex.append(f"[0:a]atrim=0:{_format_seconds(start_sec)},asetpts=PTS-STARTPTS[apre]")
            audio_parts.append("apre")

        segment_audio_end_sec = min(end_sec, original_duration_sec)
        if segment_audio_end_sec - start_sec > epsilon:
            filter_complex.append(
                f"[0:a]atrim={_format_seconds(start_sec)}:{_format_seconds(segment_audio_end_sec)},asetpts=PTS-STARTPTS[aseg]"
            )
            source_audio_duration_sec = segment_audio_end_sec - start_sec
            if generated_effective_duration_sec > epsilon and source_audio_duration_sec > epsilon:
                tempo_ratio = source_audio_duration_sec / generated_effective_duration_sec
                filter_complex.append(f"[aseg]{_atempo_chain(tempo_ratio)}[aseg_adj]")
            else:
                filter_complex.append("[aseg]anull[aseg_adj]")
            audio_parts.append("aseg_adj")
        else:
            filter_complex.append(
                f"anullsrc=r=48000:cl=stereo,atrim=0:{_format_seconds(generated_effective_duration_sec)}[aseg_adj]"
            )
            audio_parts.append("aseg_adj")

        if original_duration_sec - end_sec > epsilon:
            filter_complex.append(f"[0:a]atrim={_format_seconds(end_sec)},asetpts=PTS-STARTPTS[apost]")
            audio_parts.append("apost")

        if len(audio_parts) == 1:
            filter_complex.append(f"[{audio_parts[0]}]anull[aout]")
        else:
            filter_complex.append("".join(f"[{label}]" for label in audio_parts) + f"concat=n={len(audio_parts)}:v=0:a=1[aout]")

    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        edit_source_path,
        "-i",
        segment_path,
        "-filter_complex",
        ";".join(filter_complex),
        "-map",
        "[vout]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-color_range",
        "tv",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-crf",
        "16",
        "-preset",
        "slow",
    ]
    if has_audio:
        cmd.extend(
            [
                "-map",
                "[aout]",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ]
        )
    cmd.append(output_path)
    _run(cmd)
    return cmd


def stitch_video_segments(
    input_paths: list[str],
    output_path: str,
    *,
    fps_num: int,
    fps_den: int,
    output_width: int,
    output_height: int,
    trim_start_frames: list[int] | None = None,
    trim_end_frames: list[int] | None = None,
    crf: int = 16,
    preset: str = "slow",
) -> list[str]:
    if not input_paths:
        raise FFmpegError("No input segments provided for stitching")
    trims = trim_start_frames or [0] * len(input_paths)
    if len(trims) != len(input_paths):
        raise FFmpegError("Trim list does not match input segment count")
    end_trims = trim_end_frames or [0] * len(input_paths)
    if len(end_trims) != len(input_paths):
        raise FFmpegError("End trim list does not match input segment count")
    fps = Fraction(fps_num if fps_num > 0 else 24, fps_den if fps_den > 0 else 1)
    fps_str = f"{fps.numerator}/{fps.denominator}"
    one_frame_sec = float(Fraction(1, fps))
    filter_complex: list[str] = []
    concat_inputs: list[str] = []
    command = [FFMPEG_BIN, "-y"]
    for path in input_paths:
        command.extend(["-i", path])
    for index, path in enumerate(input_paths):
        probe = ffprobe_video(path)
        start_trim_sec = max(0.0, float(Fraction(max(0, int(trims[index])), 1) / fps))
        end_trim_sec = max(0.0, float(Fraction(max(0, int(end_trims[index])), 1) / fps))
        duration_sec = max(one_frame_sec, float(probe.get("duration_sec") or one_frame_sec))
        max_trim_sec = max(0.0, duration_sec - one_frame_sec)
        start_trim_sec = min(start_trim_sec, max_trim_sec)
        end_trim_sec = min(end_trim_sec, max(0.0, max_trim_sec - start_trim_sec))
        end_sec = max(start_trim_sec + one_frame_sec, duration_sec - end_trim_sec)
        filter_complex.append(
            (
                f"[{index}:v]trim=start={_format_seconds(start_trim_sec)}:end={_format_seconds(end_sec)},"
                f"fps={fps_str},scale={output_width}:{output_height}:flags=lanczos,"
                "setsar=1,format=yuv420p,setpts=PTS-STARTPTS"
                f"[v{index}]"
            )
        )
        concat_inputs.append(f"[v{index}]")
    filter_complex.append(f"{''.join(concat_inputs)}concat=n={len(input_paths)}:v=1:a=0[vout]")
    command.extend(
        [
            "-filter_complex",
            ";".join(filter_complex),
            "-map",
            "[vout]",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            str(crf),
            "-preset",
            preset,
            output_path,
        ]
    )
    _run(command)
    return command
