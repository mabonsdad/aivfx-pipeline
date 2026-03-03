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
    }


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
    fps = Fraction(fps_num, fps_den)
    start_sec = float(Fraction(start_frame, 1) / fps)
    end_sec = float(Fraction(end_frame_exclusive, 1) / fps)
    duration_sec = max(0.0, end_sec - start_sec)
    fps_str = f"{fps_num}/{fps_den}"

    filter_complex = [
        # Normalize both streams up front so blend/concat operates on identical
        # geometry, cadence, sample aspect ratio, and pixel format.
        f"[0:v]fps={fps_str},scale={output_width}:{output_height}:flags=lanczos,setsar=1,format=yuv420p[vorigsrc]",
        f"[1:v]fps={fps_str},scale={output_width}:{output_height}:flags=lanczos,setsar=1,format=yuv420p[vgensrc]",
    ]

    if temporal_feather_frames > 0:
        filter_complex.extend(
            [
                "[vorigsrc]split=3[vorigpre][vorigpost][vorigsegsrc]",
                f"[vorigpre]trim=0:{start_sec},setpts=PTS-STARTPTS[vpre]",
                f"[vorigpost]trim={end_sec},setpts=PTS-STARTPTS[vpost]",
                f"[vgensrc]trim=0:{duration_sec},setpts=PTS-STARTPTS[vgen]",
            ]
        )
        feather_sec = float(Fraction(temporal_feather_frames, 1) / fps)
        filter_complex.append(
            "[vorigsegsrc]trim={s}:{e},setpts=PTS-STARTPTS[vorigseg]".format(s=start_sec, e=end_sec)
        )
        filter_complex.append(
            (
                "[vorigseg][vgen]blend=all_expr='if(lte(T,{feather}),A*(1-T/{feather})+B*(T/{feather}),"
                "if(gte(T,{mid}),A*((T-{mid})/{feather})+B*(1-(T-{mid})/{feather}),B))'[vblend]"
            ).format(feather=feather_sec, mid=max(0, duration_sec - feather_sec))
        )
        concat_src = "[vpre][vblend][vpost]concat=n=3:v=1:a=0[vout]"
    else:
        filter_complex.extend(
            [
                "[vorigsrc]split=2[vorigpre][vorigpost]",
                f"[vorigpre]trim=0:{start_sec},setpts=PTS-STARTPTS[vpre]",
                f"[vorigpost]trim={end_sec},setpts=PTS-STARTPTS[vpost]",
                f"[vgensrc]trim=0:{duration_sec},setpts=PTS-STARTPTS[vgen]",
            ]
        )
        concat_src = "[vpre][vgen][vpost]concat=n=3:v=1:a=0[vout]"

    filter_complex.append(concat_src)
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
        "-map",
        "0:a?",
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
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        output_path,
    ]
    _run(cmd)
    return cmd
