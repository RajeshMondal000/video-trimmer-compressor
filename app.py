from flask import Flask, render_template, request, send_file, jsonify, send_from_directory
import os, subprocess, json, threading, shutil, re
from datetime import datetime

app = Flask(__name__)
UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

progress_data = {"percent": 0, "done": False, "output": "", "error": "", "processing": False, "output_size": 0, "canceled": False, "messages": []}
current_process = {"proc": None, "lock": threading.Lock(), "cancel": False}

# Batch state
batches = {}  # batch_id -> {id, jobs: [job dicts], concurrency, started_at, completed}
merge_jobs = {}  # job_id -> {id, files:[], progress:dict, process:dict, output}
clips_jobs = {}  # reserved if we later need per-clip processes

def _new_progress():
    return {"percent": 0, "done": False, "output": "", "error": "", "processing": False, "output_size": 0, "canceled": False, "messages": []}

def _log_progress(pstate: dict, text: str):
    """Append a human-readable status line to the progress dict and print to server log."""
    try:
        print(f"[merge] {text}")
    except Exception:
        pass
    try:
        msgs = pstate.setdefault("messages", [])
        msgs.append(text)
        # Trim to last 200 lines to prevent unbounded growth
        if len(msgs) > 200:
            del msgs[:len(msgs)-200]
    except Exception:
        pass

def _new_process():
    return {"proc": None, "lock": threading.Lock(), "cancel": False}

def _parse_ffmpeg_time_to_seconds(line: str) -> float:
    """Parse a time=HH:MM:SS.xx occurrence from an ffmpeg stderr line."""
    m = re.search(r"time=([0-9]{2}):([0-9]{2}):([0-9]{2})(?:[\.:]([0-9]{1,2}))?", line)
    if not m:
        return -1.0
    hh, mm, ss, frac = m.groups()
    try:
        h = int(hh); m_ = int(mm); s = int(ss)
        f = int(frac) if frac is not None else 0
        # Treat frac as centiseconds
        return h * 3600 + m_ * 60 + s + (f / 100.0)
    except Exception:
        return -1.0

def _run_ffmpeg_with_progress(cmd, total_seconds: float, base: float, weight: float,
                              progress_ref: dict = None, process_ref: dict = None):
    """Run ffmpeg with live stderr parsing to update progress_data percent smoothly and support cancellation."""
    global progress_data, current_process
    pstate = progress_ref if progress_ref is not None else progress_data
    cproc = process_ref if process_ref is not None else current_process
    try:
        with subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True, bufsize=1, universal_newlines=True) as proc:
            with cproc["lock"]:
                cproc["proc"] = proc
            for line in proc.stderr:
                # Check cancel flag
                if cproc.get("cancel"):
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                    pstate["error"] = "Processing canceled by user"
                    pstate["done"] = True
                    pstate["processing"] = False
                    pstate["canceled"] = True
                    return -1
                t = _parse_ffmpeg_time_to_seconds(line)
                if t >= 0 and total_seconds > 0:
                    stage = max(0.0, min(1.0, t / total_seconds))
                    pct = int(min(99, base + weight * stage))
                    if pct > pstate.get("percent", 0):
                        pstate["percent"] = pct
                # Occasionally capture significant ffmpeg lines into log (e.g., stream mapping)
                try:
                    if 'Stream mapping:' in line:
                        _log_progress(pstate, 'FFmpeg: Stream mapping detected')
                    elif 'frame=' in line and 'fps=' in line and 'time=' in line and int(pstate.get('percent',0)) % 10 == 0:
                        # Throttle noisy logs; show periodic frame/time updates
                        _log_progress(pstate, line.strip())
                except Exception:
                    pass
            proc.wait()
            return proc.returncode
    except Exception:
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode
    finally:
        with cproc["lock"]:
            cproc["proc"] = None

def find_ffmpeg_bins():
    """Resolve ffmpeg and ffprobe executable paths dynamically.
    Returns tuple (ffmpeg_bin, ffprobe_bin, available: bool)
    """
    ffmpeg_bin = shutil.which("ffmpeg")
    ffprobe_bin = shutil.which("ffprobe")

    # Fallback to common Windows installation path
    if not ffmpeg_bin:
        candidate = os.path.join("C:\\", "ffmpeg", "bin", "ffmpeg.exe")
        if os.path.exists(candidate):
            ffmpeg_bin = candidate
    if not ffprobe_bin:
        candidate = os.path.join("C:\\", "ffmpeg", "bin", "ffprobe.exe")
        if os.path.exists(candidate):
            ffprobe_bin = candidate

    available = bool(ffmpeg_bin and ffprobe_bin)
    return ffmpeg_bin, ffprobe_bin, available

def _probe_rotation(ffprobe_bin: str, path: str) -> int:
    """Return rotation in degrees (0, 90, 180, 270) if available, else 0."""
    rot = 0
    try:
        out = subprocess.check_output([
            ffprobe_bin, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream_tags=rotate",
            "-of", "default=noprint_wrappers=1:nokey=1", path
        ]).decode().strip()
        if out:
            try:
                val = int(out)
                # Normalize to one of 0/90/180/270
                val = ((val % 360) + 360) % 360
                if val in (0, 90, 180, 270):
                    rot = val
            except Exception:
                rot = 0
    except Exception:
        rot = 0
    return rot

def _probe_dimensions(ffprobe_bin: str, path: str) -> tuple:
    """Return (width, height) of the first video stream after applying rotation metadata.
    Ensures even integers and non-zero fallback.
    """
    try:
        out = subprocess.check_output([
            ffprobe_bin, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "default=noprint_wrappers=1:nokey=1", path
        ]).decode().strip().splitlines()
        if len(out) >= 2:
            w = int(out[0] or 0)
            h = int(out[1] or 0)
        else:
            w, h = 0, 0
    except Exception:
        w, h = 0, 0
    if w <= 0 or h <= 0:
        return (640, 360)
    # Apply rotation if present to get display dimensions
    try:
        rot = _probe_rotation(ffprobe_bin, path)
    except Exception:
        rot = 0
    if rot in (90, 270):
        w, h = h, w
    # enforce even
    if w % 2: w -= 1
    if h % 2: h -= 1
    return (max(2, w), max(2, h))

# Serve uploaded files
@app.route('/uploads/<path:filename>')
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)

# ---------- Merge endpoints ----------
@app.route('/merge/upload', methods=['POST'])
def merge_upload():
    files = request.files.getlist('videos')
    if not files:
        return jsonify({"error":"No files"}), 400
    saved = []
    for f in files:
        name = f.filename or f"merge_{datetime.now().strftime('%H%M%S%f')}.mp4"
        dst = os.path.join(UPLOAD_FOLDER, name)
        f.save(dst)
        saved.append({"filename": name})
    return jsonify({"files": saved})

@app.route('/clips/upload', methods=['POST'])
def clips_upload():
    ffmpeg_bin, ffprobe_bin, ok = find_ffmpeg_bins()
    if not ok:
        return jsonify({"error":"FFmpeg not available"}), 400
    files = request.files.getlist('videos')
    if not files:
        return jsonify({"error":"No files"}), 400
    saved = []
    for f in files:
        try:
            name_root, ext = os.path.splitext(f.filename or 'clip')
            safe_root = re.sub(r"[^A-Za-z0-9_\-]", "_", name_root) or 'clip'
            ts = datetime.now().strftime('%Y%m%d%H%M%S')
            name = f"{safe_root}_{ts}.mp4"
            dst = os.path.join(UPLOAD_FOLDER, name)
            f.save(dst)
            duration = _probe_duration(ffprobe_bin, dst)
            size = os.path.getsize(dst) if os.path.exists(dst) else 0
            saved.append({"filename": name, "duration": duration, "size": size, "display": f.filename or name})
        except Exception as e:
            continue
    return jsonify({"files": saved})

