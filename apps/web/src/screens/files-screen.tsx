import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { FileContent, FileConflictResponse, WorkspaceEntry } from "@droidagent/shared";

import { useAuthQuery, useDashboardQuery } from "../app-data";
import { useDroidAgentApp } from "../app-context";
import { clientPerformance } from "../lib/client-performance";
import { ApiError, api, postJson, putJson } from "../lib/api";

export function FilesScreen() {
  const queryClient = useQueryClient();
  const { runAction, setErrorMessage, setNotice } = useDroidAgentApp();
  const authQuery = useAuthQuery();
  const dashboardQuery = useDashboardQuery(Boolean(authQuery.data?.user));
  const dashboard = dashboardQuery.data;
  const [directoryPath, setDirectoryPath] = useState(".");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [loadedFile, setLoadedFile] = useState<FileContent | null>(null);
  const [dirty, setDirty] = useState(false);
  const [newDirectoryName, setNewDirectoryName] = useState("");
  const [conflict, setConflict] = useState<FileConflictResponse | null>(null);
  const trimmedNewDirectoryName = newDirectoryName.trim();
  const [fileOpenMetric, setFileOpenMetric] = useState<ReturnType<typeof clientPerformance.start> | null>(null);

  const filesQuery = useQuery({
    queryKey: ["files", directoryPath],
    queryFn: () => api<WorkspaceEntry[]>(`/api/files?path=${encodeURIComponent(directoryPath)}`),
    enabled: Boolean(authQuery.data?.user && dashboard?.setup?.workspaceRoot)
  });

  const fileQuery = useQuery({
    queryKey: ["file", selectedFile],
    queryFn: () => api<FileContent>(`/api/files/content?path=${encodeURIComponent(selectedFile ?? "")}`),
    enabled: Boolean(authQuery.data?.user && selectedFile)
  });

  useEffect(() => {
    if (!dirty && fileQuery.data) {
      setEditorValue(fileQuery.data.content);
      setLoadedFile(fileQuery.data);
      setConflict(null);
      fileOpenMetric?.finish({
        path: fileQuery.data.path,
        outcome: "ok"
      });
      setFileOpenMetric(null);
    }
  }, [dirty, fileOpenMetric, fileQuery.data]);

  useEffect(() => {
    if (!dirty) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [dirty]);

  async function saveFile(expectedModifiedAt: string | null): Promise<boolean> {
    if (!loadedFile) {
      return false;
    }

    const saveMetric = clientPerformance.start("client.file.save", {
      path: loadedFile.path
    });

    try {
      const saved = await putJson<FileContent>("/api/files/content", {
        path: loadedFile.path,
        content: editorValue,
        expectedModifiedAt
      });
      saveMetric.finish({
        outcome: "ok"
      });
      setLoadedFile(saved);
      setEditorValue(saved.content);
      setDirty(false);
      setConflict(null);
      queryClient.setQueryData(["file", loadedFile.path], saved);
      await queryClient.invalidateQueries({ queryKey: ["files", directoryPath] });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.payload) {
        saveMetric.finish({
          outcome: "conflict"
        });
        setConflict(error.payload as FileConflictResponse);
        return false;
      }
      saveMetric.finish({
        outcome: "error"
      });
      throw error;
    }
  }

  function openFilePath(filePath: string) {
    setFileOpenMetric(
      clientPerformance.start("client.file.open", {
        path: filePath,
      }),
    );
    setSelectedFile(filePath);
    setDirty(false);
  }

  async function createDraftFromFile(
    target: "memory" | "preferences" | "todayNote",
  ) {
    if (!loadedFile) {
      return;
    }

    await postJson("/api/memory/drafts", {
      target,
      title: loadedFile.path,
      content: editorValue.trim() || loadedFile.content.trim(),
      sourceKind: "fileSelection",
      sourceLabel: loadedFile.path,
      sourceRef: loadedFile.path,
    });
  }

  return (
    <section className="files-panel">
      {dashboard?.memory ? (
        <article className="panel-card compact files-context-card">
          <div>
            <strong>Workspace memory</strong>
            <small>
              {dashboard.memory.semanticReady
                ? `Semantic memory is live with ${dashboard.memory.embeddingModel ?? "local embeddings"}.`
                : "Prepare semantic memory to seed the workspace scaffold, preferences, and local embeddings."}
            </small>
          </div>
          <div className="button-row">
            <button
              className="secondary"
              onClick={() => setDirectoryPath(".")}
            >
              Workspace Root
            </button>
            <button
              className="secondary"
              onClick={() => openFilePath("PREFERENCES.md")}
            >
              Open PREFERENCES.md
            </button>
            <button
              className="secondary"
              onClick={() => openFilePath("MEMORY.md")}
            >
              Open MEMORY.md
            </button>
            <button
              className="secondary"
              onClick={() =>
                void runAction(async () => {
                  const note = await postJson<{ path: string }>(
                    "/api/memory/today-note",
                    {},
                  );
                  openFilePath(note.path);
                })
              }
            >
              Open Today&apos;s Note
            </button>
          </div>
        </article>
      ) : null}

      <div className="toolbar">
        <input value={directoryPath} onChange={(event) => setDirectoryPath(event.target.value)} />
        <button onClick={() => void filesQuery.refetch()}>Open</button>
      </div>

      <div className="button-row">
        <input value={newDirectoryName} onChange={(event) => setNewDirectoryName(event.target.value)} placeholder="new-folder" />
        <button
          className="secondary"
          disabled={!trimmedNewDirectoryName}
          onClick={() =>
            void runAction(async () => {
              const nextPath = directoryPath === "." ? trimmedNewDirectoryName : `${directoryPath}/${trimmedNewDirectoryName}`;
              await postJson("/api/files/directory", { path: nextPath });
              setNewDirectoryName("");
              await queryClient.invalidateQueries({ queryKey: ["files", directoryPath] });
            }, "Directory created.")
          }
        >
          Create Directory
        </button>
      </div>

      <div className="split-panel">
        <div className="list-panel">
          {filesQuery.isLoading ? (
            <article className="panel-card compact">Loading workspace files...</article>
          ) : null}
          {filesQuery.isError ? (
            <article className="panel-card compact conflict-card">
              Failed to load directory. Verify path and permissions.
            </article>
          ) : null}
          {!filesQuery.isLoading &&
          !filesQuery.isError &&
          (filesQuery.data ?? []).length === 0 ? (
            <article className="panel-card compact">No files found in this directory.</article>
          ) : null}
          {(filesQuery.data ?? []).map((entry: WorkspaceEntry) => (
            <button
              key={entry.path}
              className="file-row"
              onClick={() => {
                if (entry.kind === "directory") {
                  setDirectoryPath(entry.path);
                  setSelectedFile(null);
                  setDirty(false);
                  return;
                }
                openFilePath(entry.path);
              }}
            >
              <strong>{entry.name}</strong>
              <span>{entry.kind}</span>
            </button>
          ))}
        </div>

        <div className="editor-panel">
          {selectedFile && loadedFile ? (
            <>
              <div className="editor-toolbar">
                <div>
                  <strong>{loadedFile.path}</strong>
                  <small>
                    {loadedFile.mimeType} • {loadedFile.size} bytes
                  </small>
                </div>
                <div className="button-row">
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await createDraftFromFile("memory");
                      }, "File captured as a memory draft.")
                    }
                  >
                    Draft to Memory
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await createDraftFromFile("preferences");
                      }, "File captured as a preferences draft.")
                    }
                  >
                    Draft to Preferences
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await createDraftFromFile("todayNote");
                      }, "File captured as today's note draft.")
                    }
                  >
                    Draft to Today Note
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      if (fileQuery.data) {
                        setEditorValue(fileQuery.data.content);
                        setLoadedFile(fileQuery.data);
                        setDirty(false);
                      }
                    }}
                  >
                    Revert
                  </button>
                    <button
                      onClick={() =>
                        void (async () => {
                          setErrorMessage(null);
                          try {
                            const saved = await saveFile(conflict?.currentModifiedAt ?? loadedFile.modifiedAt);
                            if (saved) {
                              setNotice(conflict ? "Remote copy overwritten." : "File saved.");
                            }
                          } catch (error) {
                            setErrorMessage(error instanceof Error ? error.message : "File save failed.");
                          }
                        })()
                      }
                    >
                    {conflict ? "Overwrite Remote Copy" : "Save"}
                  </button>
                </div>
              </div>
              <textarea
                className="editor-textarea"
                value={editorValue}
                onChange={(event) => {
                  setEditorValue(event.target.value);
                  setDirty(event.target.value !== (loadedFile?.content ?? ""));
                }}
              />
              {dirty ? <small>Unsaved changes</small> : null}
              {loadedFile.truncated ? <small>Large file preview truncated to the editable ceiling.</small> : null}
              {conflict ? (
                <article className="panel-card compact conflict-card">
                  <strong>Remote file changed on disk</strong>
                  <small>The copy on disk was modified at {new Date(conflict.currentModifiedAt).toLocaleString()}.</small>
                  <div className="button-row">
                    <button
                      className="secondary"
                      onClick={() =>
                        void runAction(async () => {
                          const refreshed = await fileQuery.refetch();
                          if (refreshed.data) {
                            setLoadedFile(refreshed.data);
                            setEditorValue(refreshed.data.content);
                            setDirty(false);
                            setConflict(null);
                          }
                        }, "Reloaded remote file.")
                      }
                    >
                      Reload Remote Copy
                    </button>
                    <button
                      onClick={() =>
                        void (async () => {
                          setErrorMessage(null);
                          try {
                            const saved = await saveFile(conflict.currentModifiedAt);
                            if (saved) {
                              setNotice("Remote copy overwritten.");
                            }
                          } catch (error) {
                            setErrorMessage(error instanceof Error ? error.message : "File overwrite failed.");
                          }
                        })()
                      }
                    >
                      Overwrite Anyway
                    </button>
                  </div>
                </article>
              ) : null}
            </>
          ) : (
            <div className="viewer-panel">
              {fileQuery.isLoading
                ? "Loading file..."
                : fileQuery.isError
                  ? "Failed to load file. Select another file or retry."
                  : "Select a text file to open it."}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
