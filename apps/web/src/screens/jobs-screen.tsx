import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { JobOutputSnapshot, JobRecord } from "@droidagent/shared";

import { useDroidAgentApp } from "../app-context";
import { api, postJson } from "../lib/api";

export function JobsScreen() {
  const { dashboard, runAction, refreshDashboard } = useDroidAgentApp();
  const [commandInput, setCommandInput] = useState("pwd");
  const [jobCwdInput, setJobCwdInput] = useState(".");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const jobs = dashboard?.jobs ?? [];

  useEffect(() => {
    if (jobs.length === 0) {
      return;
    }
    if (!selectedJobId || !jobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(jobs[0]!.id);
    }
  }, [jobs, selectedJobId]);

  const outputQuery = useQuery({
    queryKey: ["jobs", selectedJobId, "output"],
    queryFn: () => api<JobOutputSnapshot>(`/api/jobs/${encodeURIComponent(selectedJobId ?? "")}/output`),
    enabled: Boolean(selectedJobId)
  });

  return (
    <section className="jobs-panel">
      <div className="panel-card">
        <h3>Run Job</h3>
        <label>
          Command
          <input value={commandInput} onChange={(event) => setCommandInput(event.target.value)} />
        </label>
        <label>
          Working directory
          <input value={jobCwdInput} onChange={(event) => setJobCwdInput(event.target.value)} />
        </label>
        <button
          onClick={() =>
            void runAction(async () => {
              const response = await postJson<{ jobId: string }>("/api/jobs", {
                command: commandInput,
                cwd: jobCwdInput
              });
              setSelectedJobId(response.jobId);
              await refreshDashboard();
            }, "Job started.")
          }
        >
          Run
        </button>
      </div>

      <div className="split-panel">
        <div className="stack-list">
          {jobs.map((job: JobRecord) => (
            <article
              key={job.id}
              className={`panel-card compact selectable${job.id === selectedJobId ? " active-card" : ""}`}
              onClick={() => setSelectedJobId(job.id)}
            >
              <strong>{job.command}</strong>
              <span>
                {job.status} • {job.cwd}
              </span>
              <small>{job.lastLine || "No output yet."}</small>
            </article>
          ))}
        </div>

        <div className="panel-card">
          <h3>Job Output</h3>
          {selectedJobId ? (
            <>
              <small>
                stdout {outputQuery.data?.stdoutBytes ?? 0} bytes • stderr {outputQuery.data?.stderrBytes ?? 0} bytes
              </small>
              <div className="stack-list job-output-grid">
                <section>
                  <strong>stdout</strong>
                  <pre className="viewer-panel">{outputQuery.data?.stdout || "No stdout yet."}</pre>
                </section>
                <section>
                  <strong>stderr</strong>
                  <pre className="viewer-panel">{outputQuery.data?.stderr || "No stderr yet."}</pre>
                </section>
              </div>
              {outputQuery.data?.truncated ? <small>Output was truncated at the safety ceiling.</small> : null}
            </>
          ) : (
            <small>Select a job to inspect live and replayed output.</small>
          )}
        </div>
      </div>
    </section>
  );
}