@app.route('/merge/start', methods=['POST'])
def merge_start():
    data = request.get_json(force=True)
    files = data.get('files') or []
    if not files or len(files) < 2:
        return jsonify({"error":"Need at least 2 files"}), 400
    mode = data.get('mode','crf')
    quality_percent = data.get('quality_percent')
    target_size_mb = data.get('target_size_mb')
    crf = int(data.get('crf') or 28)
    resolution = data.get('resolution','original')
    width = data.get('width')
    height = data.get('height')
    video_codec = data.get('video_codec','h264')
    audio_codec = data.get('audio_codec','aac')
    container = data.get('container','mp4')

    ffmpeg_bin, ffprobe_bin, ok = find_ffmpeg_bins()
    if not ok:
        return jsonify({"error":"FFmpeg not found"}), 500

    job_id = datetime.now().strftime('%Y%m%d%H%M%S%f')
    progress = _new_progress()
    process = _new_process()
    merge_jobs[job_id] = {"id": job_id, "files": files, "progress": progress, "process": process, "output": None}

    def worker():
        try:
            # Mark as processing
            progress["processing"] = True
            # Build list file for concat demuxer (requires re-encode when params differ)
            list_path = os.path.join(UPLOAD_FOLDER, f"concat_{job_id}.txt")
            with open(list_path, 'w', encoding='utf-8') as lf:
                for fn in files:
                    lf.write(f"file '{os.path.abspath(os.path.join(UPLOAD_FOLDER, fn))}'\n")

            # Output name
            out_name = f"merged_{job_id}.{container}"
            out_path = os.path.join(UPLOAD_FOLDER, out_name)

            # Construct vf (rotation normalize + setsar + scale) similar to trimming path
            vf_chain = ["setsar=1"]
            if resolution in ["1080p","720p","480p","360p","240p"]:
                map_h = {"1080p":1080, "720p":720, "480p":480, "360p":360, "240p":240}
                vf_chain.append(f"scale=-2:{map_h[resolution]}")
            elif resolution == "custom":
                if height:
                    vf_chain.append(f"scale=-2:{int(height)}")
                elif width:
                    vf_chain.append(f"scale={int(width)}:-2")
            vf_args = ["-vf", ",".join(vf_chain)] if vf_chain else []

            # Determine codec args (always re-encode to ensure compatibility)
            vmap = {
                "h264": ("libx264", ["-preset","medium"]),
                "hevc": ("libx265", ["-preset","medium"]),
                "vp9": ("libvpx-vp9", []),
                "vp8": ("libvpx", []),
                "av1": ("libaom-av1", []),
                "prores": ("prores_ks", []),
                "dnxhd": ("dnxhd", []),
            }
            vcodec, vextra = vmap.get(video_codec, ("libx264", ["-preset","medium"]))
            # Mode → rate control
            v_args = []
            if mode == 'size' and target_size_mb:
                # 2-pass target size
                total_dur = 0.0
                try:
                    for fn in files:
                        p = os.path.join(UPLOAD_FOLDER, fn)
                        out = subprocess.check_output([ffprobe_bin, '-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1', p]).decode().strip()
                        total_dur += float(out)
                except Exception:
                    total_dur = 0.0
                target_bits = float(target_size_mb) * 8_000_000.0
                # crude split for video/audio
                vbps = max(100_000, int(target_bits * 0.85 / max(1.0, total_dur)))
                abps = max(48_000, int(target_bits * 0.15 / max(1.0, total_dur)))
                # Pass 1
                passlog = os.path.join(UPLOAD_FOLDER, f"merge_{job_id}")
                cmd1 = [ffmpeg_bin, '-y', '-hide_banner', '-f','concat','-safe','0','-i', list_path, *vf_args,
                        '-c:v', vcodec, *vextra, '-b:v', str(vbps), '-pass','1','-passlogfile', passlog, '-an','-f','null','NUL']
                rc = _run_ffmpeg_with_progress(cmd1, total_dur, 0, 40, progress, process)
                if rc != 0:
                    raise Exception('Pass 1 failed')
                # Pass 2
                # Map UI audio codec to ffmpeg codec name
                acodec_map = {
                    'aac': 'aac',
                    'mp3': 'libmp3lame',
                    'opus': 'libopus',
                    'vorbis': 'libvorbis',
                    'flac': 'flac',
                }
                acodec_ff = acodec_map.get((audio_codec or 'aac').lower(), 'aac')
                a_args = ['-c:a', acodec_ff]
                if acodec_ff != 'flac':
                    a_args += ['-b:a', str(abps)]
                cmd2 = [ffmpeg_bin, '-y', '-hide_banner', '-f','concat','-safe','0','-i', list_path, *vf_args,
                        '-c:v', vcodec, *vextra, '-b:v', str(vbps), '-pass','2', '-passlogfile', passlog, *a_args, out_path]
                rc2 = _run_ffmpeg_with_progress(cmd2, total_dur, 40, 60, progress, process)
                if rc2 != 0:
                    raise Exception('Pass 2 failed')
                # Cleanup passlog artifacts
                try:
                    for suf in ('-0.log', '-0.log.mbtree', '.log', '.log.mbtree'):
                        p = f"{passlog}{suf}"
                        if os.path.exists(p):
                            os.remove(p)
                except Exception:
                    pass
            else:
                # CRF/quality modes
                crf_val = None
                if mode == 'quality' and quality_percent is not None:
                    try:
                        q = int(quality_percent)
                        crf_calc = 35 - (q / 100.0) * (35 - 18)
                        crf_val = int(round(crf_calc))
                    except Exception:
                        crf_val = 28
                else:
                    try:
                        crf_val = int(crf)
                    except Exception:
                        crf_val = 28
                # Honor selected audio codec
                acodec_map = {
                    'aac': 'aac',
                    'mp3': 'libmp3lame',
                    'opus': 'libopus',
                    'vorbis': 'libvorbis',
                    'flac': 'flac',
                }
                acodec_ff = acodec_map.get((audio_codec or 'aac').lower(), 'aac')
                a_args = ['-c:a', acodec_ff]
                if acodec_ff != 'flac':
                    a_args += ['-b:a', '128k']
                v_args = ['-c:v', vcodec, *vextra]
                if vcodec in ('libx264','libx265','libvpx-vp9','libaom-av1'):
                    v_args += ['-crf', str(crf_val)]
                    if vcodec in ('libx264','libx265'):
                        v_args += ['-b:v','0']
                cmd = [ffmpeg_bin, '-y','-hide_banner','-f','concat','-safe','0','-i', list_path, *vf_args, *v_args, *a_args, out_path]
                # Estimate duration for progress (sum of parts)
                total_dur = 0.0
                try:
                    for fn in files:
                        p = os.path.join(UPLOAD_FOLDER, fn)
                        out = subprocess.check_output([ffprobe_bin, '-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1', p]).decode().strip()
                        total_dur += float(out)
                except Exception:
                    total_dur = 0.0
                rc = _run_ffmpeg_with_progress(cmd, total_dur, 0, 100, progress, process)
                if rc != 0:
                    raise Exception('Merge failed')

            try:
                progress["output_size"] = os.path.getsize(out_path)
            except Exception:
                progress["output_size"] = 0
            progress["output"] = out_name
            progress["percent"] = 100
            progress["done"] = True
            progress["processing"] = False
        except Exception as e:
            progress["error"] = str(e)
            progress["done"] = True
            progress["processing"] = False

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"job_id": job_id})

