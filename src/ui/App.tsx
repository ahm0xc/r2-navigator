import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { S3Client } from "@aws-sdk/client-s3";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  createFolder,
  deleteEntry,
  downloadToFile,
  formatBytes,
  listLevel,
  uploadFile,
  type R2Entry,
} from "../lib/r2.js";

interface AppProps {
  client: S3Client;
}

type InputMode = "upload" | "mkdir" | null;

const DELETE_ARM_MS = 3000;

/** Rendered-row window: the list shows this many rows and grows as you scroll. */
const LIST_WINDOW_CHUNK = 100;

function parentPrefix(prefix: string): string {
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return "";
  return trimmed.slice(0, idx + 1);
}

function isAuthError(message: string): boolean {
  return /InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|403|401|Forbidden/i.test(
    message
  );
}

/** Recursively collect files under a dir. Returns absolute paths. */
async function collectFilesRecursively(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const dirents = await readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      const full = join(current, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
      } else if (dirent.isFile()) {
        out.push(full);
      }
      // Skip symlinks and other special files.
    }
  }
  return out.sort();
}

/** A file upload running in the background while the user keeps navigating. */
interface UploadTask {
  id: number;
  label: string;
  done: number;
  total: number;
  state: "active" | "done" | "error";
  message?: string;
}

