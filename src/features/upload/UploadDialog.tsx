// Admin-only dialog for uploading audio files (or ZIP archives) directly to
// the music directory on the server. Only available in proxy mode with MUSIC_DIR
// configured. Uses XHR so we get real upload progress events.

import { createSignal, For, Show } from "solid-js";
import { client } from "~/auth/session";
import { Icon } from "~/ui/Icon";
import "./upload.css";

interface UploadFile {
  file: File;
  path: string; // relative path to preserve folder structure
}

type Phase = "idle" | "uploading" | "done" | "error";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const AUDIO_EXTS = new Set([
  "mp3", "flac", "ogg", "opus", "m4a", "aac", "wav", "wv", "ape",
  "mpc", "wma", "aiff", "aif", "dsf", "dff",
]);

function isAudioOrZip(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ext === "zip" || AUDIO_EXTS.has(ext);
}

function collectFiles(fileList: FileList): UploadFile[] {
  return Array.from(fileList)
    .filter(isAudioOrZip)
    .map((f) => ({
      file: f,
      // webkitRelativePath is set for folder uploads; fall back to the filename.
      path: (f as any).webkitRelativePath || f.name,
    }));
}

export function UploadDialog(props: { onClose: () => void }) {
  const [files, setFiles] = createSignal<UploadFile[]>([]);
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [progress, setProgress] = createSignal(0); // 0–100
  const [progressLabel, setProgressLabel] = createSignal("");
  const [result, setResult] = createSignal<{ written: string[]; scanStarted: boolean } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [dragOver, setDragOver] = createSignal(false);

  let audioInput: HTMLInputElement | undefined;
  let folderInput: HTMLInputElement | undefined;
  let zipInput: HTMLInputElement | undefined;

  function addFiles(list: FileList) {
    const next = collectFiles(list);
    if (next.length === 0) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path));
      return [...prev, ...next.filter((f) => !existing.has(f.path))];
    });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
  }

  function removeFile(path: string) {
    setFiles((prev) => prev.filter((f) => f.path !== path));
  }

  function uploadOne(uf: UploadFile, authHeaders: Record<string, string>): Promise<{ written: string[]; scanStarted: boolean }> {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append("file", uf.file);
      form.append("path", uf.path);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/upload");
      for (const [k, v] of Object.entries(authHeaders)) xhr.setRequestHeader(k, v);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve({ written: [uf.path], scanStarted: false });
          }
        } else {
          let msg = `HTTP ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error ?? msg; } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(form);
    });
  }

  async function startUpload() {
    const all = files();
    if (all.length === 0) return;

    const authHeaders = client()?.getUploadAuthHeaders() ?? {};
    setPhase("uploading");
    setError(null);
    setResult(null);

    const allWritten: string[] = [];
    let lastScan = false;

    try {
      for (let i = 0; i < all.length; i++) {
        const uf = all[i];
        setProgressLabel(`Uploading ${i + 1} of ${all.length}: ${uf.file.name}`);
        setProgress(0);
        const res = await uploadOne(uf, authHeaders);
        allWritten.push(...res.written);
        lastScan = res.scanStarted;
      }

      setResult({ written: allWritten, scanStarted: lastScan });
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setPhase("error");
    }
  }

  function reset() {
    setFiles([]);
    setPhase("idle");
    setProgress(0);
    setProgressLabel("");
    setResult(null);
    setError(null);
  }

  return (
    <div class="upload-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="upload-dialog" role="dialog" aria-modal="true" aria-label="Upload music">
        <div class="upload-head">
          <span class="upload-title">Upload Music</span>
          <button class="icon-btn" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        <Show when={phase() === "idle" || phase() === "error"}>
          {/* Drop zone */}
          <div
            class="upload-drop"
            classList={{ "upload-drop-active": dragOver() }}
            onClick={() => audioInput?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <Icon name="upload" size={28} class="upload-drop-icon" />
            <span class="upload-drop-label">Drop files here or click to browse</span>
            <span class="upload-drop-hint">Audio files (.mp3 .flac .ogg .m4a …) or a ZIP archive</span>
          </div>

          {/* Hidden inputs */}
          <input
            ref={audioInput}
            type="file"
            accept="audio/*,.flac,.ogg,.opus,.wv,.ape,.dsf,.dff"
            multiple
            style={{ display: "none" }}
            onChange={(e) => e.currentTarget.files && addFiles(e.currentTarget.files)}
          />
          <input
            ref={folderInput}
            type="file"
            // @ts-ignore
            webkitdirectory
            multiple
            style={{ display: "none" }}
            onChange={(e) => e.currentTarget.files && addFiles(e.currentTarget.files)}
          />
          <input
            ref={zipInput}
            type="file"
            accept=".zip"
            style={{ display: "none" }}
            onChange={(e) => e.currentTarget.files && addFiles(e.currentTarget.files)}
          />

          {/* Picker buttons */}
          <div class="upload-pickers">
            <button class="btn btn-ghost" onClick={(e) => { e.stopPropagation(); audioInput?.click(); }}>
              <Icon name="plus" size={15} /> Files
            </button>
            <button class="btn btn-ghost" onClick={(e) => { e.stopPropagation(); folderInput?.click(); }}>
              <Icon name="list" size={15} /> Folder
            </button>
            <button class="btn btn-ghost" onClick={(e) => { e.stopPropagation(); zipInput?.click(); }}>
              <Icon name="list" size={15} /> ZIP
            </button>
          </div>

          {/* File list */}
          <Show when={files().length > 0}>
            <div class="upload-file-list">
              <For each={files()}>
                {(uf) => (
                  <div class="upload-file-item">
                    <span class="upload-file-name" title={uf.path}>{uf.path}</span>
                    <span class="upload-file-size">{formatBytes(uf.file.size)}</span>
                    <button
                      class="icon-btn"
                      style={{ width: "24px", height: "24px" }}
                      onClick={() => removeFile(uf.path)}
                      aria-label={`Remove ${uf.file.name}`}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={error()}>
            <div class="upload-error" role="alert">{error()}</div>
          </Show>

          <div class="upload-actions">
            <button class="btn btn-ghost" onClick={props.onClose}>Cancel</button>
            <button
              class="btn btn-primary"
              disabled={files().length === 0}
              onClick={startUpload}
            >
              Upload {files().length > 0 ? `${files().length} file${files().length > 1 ? "s" : ""}` : ""}
            </button>
          </div>
        </Show>

        <Show when={phase() === "uploading"}>
          <div class="upload-progress-wrap">
            <span class="upload-progress-label">{progressLabel()}</span>
            <div class="upload-progress-bar">
              <div class="upload-progress-fill" style={{ width: `${progress()}%` }} />
            </div>
          </div>
        </Show>

        <Show when={phase() === "done"}>
          <div class="upload-result">
            <span class="upload-result-success">
              {result()!.written.length} file{result()!.written.length !== 1 ? "s" : ""} uploaded successfully
            </span>
            <span class="upload-result-detail">Files are in your music directory.</span>
            <Show when={result()!.scanStarted}>
              <span class="upload-result-scan">Library scan started — new tracks will appear shortly.</span>
            </Show>
            <Show when={!result()!.scanStarted}>
              <span class="upload-result-detail muted">Trigger a scan in Navidrome to see the new tracks.</span>
            </Show>
          </div>
          <div class="upload-actions">
            <button class="btn btn-ghost" onClick={reset}>Upload more</button>
            <button class="btn btn-primary" onClick={props.onClose}>Done</button>
          </div>
        </Show>
      </div>
    </div>
  );
}