@app.route('/merge/start_clips', methods=['POST'])
def merge_start_clips():
    data = request.get_json(force=True)
    ffmpeg_bin, ffprobe_bin, ok = find_ffmpeg_bins()
    if not ok:
        return jsonify({"error":"FFmpeg not found"}), 500
    clips = data.get('clips') or []  # [{filename, cuts:[[s,e]], selection_mode:'cut'|'keep'}]
    if not clips or len(clips) < 2:
        return jsonify({"error":"Add at least two clips"}), 400
    mode = data.get('mode','crf')
    quality_percent = data.get('quality_percent')
    target_size_mb = data.get('target_size_mb')
    crf = int(data.get('crf') or 28)
    resolution = data.get('resolution','original')
    width = data.get('width')
    height = data.get('height')
    video_codec = data.get('video_codec','h264')
    audio_codec = data.get('audio_codec','aac')
    container = data.get('container','mp4')

    job_id = datetime.now().strftime('%Y%m%d%H%M%S%f')
    progress = _new_progress()
    process = _new_process()
    # Register the job so /merge/status can find it while the worker runs
    merge_jobs[job_id] = {"id": job_id, "clips": clips, "progress": progress, "process": process, "output": None}

    def worker():
        temp_parts = []
        list_path = None
        try:
            # Mark as processing
            progress["processing"] = True
            _log_progress(progress, "Starting multi-clip merge job…")
            # Build clip info list and compute total duration
            clip_infos = []
            total_dur = 0.0
            for c in clips:
                path = os.path.join(UPLOAD_FOLDER, c.get('filename',''))
                if not os.path.exists(path):
                    continue
                dur = _probe_duration(ffprobe_bin, path)
                total_dur += max(0.0, dur)
                clip_infos.append({"path": path, "filename": c.get('filename',''), "duration": dur, "cuts": c.get('cuts') or [], "mode": c.get('selection_mode','cut')})

            # Determine target aspect ratio from first clip and target resolution from highest-resolution clip
            first_path = os.path.join(UPLOAD_FOLDER, clips[0].get('filename',''))
            first_w, first_h = _probe_dimensions(ffprobe_bin, first_path) if os.path.exists(first_path) else (1920, 1080)
            target_ar = float(first_w) / float(max(1, first_h))
            _log_progress(progress, f"Target aspect ratio from first video ({clips[0].get('filename','')}): {first_w}x{first_h} (AR={target_ar:.4f})")
            # Find highest-resolution clip by area (after rotation)
            max_w = first_w
            max_h = first_h
            max_area = first_w * first_h
            for c in clips:
                p = os.path.join(UPLOAD_FOLDER, c.get('filename',''))
                if not os.path.exists(p):
                    continue
                w, h = _probe_dimensions(ffprobe_bin, p)
                area = w * h
                if area > max_area:
                    max_area = area
                    max_w, max_h = w, h
            _log_progress(progress, f"Highest available resolution across clips: {max_w}x{max_h}")
            # Compute target WxH that:
            # - matches aspect ratio of the first clip
            # - does not exceed the highest-resolution clip's width/height
            # - are even integers
            # Try to use full max_h first
            t_h = max_h
            t_w = int(round(t_h * target_ar))
            if t_w > max_w:
                # Fit by width instead
                t_w = max_w
                t_h = int(round(t_w / target_ar))
            # enforce even
            if t_w % 2: t_w -= 1
            if t_h % 2: t_h -= 1
            t_w = max(2, t_w)
            t_h = max(2, t_h)
            _log_progress(progress, f"Normalized output resolution: {t_w}x{t_h} (matches first AR, bounded by max res)")

            # Prepare codec and rate control for per-part normalization
            vmap = {
                "h264": ("libx264", ["-preset","medium"]),
                "hevc": ("libx265", ["-preset","medium"]),
                "vp9": ("libvpx-vp9", []),
                "vp8": ("libvpx", []),
                "av1": ("libaom-av1", []),
                "prores": ("prores_ks", []),
                "dnxhd": ("dnxhd", []),
            }
            vcodec, vextra = vmap.get(video_codec, ("libx264", ["-preset","medium"]))
            # Compute rate control common to all parts
            use_size_mode = (mode == 'size' and target_size_mb)
            sum_len_expected = 0.0  # approximate total kept length across all clips
            # Precompute keep segments per clip for later loop and sum length
            per_clip_keeps = []
            for info in clip_infos:
                dur = info['duration'] or 0.0
                cuts_arr = info['cuts'] or []
                sel_mode = info['mode']
                if sel_mode == 'keep':
                    norm = []
                    for pair in cuts_arr:
                        try:
                            s = max(0.0, min(dur, float(pair[0])))
                            e = max(0.0, min(dur, float(pair[1])))
                            if e > s+0.05: norm.append((s,e))
                        except Exception:
                            pass
                    norm.sort(key=lambda x: x[0])
                    keep_segments = []
                    for s,e in norm:
                        if not keep_segments or s > keep_segments[-1][1]:
                            keep_segments.append([s,e])
                        else:
                            keep_segments[-1][1] = max(keep_segments[-1][1], e)
                else:
                    try:
                        pts = [0.0] + [float(x) for p in cuts_arr for x in p] + [float(dur)]
                        pts.sort()
                        keep_segments = [[pts[i], pts[i+1]] for i in range(0, len(pts)-1, 2)]
                    except Exception:
                        keep_segments = [[0.0, float(dur)]]
                per_clip_keeps.append(keep_segments)
                for (s,e) in keep_segments:
                    seglen = max(0.0, e - s)
                    if seglen > 0.05:
                        sum_len_expected += seglen

            # Size mode ABR calculation shared by all parts (approximate target)
            vbps = None
            abps = 128_000
            if use_size_mode and sum_len_expected > 0.1:
                target_bits = float(target_size_mb) * 8_000_000.0
                vbps = max(100_000, int(target_bits * 0.85 / sum_len_expected))
                abps = max(48_000, int(target_bits * 0.15 / sum_len_expected))
                _log_progress(progress, f"Target size mode: total kept≈{sum_len_expected:.1f}s, video≈{vbps}bps, audio≈{abps}bps")
            else:
                _log_progress(progress, "CRF/Quality mode selected for per-part normalization")

            # Export each kept segment, normalized to target WxH and AR
            part_idx = 0
            done_seconds = 0.0
            for info, keep_segments in zip(clip_infos, per_clip_keeps):
                _log_progress(progress, f"Processing clip: {info.get('filename','(unknown)')} ({info.get('duration',0):.1f}s)")
                # Export each keep as a part re-encoded to normalized WxH with padding to avoid stretch/crop
                # Also normalize rotation and pixel aspect ratio
                # Build per-source rotation filter first
                try:
                    rot = _probe_rotation(ffprobe_bin, info['path'])
                except Exception:
                    rot = 0
                rot_filter = None
                if rot == 90:
                    rot_filter = "transpose=1"
                elif rot == 270:
                    rot_filter = "transpose=2"
                elif rot == 180:
                    rot_filter = "transpose=2,transpose=2"
                if rot_filter:
                    _log_progress(progress, f"Applying rotation correction: {rot}°")
                # Scale to fit within target, then pad to target size, preserve AR of input but overall output AR equals first video
                ar_val = float(target_ar)
                # scale: if input wider than target AR -> scale width to t_w, else scale height to t_h
                scale_expr = f"scale='if(gt(a,{ar_val:.6f}),{t_w},-2)':'if(gt(a,{ar_val:.6f}),-2,{t_h})'"
                pad_expr = f"pad={t_w}:{t_h}:(ow-iw)/2:(oh-ih)/2:black"
                filters = [f for f in [rot_filter, 'setsar=1', scale_expr, pad_expr] if f]
                vf_str = ",".join(filters)
                for (s,e) in keep_segments:
                    length = max(0.0, e - s)
                    if length <= 0.05:
                        continue
                    # Use an intermediate container compatible with the final selection
                    part_ext = {
                        'webm': '.webm',
                        'mkv': '.mkv',
                        'mov': '.mov',
                        'mp4': '.mp4',
                    }.get((container or 'mp4').lower(), '.mp4')
                    part_file = os.path.join(UPLOAD_FOLDER, f"clip_part_{job_id}_{part_idx}{part_ext}")
                    part_idx += 1
                    _log_progress(progress, f"Exporting segment {s:.2f}-{e:.2f}s → {os.path.basename(part_file)}")
                    # Build per-part encode args (CRF/quality or ABR for size mode)
                    v_args = []
                    if use_size_mode and vbps is not None:
                        v_args = ['-c:v', vcodec, *vextra, '-b:v', str(vbps)]
                    else:
                        # CRF path: derive crf_val either from quality_percent or crf
                        if mode == 'quality' and quality_percent is not None:
                            try:
                                q = int(quality_percent)
                                crf_calc = 35 - (q / 100.0) * (35 - 18)
                                crf_val = int(round(crf_calc))
                            except Exception:
                                crf_val = 28
                        else:
                            try:
                                crf_val = int(crf)
                            except Exception:
                                crf_val = 28
                        v_args = ['-c:v', vcodec, *vextra]
                        if vcodec in ('libx264','libx265','libvpx-vp9','libaom-av1'):
                            v_args += ['-crf', str(crf_val)]
                            if vcodec in ('libx264','libx265'):
                                v_args += ['-b:v','0']
                    # Pick audio codec consistent with selected audio_codec
                    acodec_map = {
                        'aac': 'aac',
                        'mp3': 'libmp3lame',
                        'opus': 'libopus',
                        'vorbis': 'libvorbis',
                        'flac': 'flac',
                    }
                    acodec_key = (audio_codec or 'aac').lower()
                    acodec_ff = acodec_map.get(acodec_key, 'aac')
                    a_args = ['-c:a', acodec_ff]
                    if acodec_ff != 'flac':
                        a_args += ['-b:a', str(abps)]
                    cmd = [ffmpeg_bin, '-hide_banner', '-y', '-ss', str(s), '-i', info['path'], '-t', str(length), '-vf', vf_str, *v_args, *a_args, part_file]
                    rc = _run_ffmpeg_with_progress(cmd, length, base=int((done_seconds / max(0.001, total_dur)) * 60), weight=30 / max(1, len(keep_segments)), progress_ref=progress, process_ref=process)
                    if rc != 0:
                        raise Exception('Failed to export segment')
                    done_seconds += length
                    temp_parts.append(part_file)

            if not temp_parts:
                raise Exception('No content to merge from selected clips')
            # Write concat list
            list_path = os.path.join(UPLOAD_FOLDER, f"concat_{job_id}.txt")
            with open(list_path, 'w', encoding='utf-8') as lf:
                for p in temp_parts:
                    lf.write(f"file '{os.path.abspath(p)}'\n")

            out_name = f"clips_merged_{job_id}.{container}"
            out_path = os.path.join(UPLOAD_FOLDER, out_name)
            # Final concat: all parts are normalized to the same codec/params; stream copy to avoid re-encoding
            # Write concat list
            sum_len = 0.0
            for p in temp_parts:
                try:
                    sum_len += _probe_duration(ffprobe_bin, p)
                except Exception:
                    pass
            _log_progress(progress, "Concatenating normalized parts (stream copy)…")
            cmd = [ffmpeg_bin, '-y', '-hide_banner', '-f','concat','-safe','0','-i', list_path, '-c','copy', out_path]
            rc = _run_ffmpeg_with_progress(cmd, sum_len, base=85, weight=15, progress_ref=progress, process_ref=process)
            if rc != 0:
                raise Exception('Concat copy failed')
            _log_progress(progress, "Merge completed successfully")

            try:
                progress["output_size"] = os.path.getsize(out_path)
            except Exception:
                progress["output_size"] = 0
            progress["output"] = out_name
            progress["percent"] = 100
            progress["done"] = True
            progress["processing"] = False
        except Exception as e:
            progress["error"] = str(e)
            progress["done"] = True
            progress["processing"] = False
        finally:
            # cleanup
            if list_path and os.path.exists(list_path):
                try: os.remove(list_path)
                except Exception: pass
            for p in temp_parts:
                if os.path.exists(p):
                    try: os.remove(p)
                    except Exception: pass

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"job_id": job_id})

