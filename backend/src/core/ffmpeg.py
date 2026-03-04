from __future__ import annotations

import json
import os
import subprocess
import math
from fractions import Fraction
from pathlib import Path
from typing import Any

FFMPEG_BIN = os.getenv("FFMPEG_BIN", "/opt/bin/ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "/opt/bin/ffprobe")


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
    crf: int = 18,
    preset: str = "fast",
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


def extract_frame_png(input_path: str, frame_index: int, output_path: str) -> None:
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        input_path,
        "-vf",
        f"select=eq(n\\,{frame_index})",
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
    crf: int = 18,
    preset: str = "medium",
    audio_bitrate: str = "192k",
) -> None:
    fps = Fraction(fps_num, fps_den)
    start_sec = Fraction(start_frame, 1) / fps
    duration_sec = Fraction(max(0, end_frame_exclusive - start_frame), 1) / fps
    vf_parts: list[str] = []
    if target_width and target_height:
        vf_parts.append(_scale_pad_filter(target_width, target_height))
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
) -> list[str]:
    epsilon = 1e-4
    fps = Fraction(fps_num, fps_den)
    start_sec = float(Fraction(start_frame, 1) / fps)
    end_sec = float(Fraction(end_frame_exclusive, 1) / fps)
    original_segment_duration_sec = max(0.0, end_sec - start_sec)
    fps_str = f"{fps_num}/{fps_den}"
    orig_probe = ffprobe_video(edit_source_path)
    generated_probe = ffprobe_video(segment_path)
    original_total_duration_sec = max(end_sec, float(orig_probe.get("duration_sec") or 0.0))
    generated_duration_sec = max(
        float(Fraction(1, max(1, fps_num))),
        float(generated_probe.get("duration_sec") or original_segment_duration_sec),
    )

    norm_original = f"fps={fps_str},scale={output_width}:{output_height}:flags=lanczos,setsar=1,format=yuv420p"
    norm_generated = f"fps={fps_str},scale={output_width}:{output_height}:flags=lanczos,setsar=1,format=yuv420p"
    filter_complex: list[str] = []
    video_parts: list[str] = []

    if temporal_feather_frames > 0:
        feather_sec = float(Fraction(temporal_feather_frames, 1) / fps)
        blend_in_sec = min(feather_sec, original_segment_duration_sec, generated_duration_sec)
        blend_out_sec = min(feather_sec, generated_duration_sec, max(0.0, original_total_duration_sec - end_sec))

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
                f"[1:v]trim=0:{_format_seconds(blend_in_sec)},{norm_generated},setpts=PTS-STARTPTS[vgen_in]"
            )
            filter_complex.append(
                "[vorig_in][vgen_in]blend=all_expr='if(lte(T,{d}),A*(1-T/{d})+B*(T/{d}),B)'[vblend_in]".format(
                    d=_format_seconds(blend_in_sec)
                )
            )
            video_parts.append("vblend_in")

        middle_start_sec = blend_in_sec
        middle_end_sec = max(middle_start_sec, generated_duration_sec - blend_out_sec)
        if middle_end_sec - middle_start_sec > epsilon:
            filter_complex.append(
                f"[1:v]trim={_format_seconds(middle_start_sec)}:{_format_seconds(middle_end_sec)},{norm_generated},setpts=PTS-STARTPTS[vgen_mid]"
            )
            video_parts.append("vgen_mid")

        if blend_out_sec > epsilon:
            filter_complex.append(
                f"[1:v]trim={_format_seconds(generated_duration_sec - blend_out_sec)}:{_format_seconds(generated_duration_sec)},{norm_generated},setpts=PTS-STARTPTS[vgen_out]"
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
            f"[1:v]trim=0:{_format_seconds(generated_duration_sec)},{norm_generated},setpts=PTS-STARTPTS[vgen]"
        )
        video_parts.append("vgen")
        post_tail_start_sec = end_sec

    if original_total_duration_sec - post_tail_start_sec > epsilon:
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

        segment_audio_end_sec = min(end_sec, original_total_duration_sec)
        if segment_audio_end_sec - start_sec > epsilon:
            filter_complex.append(
                f"[0:a]atrim={_format_seconds(start_sec)}:{_format_seconds(segment_audio_end_sec)},asetpts=PTS-STARTPTS[aseg]"
            )
            if generated_duration_sec > epsilon and original_segment_duration_sec > epsilon:
                tempo_ratio = original_segment_duration_sec / generated_duration_sec
                filter_complex.append(f"[aseg]{_atempo_chain(tempo_ratio)}[aseg_adj]")
            else:
                filter_complex.append("[aseg]anull[aseg_adj]")
            audio_parts.append("aseg_adj")
        else:
            filter_complex.append(
                f"anullsrc=r=48000:cl=stereo,atrim=0:{_format_seconds(generated_duration_sec)}[aseg_adj]"
            )
            audio_parts.append("aseg_adj")

        if original_total_duration_sec - end_sec > epsilon:
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
        "18",
        "-preset",
        "medium",
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
