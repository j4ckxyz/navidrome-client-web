// Admin-only dialog for getting music into Navidrome's media directory. Two
// modes (proxy mode + MUSIC_DIR only):
//   • Upload   — push audio files / folders / ZIPs to the server. The server
//                files each track into a tag-derived "Artist - Album" folder.
//   • Organize — backfill: find files dumped loose in the media root and move
//                them into album folders, with a confirm-first preview.

import { createSignal, For, Show } from "solid-js";
import { client } from "~/auth/session";
import { Icon } from "~/ui/Icon";
import "./upload.css";

interface UploadFile {
  file: File;
  path: string; // relative path, used for de-duping the picked list
}

type Mode = "upload" | "organize";
type Phase = "idle" | "uploading" | "done" | "error";
type ScanPhase = "idle" | "scanning" | "ready" | "applying" | "done" | "error";

interface CleanupFile {
  name: string;
  size: number;
  hasTags: boolean;
}
interface CleanupGroup {
  folder: string;
  artist: string;
  album: string;
  hasTags: boolean;
  files: CleanupFile[];
}
interface ApplyResult {
  moved: string[];
  errors: { file: string; error: string }[];
  scanStarted: boolean;
}

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

// Read one drag-and-drop entry (a FileSystemFileEntry or DirectoryEntry) into
// flat [{ file, path }], walking directories recursively. `prefix` is the
// folder path accumulated so far (ends with "/" or is empty).
function readEntry(entry: any, prefix: string): Promise<{ file: File; path: string }[]> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file: File) => resolve([{ file, path: prefix + file.name }]),
        () => resolve([]),
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all: { file: File; path: string }[] = [];
      // readEntries returns results in batches; call until it yields none.
      const readBatch = () =>
        reader.readEntries(async (batch: any[]) => {
          if (batch.length === 0) {
            resolve(all);
            return;
          }
          for (const child of batch) {
            all.push(...(await readEntry(child, `${prefix}${entry.name}/`)));
          }
          readBatch();
        }, () => resolve(all));
      readBatch();
    } else {
      resolve([]);
    }
  });
}

// Turn dropped FileSystem entries (files and/or folders) into UploadFiles,
// keeping only audio/ZIP and preserving folder-relative paths.
async function readDroppedEntries(entries: any[]): Promise<UploadFile[]> {
  const out: { file: File; path: string }[] = [];
  for (const entry of entries) out.push(...(await readEntry(entry, "")));
  return out.filter((u) => isAudioOrZip(u.file)).map((u) => ({ file: u.file, path: u.path }));
}