@app.route('/merge/status')
def merge_status():
    job_id = request.args.get('job_id')
    job = merge_jobs.get(job_id)
    if not job:
        return jsonify({"error":"unknown job"}), 404
    return jsonify(job['progress'])

@app.route('/merge/cancel', methods=['POST'])
def merge_cancel():
    job_id = request.args.get('job_id')
    job = merge_jobs.get(job_id)
    if not job:
        return jsonify({"ok":True})
    with job['process']["lock"]:
        job['process']["cancel"] = True
    return jsonify({"ok":True})

# Background FFmpeg trimming & compression
def run_ffmpeg_segments(input_path, keep_segments, crf, output_path, ffmpeg_bin,
                        mode="crf", quality_percent=None, target_size_mb=None, audio_kbps=128,
                        resolution="original", width=None, height=None,
                        video_codec="h264", audio_codec="aac", container="mp4",
                        progress_ref: dict = None, process_ref: dict = None):
    global progress_data, current_process
    pstate = progress_ref if progress_ref is not None else progress_data
    cproc = process_ref if process_ref is not None else current_process
    # reset
    pstate.update({"percent": 0, "done": False, "output": "", "error": "", "processing": True, "output_size": 0, "canceled": False})
    with cproc["lock"]:
        cproc["cancel"] = False

    parts = []
    list_file = None
    # Unique tag for temp files to avoid collisions under concurrency
    try:
        import uuid
        unique_tag = datetime.now().strftime("%Y%m%d%H%M%S_%f") + "_" + uuid.uuid4().hex[:8]
    except Exception:
        unique_tag = datetime.now().strftime("%Y%m%d%H%M%S_%f")
    total_seconds = 0.0
    try:
        _log_progress(pstate, "Preparing segments for single-file processing…")
        # Normalize segments: skip zero/negative durations to avoid ffmpeg errors
        normalized = []
        for (s, e) in keep_segments:
            try:
                s_f = float(s)
                e_f = float(e)
            except Exception:
                continue
            if e_f - s_f > 0.05:  # skip near-zero segments
                normalized.append((s_f, e_f))

        if not normalized:
            raise Exception("No content to keep after applying cuts. Adjust your cut ranges.")

        # Pre-compute kept total seconds
        total_seconds = sum(max(0.0, e - s) for (s, e) in normalized)
        _log_progress(pstate, f"Kept {len(normalized)} segments totaling {total_seconds:.1f}s")
        # Create segments
        for i, (s, e) in enumerate(normalized):
            _log_progress(pstate, f"Creating part {i+1}/{len(normalized)}: {s:.2f}-{e:.2f}s (stream copy)")
            duration = max(0.0, e - s)
            part_file = os.path.join(UPLOAD_FOLDER, f"part_{unique_tag}_{i}.mp4")
            # Use input seek (-ss before -i) and duration (-t) with stream copy for fast/accurate splits
            result = subprocess.run([
                    ffmpeg_bin,
                    "-hide_banner", "-y",
                    "-ss", str(s),
                    "-i", input_path,
                    "-t", str(duration),
                    "-c", "copy",
                    part_file
                ], capture_output=True, text=True)
            if result.returncode != 0:
                raise Exception(f"FFmpeg segment creation failed: {result.stderr}")
            parts.append(part_file)
            # Segmenting contributes first 10%
            try:
                pstate["percent"] = int(((i + 1) / len(normalized)) * 10)
            except Exception:
                pstate["percent"] = min(pstate.get("percent", 0) + 1, 10)

        # Create list file for concatenation
        list_file = os.path.join(UPLOAD_FOLDER, f"list_{unique_tag}.txt")
        with open(list_file, "w") as f:
            for p in parts:
                f.write(f"file '{os.path.abspath(p)}'\n")

        # Compute original kept size (sum of copied segments) to enforce a max cap in size mode
        kept_size_bytes = 0
        for p in parts:
            try:
                kept_size_bytes += os.path.getsize(p)
            except Exception:
                pass

    # Build filter chain: normalize rotation (if any) -> set SAR -> scale
        _log_progress(pstate, "Building video filters (rotation/SAR/scale)…")
        vf_chain = []
        # Probe rotation and normalize after cropping so crop is in source coordinates
        try:
            _ffmpeg, ffprobe_bin, _ok = find_ffmpeg_bins()
            rotation = _probe_rotation(ffprobe_bin, input_path) if ffprobe_bin else 0
        except Exception:
            rotation = 0
        # If metadata claims 0/180 but UI heuristics detect display rotation, allow an override via query? Not available here,
        # so keep using probed rotation; client will adjust mapping to source.
        if rotation == 90:
            vf_chain.append("transpose=1")  # clockwise
        elif rotation == 270:
            vf_chain.append("transpose=2")  # counter-clockwise
        elif rotation == 180:
            # two transposes = 180 deg
            vf_chain.append("transpose=2,transpose=2")
        # Normalize sample aspect ratio to 1:1 so display math matches pixel math
        vf_chain.append("setsar=1")
        try:
            target_h = None
            if resolution in ["1080p", "720p", "480p", "360p", "240p"]:
                mapping = {"1080p": 1080, "720p": 720, "480p": 480, "360p": 360, "240p": 240}
                target_h = mapping.get(resolution)
            elif resolution == "custom":
                if height:
                    target_h = int(height)
                elif width:
                    vf_chain.append(f"scale={int(width)}:-2")
            if target_h:
                vf_chain.append(f"scale=-2:{int(target_h)}")
        except Exception:
            pass
        vf_str = ",".join(vf_chain)
        vf_args = ["-vf", vf_str] if vf_chain else []
        # Debug: log constructed filter chain
        try:
            print(f"[vf] rotation={rotation} chain='{vf_str}'")
        except Exception:
            pass
        # If we rotated frames, clear rotation metadata to avoid double-rotation at playback
        metadata_v = ["-metadata:s:v:0", "rotate=0"] if rotation in (90,180,270) else []

        # Determine codecs and validate combinations
        # Map friendly names to ffmpeg codec ids
        video_map = {
            "h264": ("libx264", True),
            "hevc": ("libx265", True),
            "vp8": ("libvpx", True),
            "vp9": ("libvpx-vp9", True),
            "av1": ("libaom-av1", True),
            "prores": ("prores_ks", False),
            "dnxhd": ("dnxhd", False),  # DNxHR via profiles
        }
        audio_map = {
            "aac": "aac",
            "mp3": "libmp3lame",
            "opus": "libopus",
            "vorbis": "libvorbis",
            "flac": "flac",
        }
        container = (container or "mp4").lower()
        vkey = (video_codec or "h264").lower()
        akey = (audio_codec or "aac").lower()
        if vkey not in video_map:
            raise Exception(f"Unsupported video codec: {video_codec}")
        if akey not in audio_map:
            raise Exception(f"Unsupported audio codec: {audio_codec}")
        vcodec, v_two_pass = video_map[vkey]
        acodec = audio_map[akey]

        # Validate container compatibility
        def invalid_combo(msg):
            raise Exception(f"Invalid combination for {container.upper()}: {msg}")

        if container == "webm":
            if vcodec not in ["libvpx", "libvpx-vp9", "libaom-av1"]:
                invalid_combo("Video must be VP8, VP9 or AV1")
            if acodec not in ["libopus", "libvorbis"]:
                invalid_combo("Audio must be Opus or Vorbis")
        elif container == "mp4":
            if vcodec not in ["libx264", "libx265"]:
                invalid_combo("Video must be H.264 or H.265")
            if acodec not in ["aac", "libmp3lame"]:
                invalid_combo("Audio must be AAC or MP3")
        elif container == "mov":
            if vcodec not in ["libx264", "libx265", "prores_ks", "dnxhd"]:
                invalid_combo("Video must be H.264/H.265/ProRes/DNxHD(R)")
            if acodec not in ["aac", "libmp3lame"]:
                invalid_combo("Audio must be AAC or MP3")
        elif container == "mkv":
            pass  # MKV is flexible
        else:
            raise Exception(f"Unsupported container: {container}")

        # Set output extension based on container
        ext_map = {"mp4": ".mp4", "mov": ".mov", "webm": ".webm", "mkv": ".mkv"}
        out_ext = ext_map.get(container, ".mp4")
        if not output_path.lower().endswith(out_ext):
            root, _ = os.path.splitext(output_path)
            output_path = root + out_ext

        # No crop feature; copy mode remains unless other settings require re-encode

        # Concatenate and compress by selected mode
        if mode == "copy":
            _log_progress(pstate, "Concatenating kept parts (copy mode)…")
            # Stream-copy concatenation: preserves original streams, avoids size changes
            cmd = [
                ffmpeg_bin, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list_file,
                "-c", "copy",
                output_path
            ]
            rc = _run_ffmpeg_with_progress(cmd, total_seconds, base=10.0, weight=90.0, progress_ref=pstate, process_ref=cproc)
            if rc != 0:
                raise Exception("FFmpeg concat copy failed")
        elif mode == "size" and target_size_mb:
            # Compute duration of kept segments to derive average bitrate (already computed)
            if total_seconds <= 0.1:
                raise Exception("Computed kept duration is too small.")
            if not v_two_pass:
                raise Exception(f"Target size mode is not supported for selected video codec '{vkey}'. Use CRF/Quality mode.")
            _log_progress(pstate, f"Target size mode: {target_size_mb} MB with two-pass encoding…")
            # target size (MB) -> total bits (cap by original kept size to avoid upsizing)
            target_bits = float(target_size_mb) * 8_000_000.0
            original_bits = float(kept_size_bytes) * 8.0
            # Safety margin to ensure we never exceed original due to container overhead
            original_bits_cap = max(0.0, original_bits * 0.99)
            total_bits = min(target_bits, original_bits_cap)
            # reserve audio bitrate
            a_kbps = max(32, int(audio_kbps or 128))
            a_bps = a_kbps * 1000
            # video bitrate in bps = (total_bits/seconds) - audio
            v_bps = max(50_000, (total_bits / total_seconds) - a_bps)  # floor at 50kbps
            v_kbps = int(v_bps / 1000)

            passlog = os.path.join(UPLOAD_FOLDER, f"ffmpeg2pass_{unique_tag}" )
            # 1st pass (progress 10%->55%)
            cmd1 = [
                ffmpeg_bin, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list_file,
                *vf_args,
                "-c:v", vcodec, "-b:v", f"{v_kbps}k", "-pass", "1", "-passlogfile", passlog,
                "-an", "-f", "null", os.devnull
            ]
            rc = _run_ffmpeg_with_progress(cmd1, total_seconds, base=10.0, weight=45.0, progress_ref=pstate, process_ref=cproc)
            if rc != 0:
                raise Exception("FFmpeg 1st pass failed")
            # 2nd pass (progress 55%->100%)
            cmd2 = [
                ffmpeg_bin, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list_file,
                *vf_args,
                "-c:v", vcodec, "-b:v", f"{v_kbps}k", "-pass", "2", "-passlogfile", passlog,
                *metadata_v,
                "-c:a", acodec, *( ["-b:a", f"{a_kbps}k"] if acodec != "flac" else [] ),
                output_path
            ]
            rc = _run_ffmpeg_with_progress(cmd2, total_seconds, base=55.0, weight=45.0, progress_ref=pstate, process_ref=cproc)
            if rc != 0:
                raise Exception("FFmpeg 2nd pass failed")
        else:
            # CRF mode (default) possibly derived from quality percent
            _log_progress(pstate, f"CRF/quality mode: CRF={crf} (or derived from quality%)")
            if mode == "quality" and quality_percent is not None:
                # Map quality% (1..100) to CRF (35..18): lower CRF = better quality
                try:
                    q = max(1, min(100, int(quality_percent)))
                except Exception:
                    q = 75
                crf_calc = 35 - (q / 100.0) * (35 - 18)
                crf_val = int(round(crf_calc))
            else:
                crf_val = int(crf)

            # Build codec-specific args for CRF/quality
            v_args = []
            if vcodec in ["libx264", "libx265"]:
                v_args = ["-c:v", vcodec, "-crf", str(crf_val)]
            elif vcodec in ["libvpx", "libvpx-vp9", "libaom-av1"]:
                # Use CRF with constant quality
                v_args = ["-c:v", vcodec, "-crf", str(crf_val), "-b:v", "0"]
                if vcodec == "libvpx-vp9":
                    v_args += ["-row-mt", "1"]
                if vcodec == "libaom-av1":
                    v_args += ["-cpu-used", "4"]
            elif vcodec == "prores_ks":
                # ProRes doesn't use CRF; pick a reasonable profile (standard quality)
                v_args = ["-c:v", vcodec, "-profile:v", "3"]
            elif vcodec == "dnxhd":
                # DNxHR LB profile for arbitrary resolutions
                v_args = ["-c:v", vcodec, "-profile:v", "dnxhr_lb"]
            else:
                v_args = ["-c:v", vcodec]

            a_args = ["-c:a", acodec]
            if acodec != "flac":
                # Default audio bitrate if not coming from size mode
                a_kbps = max(32, int(audio_kbps or 128))
                a_args += ["-b:a", f"{a_kbps}k"]

            cmd = [
                ffmpeg_bin, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list_file,
                *vf_args,
                *v_args,
                *metadata_v,
                *a_args,
                output_path
            ]
            # Single-pass encode (progress 10%->100%)
            rc = _run_ffmpeg_with_progress(cmd, total_seconds, base=10.0, weight=90.0, progress_ref=pstate, process_ref=cproc)
            if rc != 0:
                raise Exception("FFmpeg concatenation failed")

        pstate["percent"] = 100
        pstate["done"] = True
        pstate["output"] = os.path.basename(output_path)
        try:
            pstate["output_size"] = os.path.getsize(output_path)
        except Exception:
            pstate["output_size"] = 0
        pstate["processing"] = False
        _log_progress(pstate, "Single-file processing completed successfully")

    except Exception as e:
        if not pstate.get("canceled"):
            pstate["error"] = str(e)
            pstate["done"] = True
            pstate["processing"] = False

    finally:
        # Cleanup temporary files
        for part_file in parts:
            if os.path.exists(part_file):
                try:
                    os.remove(part_file)
                except Exception:
                    pass
        if list_file and os.path.exists(list_file):
            try:
                os.remove(list_file)
            except Exception:
                pass
        # Remove potential two-pass log artifacts if any
        try:
            prefix = os.path.join(UPLOAD_FOLDER, f"ffmpeg2pass_{unique_tag}")
            for suf in ('-0.log', '-0.log.mbtree', '.log', '.log.mbtree'):
                p = f"{prefix}{suf}"
                if os.path.exists(p):
                    os.remove(p)
        except Exception:
            pass

