import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { FileContent, WorkspaceEntry } from "@droidagent/shared";

import { useDroidAgentApp } from "../app-context";
import { api, postJson, putJson } from "../lib/api";

export function FilesScreen() {
  const queryClient = useQueryClient();
  const { authQuery, dashboard, runAction, refreshDashboard } = useDroidAgentApp();
  const [directoryPath, setDirectoryPath] = useState(".");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [loadedFile, setLoadedFile] = useState<FileContent | null>(null);
  const [dirty, setDirty] = useState(false);
  const [newDirectoryName, setNewDirectoryName] = useState("");

  const filesQuery = useQuery({
    queryKey: ["files", directoryPath],
    queryFn: () => api<WorkspaceEntry[]>(`/api/files?path=${encodeURIComponent(directoryPath)}`),
    enabled: Boolean(authQuery.data?.user && dashboard?.setup.workspaceRoot)
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
    }
  }, [dirty, fileQuery.data]);

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

  return (
    <section className="files-panel">
      <div className="toolbar">
        <input value={directoryPath} onChange={(event) => setDirectoryPath(event.target.value)} />
        <button onClick={() => void filesQuery.refetch()}>Open</button>
      </div>

      <div className="button-row">
        <input value={newDirectoryName} onChange={(event) => setNewDirectoryName(event.target.value)} placeholder="new-folder" />
        <button
          className="secondary"
          onClick={() =>
            void runAction(async () => {
              const nextPath = directoryPath === "." ? newDirectoryName : `${directoryPath}/${newDirectoryName}`;
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
                setSelectedFile(entry.path);
                setDirty(false);
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
                      void runAction(async () => {
                        const saved = await putJson<FileContent>("/api/files/content", {
                          path: loadedFile.path,
                          content: editorValue,
                          expectedModifiedAt: loadedFile.modifiedAt
                        });
                        setLoadedFile(saved);
                        setEditorValue(saved.content);
                        setDirty(false);
                        queryClient.setQueryData(["file", loadedFile.path], saved);
                        await queryClient.invalidateQueries({ queryKey: ["files", directoryPath] });
                        await refreshDashboard();
                      }, "File saved.")
                    }
                  >
                    Save
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
            </>
          ) : (
            <pre className="viewer-panel">Select a text file to open it.</pre>
          )}
        </div>
      </div>
    </section>
  );
}
