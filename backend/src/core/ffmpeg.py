from __future__ import annotations

import json
import os
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

FFMPEG_BIN = os.getenv("FFMPEG_BIN", "/opt/bin/ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "/opt/bin/ffprobe")


class FFmpegError(RuntimeError):
    pass


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


def transcode_to_cfr(input_path: str, output_path: str, fps: Fraction) -> None:
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        input_path,
        "-vf",
        f"fps={fps.numerator}/{fps.denominator}",
        "-vsync",
        "cfr",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
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
) -> None:
    fps = Fraction(fps_num, fps_den)
    start_sec = Fraction(start_frame, 1) / fps
    duration_sec = Fraction(max(0, end_frame_exclusive - start_frame), 1) / fps
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-ss",
        f"{float(start_sec):.6f}",
        "-i",
        input_path,
        "-t",
        f"{float(duration_sec):.6f}",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        output_path,
    ]
    _run(cmd)


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
    temporal_feather_frames: int,
) -> list[str]:
    fps = Fraction(fps_num, fps_den)
    start_sec = float(Fraction(start_frame, 1) / fps)
    end_sec = float(Fraction(end_frame_exclusive, 1) / fps)
    duration_sec = max(0.0, end_sec - start_sec)

    filter_complex = [
        f"[0:v]trim=0:{start_sec},setpts=PTS-STARTPTS[vpre]",
        f"[0:v]trim={end_sec},setpts=PTS-STARTPTS[vpost]",
        f"[1:v]trim=0:{duration_sec},setpts=PTS-STARTPTS[vgen]",
    ]

    if temporal_feather_frames > 0:
        feather_sec = float(Fraction(temporal_feather_frames, 1) / fps)
        filter_complex.append(
            "[0:v]trim={s}:{e},setpts=PTS-STARTPTS[vorigseg]".format(s=start_sec, e=end_sec)
        )
        filter_complex.append(
            (
                "[vorigseg][vgen]blend=all_expr='if(lte(T,{feather}),A*(1-T/{feather})+B*(T/{feather}),"
                "if(gte(T,{mid}),A*((T-{mid})/{feather})+B*(1-(T-{mid})/{feather}),B))'[vblend]"
            ).format(feather=feather_sec, mid=max(0, duration_sec - feather_sec))
        )
        concat_src = "[vpre][vblend][vpost]concat=n=3:v=1:a=0[vout]"
    else:
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