@app.route("/progress")
def progress():
    return jsonify(progress_data)

@app.route("/cancel", methods=["POST"])
def cancel():
    global current_process, progress_data
    with current_process["lock"]:
        current_process["cancel"] = True
        proc = current_process.get("proc")
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
    progress_data["error"] = "Canceled"
    progress_data["canceled"] = True
    progress_data["done"] = True
    progress_data["processing"] = False
    return jsonify({"status": "canceled"})

def _probe_duration(ffprobe_bin, path):
    try:
        return float(subprocess.check_output([
            ffprobe_bin, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", path
        ]).decode().strip())
    except Exception:
        return 0.0

def _compute_keep_segments(duration, cuts):
    try:
        cut_points = [0.0] + [float(x) for c in (cuts or []) for x in c] + [float(duration)]
        cut_points.sort()
        return [(cut_points[i], cut_points[i+1]) for i in range(0, len(cut_points)-1, 2)]
    except Exception:
        return [(0.0, float(duration))]

@app.route("/batch/upload", methods=["POST"])
def batch_upload():
    # Accept multiple files under field name 'videos'
    ffmpeg_bin, ffprobe_bin, available = find_ffmpeg_bins()
    if not available:
        return jsonify({"error": "FFmpeg not available"}), 400
    files = request.files.getlist('videos')
    if not files:
        return jsonify({"error": "No files uploaded"}), 400
    saved = []
    for f in files:
        try:
            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            name_root, _ = os.path.splitext(f.filename or 'input')
            safe_root = re.sub(r"[^A-Za-z0-9_\-]", "_", name_root) or 'input'
            input_path = os.path.join(UPLOAD_FOLDER, f"{safe_root}_{timestamp}.mp4")
            f.save(input_path)
            duration = _probe_duration(ffprobe_bin, input_path)
            try:
                size_bytes = os.path.getsize(input_path)
            except Exception:
                size_bytes = 0
            saved.append({"filename": os.path.basename(input_path), "duration": duration, "size": size_bytes, "display": f.filename})
        except Exception as e:
            continue
    return jsonify({"files": saved})