export function App({ client }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [bucket, setBucket] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const [entries, setEntries] = useState<R2Entry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [visibleCount, setVisibleCount] = useState(LIST_WINDOW_CHUNK);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [armedDeleteAt, setArmedDeleteAt] = useState<number | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>(null);
  const [inputValue, setInputValue] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const uploadIdRef = useRef(0);
  // Live view refs so background uploads can refresh only if you're still there.
  const bucketRef = useRef<string | null>(bucket);
  const prefixRef = useRef(prefix);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (armedTimer.current) clearTimeout(armedTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    bucketRef.current = bucket;
    prefixRef.current = prefix;
  }, [bucket, prefix]);

  // Load current level.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCursor(0);
    setVisibleCount(LIST_WINDOW_CHUNK);
    setSelected(new Set());
    setArmedDeleteAt(null);
    listLevel(client, bucket, prefix)
      .then(({ entries: next, truncated: t }) => {
        if (cancelled) return;
        setEntries(next);
        setTruncated(t);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setEntries([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, bucket, prefix, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  /**
   * Upload files without blocking navigation. Progress lives in the status
   * footer; the current view refreshes on completion only if you're still
   * looking at the upload destination.
   */
  const runUploadInBackground = useCallback(
    (
      destBucket: string,
      destPrefix: string,
      items: { file: string; key: string }[],
      label: string
    ) => {
      const id = ++uploadIdRef.current;
      setUploads((prev) => [
        ...prev.slice(-4),
        { id, label, done: 0, total: items.length, state: "active" },
      ]);
      void (async () => {
        try {
          let done = 0;
          for (const item of items) {
            const data = await readFile(item.file);
            await uploadFile(client, destBucket, item.key, data);
            done += 1;
            setUploads((prev) =>
              prev.map((t) => (t.id === id ? { ...t, done } : t))
            );
          }
          setUploads((prev) =>
            prev.map((t) => (t.id === id ? { ...t, state: "done" } : t))
          );
          showToast(
            `Uploaded ${items.length} file${items.length === 1 ? "" : "s"} to ${label}.`
          );
          if (
            bucketRef.current === destBucket &&
            prefixRef.current === destPrefix
          ) {
            refresh();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setUploads((prev) =>
            prev.map((t) =>
              t.id === id ? { ...t, state: "error", message } : t
            )
          );
          showToast(`Upload to ${label} failed: ${message}`);
        } finally {
          setTimeout(() => {
            setUploads((prev) => prev.filter((t) => t.id !== id));
          }, 8000);
        }
      })();
    },
    [client, refresh, showToast]
  );

  const disarmDelete = useCallback(() => {
    setArmedDeleteAt(null);
    if (armedTimer.current) {
      clearTimeout(armedTimer.current);
      armedTimer.current = null;
    }
  }, []);

  const goBack = useCallback(() => {
    disarmDelete();
    if (prefix !== "") {
      setPrefix(parentPrefix(prefix));
    } else if (bucket !== null) {
      setBucket(null);
    } else {
      showToast("Already at the top — bucket list.");
    }
  }, [bucket, disarmDelete, prefix, showToast]);

  const enterEntry = useCallback(
    (entry: R2Entry | undefined) => {
      disarmDelete();
      if (!entry) return;
      if (entry.type === "bucket") {
        setBucket(entry.key);
        setPrefix("");
      } else if (entry.type === "folder") {
        setPrefix(entry.key);
      } else {
        showToast("That's a file — press o to download, Space to select.");
      }
    },
    [disarmDelete, showToast]
  );

  const toggleSelect = useCallback(
    (key: string) => {
      disarmDelete();
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [disarmDelete]
  );

  const toggleSelectAll = useCallback(() => {
    disarmDelete();
    setSelected((prev) => {
      if (prev.size === entries.length && entries.length > 0) return new Set();
      return new Set(entries.map((e) => e.key));
    });
  }, [disarmDelete, entries]);

  const performDelete = useCallback(
    async (targets: R2Entry[]) => {
      if (bucket === null) {
        showToast("Bucket deletion isn't supported here — use the dashboard.");
        return;
      }
      if (targets.length === 0) return;
      setBusy(
        `Deleting ${targets.length} item${targets.length === 1 ? "" : "s"}…`
      );
      try {
        let total = 0;
        for (const target of targets) {
          const { deleted } = await deleteEntry(client, bucket, target);
          total += deleted;
        }
        showToast(`Deleted ${total} object${total === 1 ? "" : "s"}.`);
        refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(`Delete failed: ${message}`);
      } finally {
        setBusy(null);
        disarmDelete();
      }
    },
    [bucket, client, disarmDelete, refresh, showToast]
  );

  const handleDeleteKey = useCallback(() => {
    const cursorEntry = entries[cursor];
    if (!cursorEntry || loading || busy || inputMode) return;
    const targets =
      selected.size > 0
        ? entries.filter((e) => selected.has(e.key))
        : [cursorEntry];
    const now = Date.now();
    if (armedDeleteAt !== null && now - armedDeleteAt < DELETE_ARM_MS) {
      void performDelete(targets);
    } else {
      setArmedDeleteAt(now);
      showToast(
        `Press ⌫ again to delete ${targets.length} item${targets.length === 1 ? "" : "s"} (Esc cancels).`
      );
      if (armedTimer.current) clearTimeout(armedTimer.current);
      armedTimer.current = setTimeout(() => setArmedDeleteAt(null), DELETE_ARM_MS);
    }
  }, [armedDeleteAt, busy, cursor, entries, inputMode, loading, performDelete, selected, showToast]);

  const handleDownload = useCallback(async () => {
    const cursorEntry = entries[cursor];
    const targets =
      selected.size > 0
        ? entries.filter((e) => selected.has(e.key))
        : cursorEntry
          ? [cursorEntry]
          : [];
    if (targets.length === 0 || bucket === null) {
      if (bucket === null) showToast("Enter a bucket first, then download files.");
      return;
    }
    const files = targets.filter((t) => t.type === "file");
    if (files.length !== targets.length) {
      showToast("Only files can be downloaded — enter folders to pick files.");
      return;
    }
    setBusy(`Downloading ${files.length} file${files.length === 1 ? "" : "s"}…`);
    try {
      for (const file of files) {
        const name = file.name.replace(/\/$/, "") || basename(file.key);
        await downloadToFile(client, bucket, file.key, join(process.cwd(), name));
      }
      showToast(`Downloaded ${files.length} file${files.length === 1 ? "" : "s"} to ${process.cwd()}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`Download failed: ${message}`);
    } finally {
      setBusy(null);
      disarmDelete();
    }
  }, [bucket, client, cursor, disarmDelete, entries, selected, showToast]);

  const submitInput = useCallback(
    async (value: string) => {
      const v = value.trim();
      setInputMode(null);
      setInputValue("");
      if (!v) return;
      if (bucket === null) {
        showToast("Enter a bucket first.");
        return;
      }
      if (inputMode === "mkdir") {
        const folderName = v.replace(/^\/+|\/+$/g, "");
        if (!folderName) return;
        setBusy(`Creating folder ${folderName}/…`);
        try {
          await createFolder(client, bucket, `${prefix}${folderName}`);
          showToast(`Created ${folderName}/.`);
          refresh();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          showToast(`Create folder failed: ${message}`);
        } finally {
          setBusy(null);
        }
        return;
      }
      // upload — accepts a file or a folder, runs in the background
      // so navigation stays interactive while files go up.
      const localPath = resolve(v.replace(/^~/, process.env.HOME ?? "~"));
      try {
        const st = await stat(localPath);
        if (st.isFile()) {
          const name = basename(localPath);
          runUploadInBackground(
            bucket,
            prefix,
            [{ file: localPath, key: `${prefix}${name}` }],
            name
          );
          showToast(`Uploading ${name} in the background…`);
          return;
        }
        if (!st.isDirectory()) {
          showToast("That path isn't a file or folder.");
          return;
        }
        // Folder: recreate it here as <current prefix>/<folder name>/ and
        // upload everything inside, preserving relative paths.
        const folderName = basename(localPath);
        const destPrefix = `${prefix}${folderName}/`;
        const files = await collectFilesRecursively(localPath);
        await createFolder(client, bucket, destPrefix);
        if (files.length === 0) {
          showToast(`Created empty folder ${folderName}/.`);
          refresh();
          return;
        }
        runUploadInBackground(
          bucket,
          destPrefix,
          files.map((file) => ({
            file,
            key: `${destPrefix}${relative(localPath, file).split(sep).join("/")}`,
          })),
          `${folderName}/`
        );
        showToast(
          `Uploading ${files.length} file${files.length === 1 ? "" : "s"} in the background…`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(`Upload failed: ${message}`);
      }
    },
    [bucket, client, inputMode, prefix, refresh, runUploadInBackground, showToast]
  );

  useInput((input, key) => {
    if (inputMode) {
      if (key.escape) {
        setInputMode(null);
        setInputValue("");
      }
      return;
    }
    if (key.upArrow || input === "k") {
      disarmDelete();
      setCursor((c) => (entries.length === 0 ? 0 : (c - 1 + entries.length) % entries.length));
    } else if (key.downArrow || input === "j") {
      disarmDelete();
      if (entries.length === 0) return;
      const next = (cursor + 1) % entries.length;
      setCursor(next);
      // Near the rendered edge? Grow the window so ↓ extends the list.
      if (next >= visibleCount - 10 && visibleCount < entries.length) {
        setVisibleCount(Math.min(entries.length, visibleCount + LIST_WINDOW_CHUNK));
      }
    } else if (key.pageDown) {
      disarmDelete();
      if (entries.length === 0) return;
      const next = Math.min(entries.length - 1, cursor + visibleCount);
      setCursor(next);
      if (next >= visibleCount - 10 && visibleCount < entries.length) {
        setVisibleCount(
          Math.min(entries.length, visibleCount + LIST_WINDOW_CHUNK * 2)
        );
      }
    } else if (key.pageUp) {
      disarmDelete();
      setCursor((c) => Math.max(0, c - visibleCount));
    } else if (key.rightArrow || input === "l" || key.return) {
      enterEntry(entries[cursor]);
    } else if (key.leftArrow || input === "h" || key.escape) {
      if (armedDeleteAt !== null) disarmDelete();
      else goBack();
    } else if (input === " ") {
      const entry = entries[cursor];
      if (entry) toggleSelect(entry.key);
    } else if (input === "a") {
      toggleSelectAll();
    } else if (key.backspace || key.delete) {
      handleDeleteKey();
    } else if (input === "u") {
      disarmDelete();
      if (bucket === null) {
        showToast("Enter a bucket first, then press u to upload.");
      } else {
        setInputValue("");
        setInputMode("upload");
      }
    } else if (input === "n") {
      disarmDelete();
      if (bucket === null) {
        showToast("Enter a bucket first, then press n for a new folder.");
      } else {
        setInputValue("");
        setInputMode("mkdir");
      }
    } else if (input === "o") {
      void handleDownload();
    } else if (input === "r") {
      disarmDelete();
      refresh();
    } else if (input === "q") {
      exit();
    }
  });

  const pathLabel =
    bucket === null ? "R2 / buckets" : `R2 / ${bucket} / ${prefix || ""}`;
  const visibleEntries = entries.slice(0, visibleCount);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold>r2n — R2 navigator</Text>
        <Text dimColor>{pathLabel}</Text>
        <Text>
          <Text color="cyan">[u] Upload</Text>
          <Text dimColor> · </Text>
          <Text color="cyan">[n] New folder</Text>
          <Text dimColor> · </Text>
          <Text color="cyan">[o] Download</Text>
          <Text dimColor> · </Text>
          <Text color="cyan">[r] Refresh</Text>
          {selected.size > 0 ? <Text> · {selected.size} selected</Text> : null}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} minHeight={8}>
        {loading || busy ? (
          <Text>
            <Text color="green">
              <Spinner type="dots" />
            </Text>
            <Text> {busy ?? "Loading… "}</Text>
          </Text>
        ) : error ? (
          <Box flexDirection="column">
            <Text color="red">Couldn't list here: {error}</Text>
            {isAuthError(error) ? (
              <Text dimColor>Check credentials — run `r2n auth --reset` then `r2n auth`.</Text>
            ) : (
              <Text dimColor>Press r to retry, ← to go back.</Text>
            )}
          </Box>
        ) : entries.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor>
              {bucket === null
                ? "No buckets yet — create one in the Cloudflare dashboard, then press r."
                : "Empty folder — press u to upload or n for a new folder."}
            </Text>
          </Box>
        ) : (
          visibleEntries.map((entry, i) => {
            const active = i === cursor;
            const checked = selected.has(entry.key);
            const icon =
              entry.type === "bucket" ? "🪣" : entry.type === "folder" ? "📁" : "📄";
            const meta =
              entry.type === "file"
                ? `  ${formatBytes(entry.size)}${entry.lastModified ? `  ${entry.lastModified.toISOString().slice(0, 10)}` : ""}`
                : "";
            return (
              <Text key={entry.key} bold={active} color={active ? "cyan" : undefined}>
                {active ? ">" : " "} [{checked ? "x" : " "}] {icon} {entry.name}
                <Text dimColor>{meta}</Text>
              </Text>
            );
          })
        )}
        {truncated && !loading ? (
          <Text dimColor>… list capped at 5,000 entries for v1.</Text>
        ) : null}
        {!loading && !busy && !error && visibleCount < entries.length ? (
          <Text dimColor>
            Showing {visibleCount} of {entries.length} — press ↓ for more (PgDn jumps).
          </Text>
        ) : null}
      </Box>

      {inputMode ? (
        <Box borderStyle="round" paddingX={1} marginTop={1} flexDirection="column">
          <Text bold>
            {inputMode === "upload"
              ? "Upload — file or folder path, Enter to send in background, Esc to cancel"
              : "New folder — type a name, Enter to create, Esc to cancel"}
          </Text>
          <TextInput
            value={inputValue}
            onChange={setInputValue}
            onSubmit={(v) => void submitInput(v)}
            placeholder={inputMode === "upload" ? "~/Downloads/photo.png or ~/Downloads/photos" : "photos/2026"}
          />
        </Box>
      ) : null}

      {toast && !inputMode ? (
        <Box marginTop={1}>
          <Text color={armedDeleteAt !== null ? "red" : "yellow"}>{toast}</Text>
        </Box>
      ) : null}

      {uploads.length > 0 ? (
        <Box borderStyle="round" paddingX={1} marginTop={1} flexDirection="column">
          {uploads.map((task) => (
            <Text key={task.id}>
              {task.state === "active" ? (
                <Text color="green">
                  <Spinner type="dots" />
                </Text>
              ) : task.state === "done" ? (
                <Text color="green">✓</Text>
              ) : (
                <Text color="red">✗</Text>
              )}
              <Text>
                {" "}
                {task.label} ({task.done}/{task.total})
                {task.state === "error" && task.message
                  ? ` — ${task.message}`
                  : ""}
              </Text>
            </Text>
          ))}
        </Box>
      ) : null}

      <Box borderStyle="single" paddingX={1} marginTop={1}>
        <Text dimColor>
          ↑↓ move · →/Enter open · ← back · Space select · a all · ⌫⌫ delete · u
          upload · n folder · o download · q quit
        </Text>
      </Box>
    </Box>
  );
}