export function UploadDialog(props: { onClose: () => void }) {
  const [mode, setMode] = createSignal<Mode>("upload");

  // ---- Upload state ----
  const [files, setFiles] = createSignal<UploadFile[]>([]);
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [progress, setProgress] = createSignal(0); // 0–100
  const [progressLabel, setProgressLabel] = createSignal("");
  const [result, setResult] = createSignal<{ written: string[]; scanStarted: boolean } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [dragOver, setDragOver] = createSignal(false);

  // ---- Organize state ----
  const [scanPhase, setScanPhase] = createSignal<ScanPhase>("idle");
  const [groups, setGroups] = createSignal<CleanupGroup[]>([]);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [scanError, setScanError] = createSignal<string | null>(null);
  const [applyResult, setApplyResult] = createSignal<ApplyResult | null>(null);

  let audioInput: HTMLInputElement | undefined;
  let folderInput: HTMLInputElement | undefined;
  let zipInput: HTMLInputElement | undefined;

  function addUploadFiles(next: UploadFile[]) {
    if (next.length === 0) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path));
      return [...prev, ...next.filter((f) => !existing.has(f.path))];
    });
  }

  function addFiles(list: FileList) {
    addUploadFiles(collectFiles(list));
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    if (!dt) return;

    // Prefer the entries API: it's the only reliable way to accept a dropped
    // *folder* (read recursively), and it works in WebKit/Safari where the
    // folder <input> picker silently returns nothing. Grab the entries
    // synchronously — DataTransfer is emptied once the handler yields.
    const entries = Array.from(dt.items ?? [])
      .map((it) => (it as any).webkitGetAsEntry?.() ?? null)
      .filter(Boolean);
    if (entries.length > 0) {
      const collected = await readDroppedEntries(entries);
      addUploadFiles(collected);
      return;
    }
    if (dt.files) addFiles(dt.files);
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

    const authHeaders = client()?.getServerAuthHeaders() ?? {};
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

  // ---- Organize actions ----

  async function scanLibrary() {
    setScanPhase("scanning");
    setScanError(null);
    setApplyResult(null);
    try {
      const res = await fetch("/cleanup/scan", {
        method: "POST",
        headers: client()?.getServerAuthHeaders() ?? {},
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error ?? msg; } catch {}
        throw new Error(msg);
      }
      const data = (await res.json()) as { groups: CleanupGroup[] };
      setGroups(data.groups);
      setSelected(new Set(data.groups.map((g) => g.folder))); // all on by default
      setExpanded(new Set<string>());
      setScanPhase("ready");
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed");
      setScanPhase("error");
    }
  }

  function toggleSelected(folder: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(folder) ? next.delete(folder) : next.add(folder);
      return next;
    });
  }

  function toggleExpanded(folder: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(folder) ? next.delete(folder) : next.add(folder);
      return next;
    });
  }

  function selectedFileCount(): number {
    return groups().reduce((n, g) => (selected().has(g.folder) ? n + g.files.length : n), 0);
  }

  async function applyCleanup() {
    const folders = [...selected()];
    if (folders.length === 0) return;
    setScanPhase("applying");
    setScanError(null);
    try {
      const res = await fetch("/cleanup/apply", {
        method: "POST",
        headers: { ...(client()?.getServerAuthHeaders() ?? {}), "Content-Type": "application/json" },
        body: JSON.stringify({ folders }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error ?? msg; } catch {}
        throw new Error(msg);
      }
      setApplyResult((await res.json()) as ApplyResult);
      setScanPhase("done");
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Organize failed");
      setScanPhase("error");
    }
  }

  function switchMode(next: Mode) {
    if (mode() === next) return;
    setMode(next);
    setError(null);
    setScanError(null);
  }

  return (
    <div class="upload-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="upload-dialog" role="dialog" aria-modal="true" aria-label="Manage music library">
        <div class="upload-head">
          <span class="upload-title">{mode() === "upload" ? "Upload Music" : "Organize Library"}</span>
          <button class="icon-btn" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* Mode tabs */}
        <div class="upload-tabs" role="tablist">
          <button
            class="upload-tab"
            classList={{ "upload-tab-active": mode() === "upload" }}
            role="tab"
            aria-selected={mode() === "upload"}
            onClick={() => switchMode("upload")}
          >
            <Icon name="upload" size={15} /> Upload
          </button>
          <button
            class="upload-tab"
            classList={{ "upload-tab-active": mode() === "organize" }}
            role="tab"
            aria-selected={mode() === "organize"}
            onClick={() => switchMode("organize")}
          >
            <Icon name="list" size={15} /> Organize
          </button>
        </div>

        {/* ===================== UPLOAD MODE ===================== */}
        <Show when={mode() === "upload"}>
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
              <span class="upload-drop-label">Drop files or a folder here, or click to browse</span>
              <span class="upload-drop-hint">Audio files (.mp3 .flac .ogg .m4a …), a whole folder, or a ZIP archive</span>
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

            <p class="upload-note">
              Files are filed into an <strong>“Artist – Album”</strong> folder automatically, based on
              their tags. Drop a loose pile and it still lands tidy.
            </p>

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
              <span class="upload-result-detail">Filed into album folders in your music directory.</span>
              <Show when={result()!.scanStarted}>
                <span class="upload-result-scan">Library scan started. New tracks will appear shortly.</span>
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
        </Show>

        {/* ===================== ORGANIZE MODE ===================== */}
        <Show when={mode() === "organize"}>
          <Show when={scanPhase() === "idle" || scanPhase() === "error"}>
            <p class="upload-note">
              Scans the <strong>root</strong> of your media folder for loose audio files and proposes an
              <strong> “Artist – Album”</strong> folder for each, grouped by tags. Existing folders are
              left untouched. Nothing moves until you confirm.
            </p>
            <Show when={scanError()}>
              <div class="upload-error" role="alert">{scanError()}</div>
            </Show>
            <div class="upload-actions">
              <button class="btn btn-ghost" onClick={props.onClose}>Cancel</button>
              <button class="btn btn-primary" onClick={scanLibrary}>
                <Icon name="list" size={15} /> Scan media folder
              </button>
            </div>
          </Show>

          <Show when={scanPhase() === "scanning"}>
            <div class="upload-progress-wrap">
              <span class="upload-progress-label">Scanning media folder &amp; reading tags…</span>
              <div class="upload-progress-bar">
                <div class="upload-progress-fill upload-progress-indeterminate" />
              </div>
            </div>
          </Show>

          <Show when={scanPhase() === "ready"}>
            <Show
              when={groups().length > 0}
              fallback={
                <>
                  <div class="upload-result">
                    <span class="upload-result-success">Nothing to organize</span>
                    <span class="upload-result-detail">
                      No loose files in the media root. Everything is already in folders.
                    </span>
                  </div>
                  <div class="upload-actions">
                    <button class="btn btn-ghost" onClick={() => setScanPhase("idle")}>Back</button>
                    <button class="btn btn-primary" onClick={props.onClose}>Done</button>
                  </div>
                </>
              }
            >
              <span class="upload-organize-summary">
                {selected().size} of {groups().length} album{groups().length !== 1 ? "s" : ""} selected
                · {selectedFileCount()} file{selectedFileCount() !== 1 ? "s" : ""} will move
              </span>

              <div class="upload-group-list">
                <For each={groups()}>
                  {(g) => (
                    <div class="upload-group" classList={{ "upload-group-off": !selected().has(g.folder) }}>
                      <div class="upload-group-head">
                        <label class="upload-group-check">
                          <input
                            type="checkbox"
                            checked={selected().has(g.folder)}
                            onChange={() => toggleSelected(g.folder)}
                          />
                        </label>
                        <button
                          class="upload-group-main"
                          onClick={() => toggleExpanded(g.folder)}
                          aria-expanded={expanded().has(g.folder)}
                        >
                          <Icon
                            name="chevron-right"
                            size={15}
                            class={`upload-group-chevron${expanded().has(g.folder) ? " upload-group-chevron-open" : ""}`}
                          />
                          <span class="upload-group-folder" title={g.folder}>
                            {g.folder}
                            <Show when={!g.hasTags}>
                              <span class="upload-group-tag-warn" title="No album/artist tags found">
                                {" "}· untagged
                              </span>
                            </Show>
                          </span>
                          <span class="upload-group-count">
                            {g.files.length} file{g.files.length !== 1 ? "s" : ""}
                          </span>
                        </button>
                      </div>

                      <Show when={expanded().has(g.folder)}>
                        <div class="upload-group-files">
                          <For each={g.files}>
                            {(f) => (
                              <div class="upload-group-file">
                                <span class="upload-group-file-path" title={`${f.name} → ${g.folder}/${f.name}`}>
                                  <span class="upload-group-file-from">{f.name}</span>
                                  <Icon name="chevron-right" size={12} class="upload-group-file-arrow" />
                                  <span class="upload-group-file-to">{g.folder}/{f.name}</span>
                                </span>
                                <span class="upload-file-size">{formatBytes(f.size)}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>

              <div class="upload-actions">
                <button class="btn btn-ghost" onClick={() => setScanPhase("idle")}>Back</button>
                <button class="btn btn-primary" disabled={selected().size === 0} onClick={applyCleanup}>
                  Organize {selected().size} album{selected().size !== 1 ? "s" : ""}
                </button>
              </div>
            </Show>
          </Show>

          <Show when={scanPhase() === "applying"}>
            <div class="upload-progress-wrap">
              <span class="upload-progress-label">Moving files into album folders…</span>
              <div class="upload-progress-bar">
                <div class="upload-progress-fill upload-progress-indeterminate" />
              </div>
            </div>
          </Show>

          <Show when={scanPhase() === "done"}>
            <div class="upload-result">
              <span class="upload-result-success">
                {applyResult()!.moved.length} file{applyResult()!.moved.length !== 1 ? "s" : ""} organized
              </span>
              <Show when={applyResult()!.errors.length > 0}>
                <span class="upload-result-detail muted">
                  {applyResult()!.errors.length} file{applyResult()!.errors.length !== 1 ? "s" : ""} skipped
                  (e.g. a target already existed).
                </span>
              </Show>
              <Show when={applyResult()!.scanStarted}>
                <span class="upload-result-scan">Library scan started. Navidrome will re-index shortly.</span>
              </Show>
              <Show when={!applyResult()!.scanStarted && applyResult()!.moved.length > 0}>
                <span class="upload-result-detail muted">Trigger a scan in Navidrome to re-index.</span>
              </Show>
            </div>
            <div class="upload-actions">
              <button class="btn btn-ghost" onClick={scanLibrary}>Scan again</button>
              <button class="btn btn-primary" onClick={props.onClose}>Done</button>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