@app.route("/batch/start", methods=["POST"])
def batch_start():
    ffmpeg_bin, ffprobe_bin, available = find_ffmpeg_bins()
    if not available:
        return jsonify({"error": "FFmpeg not available"}), 400
    data = request.get_json(silent=True) or {}
    files = data.get('files') or []
    if not files:
        return jsonify({"error": "No files provided"}), 400
    per_file = data.get('per_file') or []
    per_file_map = {}
    if isinstance(per_file, list):
        try:
            for it in per_file:
                fn = (it or {}).get('file')
                if fn:
                    per_file_map[fn] = it
        except Exception:
            per_file_map = {}
    # Settings (shared/preset)
    mode = data.get('mode', 'quality')
    quality_percent = data.get('quality_percent')
    target_size_mb = data.get('target_size_mb')
    audio_preset = data.get('audio_preset')  # 'original' or None
    audio_kbps = data.get('audio_kbps', 128)
    resolution = data.get('resolution', 'original')
    width = data.get('width')
    height = data.get('height')
    video_codec = data.get('video_codec', 'h264')
    audio_codec = data.get('audio_codec', 'aac')
    container = data.get('container', 'mp4')
    crf = data.get('crf', 28)
    cuts = data.get('cuts', [])
    selection_mode = data.get('selection_mode', 'cut')
    concurrency = data.get('concurrency', 'auto')

    # Create batch id
    batch_id = datetime.now().strftime("batch_%Y%m%d%H%M%S")
    jobs = []
    for fname in files:
        input_path = os.path.join(UPLOAD_FOLDER, fname)
        if not os.path.exists(input_path):
            continue
        duration = _probe_duration(ffprobe_bin, input_path)
        output_path = os.path.join(UPLOAD_FOLDER, f"output_{os.path.splitext(fname)[0]}_{datetime.now().strftime('%H%M%S')}.mp4")
        job = {
            "id": f"{batch_id}:{len(jobs)}",
            "file": fname,
            "input_path": input_path,
            "output_path": output_path,
            "progress": _new_progress(),
            "process": _new_process(),
            "status": "queued",
            "duration": duration,
        }
        # Attach per-file settings if provided
        if fname in per_file_map:
            job["settings"] = per_file_map.get(fname) or {}
        jobs.append(job)
    if not jobs:
        return jsonify({"error": "No valid files"}), 400

    # Determine concurrency
    if concurrency == 'auto':
        try:
            import multiprocessing
            c = max(1, min(len(jobs), (multiprocessing.cpu_count() or 2) // 2))
        except Exception:
            c = 2 if len(jobs) > 1 else 1
    else:
        try:
            c = max(1, int(concurrency))
        except Exception:
            c = 1

    batches[batch_id] = {"id": batch_id, "jobs": jobs, "concurrency": c, "started_at": datetime.now().isoformat(), "completed": False}

    def _worker(job):
        job["status"] = "running"
        # Determine settings for this job (per-file overrides or shared)
        js = job.get("settings") or {}
        j_mode = js.get('mode', mode)
        j_quality_percent = js.get('quality_percent', quality_percent)
        j_target_size_mb = js.get('target_size_mb', target_size_mb)
        j_audio_preset = js.get('audio_preset', audio_preset)
        j_audio_kbps = js.get('audio_kbps', audio_kbps)
        j_resolution = js.get('resolution', resolution)
        j_width = js.get('width', width)
        j_height = js.get('height', height)
        j_video_codec = js.get('video_codec', video_codec)
        j_audio_codec = js.get('audio_codec', audio_codec)
        j_container = js.get('container', container)
        j_crf = js.get('crf', crf)
        j_cuts = js.get('cuts', cuts)
        j_selection_mode = js.get('selection_mode', selection_mode)

        # For each job, compute keep segments for its duration based on cuts
        dur = job.get('duration') or 0.0
        if j_selection_mode == 'keep':
            try:
                norm = []
                for c in (j_cuts or []):
                    s = max(0.0, min(dur, float(c[0])))
                    e = max(0.0, min(dur, float(c[1])))
                    if e > s: norm.append((s,e))
                norm.sort(key=lambda x: x[0])
                merged = []
                for s,e in norm:
                    if not merged or s > merged[-1][1]:
                        merged.append([s,e])
                    else:
                        merged[-1][1] = max(merged[-1][1], e)
                keep_segments = [(a,b) for a,b in merged]
            except Exception:
                keep_segments = [(0.0, float(dur))]
        else:
            keep_segments = _compute_keep_segments(dur, j_cuts)
        # Resolve audio bitrate per job if "original"
        resolved_audio_kbps = None
        if j_audio_preset == 'original':
            try:
                out = subprocess.check_output([
                    ffprobe_bin, '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=bit_rate',
                    '-of', 'default=noprint_wrappers=1:nokey=1', job["input_path"]
                ]).decode().strip()
                if out and out.isdigit():
                    resolved_audio_kbps = max(32, min(512, int(int(out) / 1000)))
            except Exception:
                resolved_audio_kbps = None
        if resolved_audio_kbps is None:
            try:
                resolved_audio_kbps = max(32, min(512, int(j_audio_kbps)))
            except Exception:
                resolved_audio_kbps = 128
        run_ffmpeg_segments(
            job["input_path"], keep_segments, j_crf, job["output_path"], ffmpeg_bin,
            mode=j_mode,
            quality_percent=j_quality_percent,
            target_size_mb=j_target_size_mb,
            audio_kbps=resolved_audio_kbps,
            resolution=j_resolution,
            width=int(j_width) if j_width else None,
            height=int(j_height) if j_height else None,
            video_codec=j_video_codec,
            audio_codec=j_audio_codec,
            container=j_container,
            progress_ref=job["progress"],
            process_ref=job["process"],
        )
        job["status"] = "done" if not job["progress"].get("error") else "error"

    # Scheduler thread honoring concurrency
    def _schedule():
        sem = threading.Semaphore(c)
        threads = []
        for job in jobs:
            sem.acquire()
            def run_one(j=job):
                try:
                    _worker(j)
                finally:
                    try:
                        sem.release()
                    except Exception:
                        pass
            t = threading.Thread(target=run_one)
            t.daemon = True
            t.start()
            threads.append(t)
        for t in threads:
            t.join()
        batches[batch_id]["completed"] = True

    threading.Thread(target=_schedule, daemon=True).start()
    return jsonify({"batch_id": batch_id, "jobs": [j["id"] for j in jobs], "concurrency": c})

@app.route("/batch/status")
def batch_status():
    batch_id = request.args.get('batch_id')
    b = batches.get(batch_id)
    if not b:
        return jsonify({"error": "not found"}), 404
    # Aggregate percent as average of job percents
    job_status = []
    total_pct = 0
    for j in b["jobs"]:
        p = j["progress"].get("percent", 0)
        total_pct += p
        job_status.append({
            "id": j["id"],
            "file": j["file"],
            "status": j["status"],
            "percent": p,
            "error": j["progress"].get("error"),
            "done": j["progress"].get("done"),
            "output": j["progress"].get("output"),
            "output_size": j["progress"].get("output_size", 0),
        })
    avg_pct = int(total_pct / max(1, len(b["jobs"])) )
    return jsonify({
        "batch_id": b["id"],
        "concurrency": b["concurrency"],
        "completed": b.get("completed", False),
        "percent": avg_pct,
        "jobs": job_status
    })

@app.route("/batch/cancel", methods=["POST"])
def batch_cancel():
    batch_id = request.args.get('batch_id') or (request.get_json(silent=True) or {}).get('batch_id')
    b = batches.get(batch_id)
    if not b:
        return jsonify({"error": "not found"}), 404
    # Signal cancel to all running jobs
    for j in b["jobs"]:
        with j["process"]["lock"]:
            j["process"]["cancel"] = True
            proc = j["process"].get("proc")
            if proc and proc.poll() is None:
                try:
                    proc.terminate()
                except Exception:
                    pass
        j["progress"]["error"] = "Canceled"
        j["progress"]["canceled"] = True
        j["progress"]["done"] = True
        j["progress"]["processing"] = False
        j["status"] = "canceled"
    return jsonify({"status": "canceled", "batch_id": batch_id})

@app.route("/download")
def download():
    filename = request.args.get("file")
    if filename:
        file_path = os.path.join(UPLOAD_FOLDER, filename)
        if os.path.exists(file_path):
            return send_file(file_path, as_attachment=True)
    return "File not found", 404

def render_index(**kwargs):
    # Add cache-busting version param for static assets per render
    return render_template("index.html", v=datetime.now().strftime("%Y%m%d%H%M%S"), **kwargs)

@app.route("/", methods=["GET", "POST"])
def index():
    # Resolve FFmpeg availability dynamically
    ffmpeg_bin, ffprobe_bin, available = find_ffmpeg_bins()
    if not available:
        return render_index(
            video_filename=None,
            error="FFmpeg is not installed. Please install FFmpeg and ffprobe to use this video processing application. Visit https://ffmpeg.org/download.html for installation instructions."
        )
    
    if request.method == "POST":
        if "video" in request.files:
            file = request.files["video"]
            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            input_path = os.path.join(UPLOAD_FOLDER, f"input_{timestamp}.mp4")
            file.save(input_path)

            # Get video duration
            try:
                duration = float(subprocess.check_output([
                    ffprobe_bin, "-v", "error", "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1", input_path
                ]).decode().strip())
            except FileNotFoundError:
                return render_index(video_filename=None, error="FFmpeg is not installed. Please install FFmpeg to use this application.")
            except Exception as e:
                return render_index(video_filename=None, error=f"Error reading video file: {str(e)}")
            # File size
            try:
                file_size_bytes = os.path.getsize(input_path)
            except Exception:
                file_size_bytes = 0
            # Try to read average bitrate (bps) from container; fallback to size/duration
            bitrate_kbps = 0
            try:
                ff_bitrate = subprocess.check_output([
                    ffprobe_bin, "-v", "error", "-show_entries", "format=bit_rate",
                    "-of", "default=noprint_wrappers=1:nokey=1", input_path
                ]).decode().strip()
                if ff_bitrate and ff_bitrate.isdigit():
                    bitrate_kbps = int(int(ff_bitrate) / 1000)
            except Exception:
                bitrate_kbps = 0
            if bitrate_kbps <= 0 and duration > 0:
                try:
                    bitrate_kbps = int((file_size_bytes * 8) / 1000 / duration)
                except Exception:
                    bitrate_kbps = 0

            # Detect source codecs for auto-pick copy and UI defaults
            def _probe_codec(select_stream):
                try:
                    out = subprocess.check_output([
                        ffprobe_bin, "-v", "error", "-select_streams", select_stream,
                        "-show_entries", "stream=codec_name",
                        "-of", "default=noprint_wrappers=1:nokey=1", input_path
                    ]).decode().strip().lower()
                    return out
                except Exception:
                    return ""
            src_vcodec = _probe_codec("v:0")
            src_acodec = _probe_codec("a:0")
            # Normalize to our UI keys when possible
            vmap = {
                "h264": "h264", "avc1": "h264",
                "hevc": "hevc", "h265": "hevc", "hev1": "hevc",
                "vp8": "vp8", "vp9": "vp9", "av1": "av1",
                "prores": "prores", "apcn": "prores", "apch": "prores", "apco": "prores", "apcs": "prores",
                "dnxhd": "dnxhd", "dnxhr": "dnxhd"
            }
            amap = {
                "aac": "aac", "mp4a": "aac",
                "mp3": "mp3", "mp2": "mp3",
                "opus": "opus", "vorbis": "vorbis", "flac": "flac"
            }
            src_vkey = vmap.get(src_vcodec, "h264")
            src_akey = amap.get(src_acodec, "aac")
            src_container = "mp4"  # We save uploads as mp4 container internally
            # Probe rotation degrees
            try:
                src_rotation = _probe_rotation(ffprobe_bin, input_path)
            except Exception:
                src_rotation = 0

            return render_index(
                video_filename=os.path.basename(input_path),
                duration=duration,
                file_size_bytes=file_size_bytes,
                bitrate_kbps=bitrate_kbps,
                src_vcodec=src_vkey,
                src_acodec=src_akey,
                src_container=src_container,
                src_rotation=src_rotation
            )

        elif "existing_file" in request.form:
            filename = request.form["existing_file"]
            input_path = os.path.join(UPLOAD_FOLDER, filename)
            
            # Validate file exists
            if not os.path.exists(input_path):
                return render_index(video_filename=None)
                
            cuts = json.loads(request.form["cuts"]) if request.form["cuts"] else []
            selection_mode = request.form.get("selection_mode", "cut")
            # Compression mode and options
            mode = request.form.get("mode", "quality")
            quality_percent = request.form.get("quality_percent")
            target_size_mb = request.form.get("target_size_mb")
            audio_preset = request.form.get("audio_bitrate_preset")
            audio_kbps_form = request.form.get("audio_kbps")
            crf = request.form.get("crf", "28")
            resolution = request.form.get("resolution", "original")
            width = request.form.get("width")
            height = request.form.get("height")
            video_codec = request.form.get("video_codec", "h264")
            audio_codec = request.form.get("audio_codec", "aac")
            container = request.form.get("container", "mp4")
            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            # Provisional output; final extension may change based on container in worker
            output_path = os.path.join(UPLOAD_FOLDER, f"output_{timestamp}.mp4")

            # Get duration
            try:
                duration = float(subprocess.check_output([
                    ffprobe_bin, "-v", "error", "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1", input_path
                ]).decode().strip())
            except FileNotFoundError:
                return render_index(video_filename=None, error="FFmpeg is not installed. Please install FFmpeg to use this application.")
            except Exception as e:
                return render_index(video_filename=None, error=f"Error reading video file: {str(e)}")
            # Also compute file size to enable client-side estimation if needed
            try:
                file_size_bytes = os.path.getsize(input_path)
            except Exception:
                file_size_bytes = 0

            # Compute kept segments based on selection mode
            if selection_mode == 'keep':
                # Validate and clamp ranges directly as kept
                norm = []
                for c in cuts:
                    try:
                        s = max(0.0, min(duration, float(c[0])))
                        e = max(0.0, min(duration, float(c[1])))
                        if e > s: norm.append((s,e))
                    except Exception:
                        continue
                # sort and merge overlaps
                norm.sort(key=lambda x: x[0])
                merged = []
                for s,e in norm:
                    if not merged or s > merged[-1][1]:
                        merged.append([s,e])
                    else:
                        merged[-1][1] = max(merged[-1][1], e)
                keep_segments = [(a,b) for a,b in merged]
            else:
                # selection is cuts (to remove) -> invert
                cut_points = [0.0] + [float(x) for c in cuts for x in c] + [duration]
                cut_points.sort()
                keep_segments = [(cut_points[i], cut_points[i+1]) for i in range(0, len(cut_points)-1, 2)]

            # Determine audio bitrate to pass: if preset original -> probe source audio bitrate
            def _probe_audio_bitrate(path):
                try:
                    out = subprocess.check_output([
                        ffprobe_bin, '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=bit_rate',
                        '-of', 'default=noprint_wrappers=1:nokey=1', path
                    ]).decode().strip()
                    if out and out.isdigit():
                        return max(32, min(512, int(int(out) / 1000)))
                except Exception:
                    return 128
                return 128
            if audio_preset == 'original':
                resolved_audio_kbps = _probe_audio_bitrate(input_path)
            else:
                try:
                    resolved_audio_kbps = max(32, min(512, int(audio_kbps_form))) if audio_kbps_form else 128
                except Exception:
                    resolved_audio_kbps = 128

            threading.Thread(
                target=run_ffmpeg_segments,
                args=(input_path, keep_segments, crf, output_path, ffmpeg_bin),
                kwargs={
                    "mode": mode,
                    "quality_percent": quality_percent,
                    "target_size_mb": target_size_mb,
                    "audio_kbps": resolved_audio_kbps,
                    "resolution": resolution,
                    "width": int(width) if width else None,
                    "height": int(height) if height else None,
                    "video_codec": video_codec,
                    "audio_codec": audio_codec,
                    "container": container,
                }
            ).start()
        return render_index(video_filename=None)

    return render_index(video_filename=None)
    
if __name__ == "__main__":
    app.run(debug=True, port=5000)
