# Camera clips

Drop your own clips here, one per tile:

```
videos/
  cam1.mp4   -> Camera 1
  cam2.mp4   -> Camera 2
  cam3.mp4   -> Camera 3
  cam4.mp4   -> Camera 4
```

- Any format OpenCV/FFmpeg can read works (`.mp4` H.264 recommended). Rename the file or change
  `streams[].source.uri` in `backend/config.yaml` for other names or folders.
- Clips play at their native FPS and loop forever, to simulate a live camera.
- A missing file doesn't stop anything else. The tile shows **NO SIGNAL** and the backend checks
  every few seconds, so a file dropped in while the app is running is picked up automatically.
- Put the camera where workers are reasonably large in frame. People shorter than
  `compliance.min_person_height` px (at `inference.process_width`) are shown as *uncertain* and
  aren't judged.

To use live cameras instead, change only the tile's `source` in `backend/config.yaml`:

```yaml
source: { type: rtsp,   uri: "rtsp://user:pass@10.0.0.12:554/stream1" }
source: { type: webcam, uri: "0" }
source: { type: http,   uri: "http://10.0.0.13/video.mjpg" }
source: { type: images, uri: "D:/nvr_dump/cam5", fps: 5 }   # a folder of stills, looped
```
