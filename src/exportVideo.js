// Re-renders a clip with its recorded dubs mixed in, in real time, and
// captures the result as a downloadable video file. No server, no
// ffmpeg — just <video>.captureStream() for the picture and a small Web
// Audio graph (one MediaElementSource per recorded line, routed into a
// MediaStreamDestination) for the sound, both fed into one MediaRecorder.

function pickSupportedMimeType() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return candidates.find((c) => window.MediaRecorder?.isTypeSupported?.(c)) || 'video/webm';
}

/**
 * @param {{ videoBlob: Blob, segments: Array<{id:string,start:number,end:number}> }} clip
 * @param {Map<string, Blob>} recordings segmentId -> recorded audio Blob
 * @param {{ onProgress?: (fraction: number) => void }} [opts]
 * @returns {Promise<Blob>} the exported video (webm)
 */
export async function exportDubbedVideo(clip, recordings, { onProgress } = {}) {
  const video = document.createElement('video');
  video.muted = true; // original dialogue stays silent; only the dubs (and gaps) are heard
  video.playsInline = true;
  const videoUrl = URL.createObjectURL(clip.videoBlob);
  video.src = videoUrl;

  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Não foi possível carregar o vídeo original.')), {
      once: true,
    });
  });

  const captureVideoStream = video.captureStream || video.mozCaptureStream;
  if (!captureVideoStream) {
    URL.revokeObjectURL(videoUrl);
    throw new Error('Este navegador não suporta exportação de vídeo (captureStream indisponível).');
  }

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const destination = audioCtx.createMediaStreamDestination();

  const videoStream = captureVideoStream.call(video);
  const combinedStream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...destination.stream.getAudioTracks(),
  ]);

  const recorder = new MediaRecorder(combinedStream, { mimeType: pickSupportedMimeType() });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const recordingDone = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
  });

  const triggered = new Set();
  const liveAudioEls = [];
  let rafId = null;

  function tick() {
    const t = video.currentTime;
    clip.segments.forEach((seg) => {
      if (t >= seg.start && t < seg.end && !triggered.has(seg.id)) {
        triggered.add(seg.id);
        const blob = recordings.get(seg.id);
        if (!blob) return;
        const audioEl = new Audio(URL.createObjectURL(blob));
        audioCtx.createMediaElementSource(audioEl).connect(destination);
        audioEl.play().catch(() => {});
        liveAudioEls.push(audioEl);
      }
    });
    rafId = requestAnimationFrame(tick);
  }

  video.addEventListener('timeupdate', () => {
    if (video.duration) onProgress?.(Math.min(1, video.currentTime / video.duration));
  });

  recorder.start();
  video.currentTime = 0;
  await video.play();
  tick();

  await new Promise((resolve) => video.addEventListener('ended', resolve, { once: true }));
  cancelAnimationFrame(rafId);
  recorder.stop();

  const resultBlob = await recordingDone;

  liveAudioEls.forEach((a) => {
    a.pause();
    URL.revokeObjectURL(a.src);
  });
  await audioCtx.close();
  URL.revokeObjectURL(videoUrl);
  onProgress?.(1);

  return resultBlob;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
