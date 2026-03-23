import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useState
} from "react";
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON as BrowserRegistrationOptions,
  type PublicKeyCredentialRequestOptionsJSON as BrowserAuthenticationOptions
} from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  FolderTree,
  Hammer,
  MessagesSquare,
  Radio,
  Settings2
} from "lucide-react";

import type {
  ChatMessage,
  ChannelStatus,
  CloudProviderSummary,
  DashboardState,
  JobRecord,
  ProviderProfile,
  RuntimeStatus,
  ServerEvent,
  SessionSummary,
  WorkspaceEntry
} from "@droidagent/shared";

import { api, postJson } from "./lib/api";

type TabId = "chat" | "files" | "jobs" | "models" | "channels" | "settings";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const navItems: Array<{ id: TabId; label: string; icon: typeof MessagesSquare }> = [
  { id: "chat", label: "Chat", icon: MessagesSquare },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "jobs", label: "Jobs", icon: Hammer },
  { id: "models", label: "Models", icon: Bot },
  { id: "channels", label: "Channels", icon: Radio },
  { id: "settings", label: "Settings", icon: Settings2 }
];

interface AuthState {
  user: { id: string; username: string; displayName: string } | null;
  hasUser: boolean;
}

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabId>("chat");
  const [selectedSessionId, setSelectedSessionId] = useState("main");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [directoryPath, setDirectoryPath] = useState(".");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [workspaceInput, setWorkspaceInput] = useState(".");
  const [commandInput, setCommandInput] = useState("pwd");
  const [jobCwdInput, setJobCwdInput] = useState(".");
  const [signalPhone, setSignalPhone] = useState("");
  const [signalCaptcha, setSignalCaptcha] = useState("");
  const [signalVerificationCode, setSignalVerificationCode] = useState("");
  const [signalVerificationPin, setSignalVerificationPin] = useState("");
  const [signalDeviceName, setSignalDeviceName] = useState("DroidAgent");
  const [pairingCode, setPairingCode] = useState("");
  const [setupModel, setSetupModel] = useState("gpt-oss:20b");
  const [llamaModel, setLlamaModel] = useState("gemma-3-1b-it");
  const [providerApiKeys, setProviderApiKeys] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const deferredMessages = useDeferredValue(messages);

  const authQuery = useQuery({
    queryKey: ["auth"],
    queryFn: () => api<AuthState>("/api/auth/me")
  });

  const dashboardQuery = useQuery<DashboardState>({
    queryKey: ["dashboard"],
    queryFn: () => api<DashboardState>("/api/dashboard"),
    enabled: Boolean(authQuery.data?.user)
  });

  const filesQuery = useQuery<WorkspaceEntry[]>({
    queryKey: ["files", directoryPath],
    queryFn: () => api<WorkspaceEntry[]>(`/api/files?path=${encodeURIComponent(directoryPath)}`),
    enabled: Boolean(authQuery.data?.user && dashboardQuery.data?.setup.workspaceRoot)
  });

  const fileContentQuery = useQuery<{ content: string }>({
    queryKey: ["file", selectedFile],
    queryFn: () => api<{ content: string }>(`/api/files/content?path=${encodeURIComponent(selectedFile ?? "")}`),
    enabled: Boolean(authQuery.data?.user && selectedFile)
  });

  const dashboard = dashboardQuery.data;
  const sessions = dashboard?.sessions ?? [];
  const signal = dashboard?.channelConfig.signal;

  const setProviderKey = useEffectEvent((providerId: string, value: string) => {
    setProviderApiKeys((current) => ({
      ...current,
      [providerId]: value
    }));
  });

  const setProviderModel = useEffectEvent((providerId: string, value: string) => {
    setProviderModels((current) => ({
      ...current,
      [providerId]: value
    }));
  });

  const refreshDashboard = useEffectEvent(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["files", directoryPath] })
    ]);
  });

  const runAction = useEffectEvent(async (work: () => Promise<void>, successMessage?: string) => {
    setErrorMessage(null);
    try {
      await work();
      if (successMessage) {
        setNotice(successMessage);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "DroidAgent action failed.");
    }
  });

  const loadSession = useEffectEvent(async (sessionId: string) => {
    const sessionMessages = await api<ChatMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    startTransition(() => {
      setSelectedSessionId(sessionId);
      setMessages(sessionMessages);
    });
  });

  useEffect(() => {
    if (!authQuery.data?.user) {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });

    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as ServerEvent;
      if (payload.type === "dashboard.state") {
        queryClient.setQueryData(["dashboard"], payload.payload);
        return;
      }
      if (payload.type === "chat.history" && payload.payload.sessionId === selectedSessionId) {
        setMessages(payload.payload.messages);
        return;
      }
      if (payload.type === "error") {
        setErrorMessage(payload.payload.message);
      }
    };
    return () => socket.close();
  }, [authQuery.data?.user, queryClient, selectedSessionId]);

  useEffect(() => {
    if (sessions.length === 0) {
      return;
    }
    const active = sessions.find((session: SessionSummary) => session.id === selectedSessionId) ?? sessions[0];
    if (!active) {
      return;
    }
    void loadSession(active.id);
  }, [sessions, selectedSessionId, loadSession]);

  useEffect(() => {
    if (!dashboard?.setup.workspaceRoot) {
      return;
    }
    setWorkspaceInput(dashboard.setup.workspaceRoot);
  }, [dashboard?.setup.workspaceRoot]);

  const summaryCards = useMemo(() => {
    const setup = dashboard?.setup;
    const runtimeCount = dashboard?.runtimes.filter((runtime: RuntimeStatus) => runtime.state === "running").length ?? 0;
    return [
      { label: "Setup", value: `${setup?.completedSteps.length ?? 0}/11 steps` },
      { label: "Live Runtimes", value: String(runtimeCount) },
      { label: "LaunchAgent", value: dashboard?.launchAgent.running ? "Running" : dashboard?.launchAgent.installed ? "Loaded" : "Off" }
    ];
  }, [dashboard]);

  async function handleRegister() {
    setErrorMessage(null);
    const options = await postJson<PublicKeyCredentialCreationOptionsJSON>("/api/auth/register/options", {});
    const response = await startRegistration({ optionsJSON: options as BrowserRegistrationOptions });
    await postJson("/api/auth/register/verify", response);
    await queryClient.invalidateQueries({ queryKey: ["auth"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  async function handleLogin() {
    setErrorMessage(null);
    const options = await postJson<PublicKeyCredentialRequestOptionsJSON>("/api/auth/login/options", {});
    const response = await startAuthentication({ optionsJSON: options as BrowserAuthenticationOptions });
    await postJson("/api/auth/login/verify", response);
    await queryClient.invalidateQueries({ queryKey: ["auth"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  async function handleSendChat() {
    if (!chatInput.trim()) {
      return;
    }
    await postJson(`/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`, {
      text: chatInput
    });
    setChatInput("");
    await loadSession(selectedSessionId);
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  if (authQuery.isLoading) {
    return <main className="app-shell loading">Loading DroidAgent…</main>;
  }

  if (!authQuery.data?.user) {
    return (
      <main className="auth-screen">
        <section className="hero-card">
          <div className="hero-kicker">DroidAgent</div>
          <h1>Mobile-first control for OpenClaw on your own Mac.</h1>
          <p>
            Passkey login, Ollama-first local setup, advanced llama.cpp mode, Keychain-backed cloud providers, and
            optional Signal ingress through a local `signal-cli` daemon.
          </p>
          {errorMessage ? <p className="status-banner error">{errorMessage}</p> : null}
          <div className="hero-actions">
            {authQuery.data?.hasUser ? (
              <button onClick={() => void handleLogin()}>Sign in with Passkey</button>
            ) : (
              <button onClick={() => void handleRegister()}>Create Owner Passkey</button>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">DroidAgent</div>
          <h1>Operator Console</h1>
        </div>
        <button
          className="ghost-button"
          onClick={async () => {
            await postJson("/api/auth/logout", {});
            await queryClient.invalidateQueries({ queryKey: ["auth"] });
          }}
        >
          Sign out
        </button>
      </header>

      {notice ? <section className="status-banner success">{notice}</section> : null}
      {errorMessage ? <section className="status-banner error">{errorMessage}</section> : null}

      <section className="summary-grid">
        {summaryCards.map((card) => (
          <article key={card.label} className="summary-card">
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </article>
        ))}
      </section>

      {dashboard && dashboard.setup.completedSteps.length < 6 ? (
        <section className="setup-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Onboarding</div>
              <h2>Lock in the host before daily use</h2>
            </div>
          </div>
          <div className="setup-grid">
            <article className="panel-card">
              <h3>Workspace Root</h3>
              <p>Choose the directory DroidAgent can browse and run jobs inside.</p>
              <input value={workspaceInput} onChange={(event) => setWorkspaceInput(event.target.value)} />
              <button
                onClick={() =>
                  void runAction(async () => {
                    await postJson("/api/setup/workspace", {
                      workspaceRoot: workspaceInput
                    });
                    await refreshDashboard();
                  }, "Workspace updated.")
                }
              >
                Save Workspace
              </button>
            </article>

            <article className="panel-card">
              <h3>Default Runtime</h3>
              <p>Ollama is the default path. llama.cpp stays available as the advanced route.</p>
              <div className="button-row">
                <button
                  onClick={() =>
                    void runAction(async () => {
                      await postJson("/api/setup/runtime", { runtimeId: "ollama" });
                      await refreshDashboard();
                    }, "Ollama installed and started.")
                  }
                >
                  Install + Start Ollama
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    void runAction(async () => {
                      await postJson("/api/setup/runtime", { runtimeId: "llamaCpp" });
                      await refreshDashboard();
                    }, "llama.cpp installed.")
                  }
                >
                  Install llama.cpp
                </button>
              </div>
            </article>

            <article className="panel-card">
              <h3>Model Pull</h3>
              <p>Pick the default Ollama model or the advanced llama.cpp preset.</p>
              <div className="field-stack">
                <label>
                  Ollama model
                  <input value={setupModel} onChange={(event) => setSetupModel(event.target.value)} />
                </label>
                <button
                  onClick={() =>
                    void runAction(async () => {
                      await postJson("/api/setup/model", {
                        runtimeId: "ollama",
                        modelId: setupModel
                      });
                      await refreshDashboard();
                    }, "Ollama model pulled.")
                  }
                >
                  Pull Ollama Model
                </button>
              </div>
              <div className="field-stack">
                <label>
                  llama.cpp preset
                  <select value={llamaModel} onChange={(event) => setLlamaModel(event.target.value)}>
                    <option value="gemma-3-1b-it">Gemma 3 1B IT</option>
                    <option value="qwen3-8b-instruct">Qwen3 8B Instruct</option>
                  </select>
                </label>
                <button
                  className="secondary"
                  onClick={() =>
                    void runAction(async () => {
                      await postJson("/api/runtime/llamaCpp/models", {
                        modelId: llamaModel
                      });
                      await refreshDashboard();
                    }, "llama.cpp provider updated.")
                  }
                >
                  Select llama.cpp Preset
                </button>
              </div>
            </article>
          </div>
        </section>
      ) : null}

      <section className="main-layout">
        <div className="content-panel">
          {tab === "chat" ? (
            <section className="chat-panel">
              <aside className="session-strip">
                {sessions.map((session: SessionSummary) => (
                  <button
                    key={session.id}
                    className={classNames("session-pill", session.id === selectedSessionId && "active")}
                    onClick={() => void loadSession(session.id)}
                  >
                    <strong>{session.title}</strong>
                    <span>{session.lastMessagePreview || "No messages yet"}</span>
                  </button>
                ))}
              </aside>
              <div className="chat-thread">
                {deferredMessages.map((message) => (
                  <article key={message.id} className={classNames("message-card", message.role)}>
                    <header>{message.role}</header>
                    <p>{message.text}</p>
                  </article>
                ))}
              </div>
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runAction(handleSendChat);
                }}
              >
                <textarea
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="Send a message to the current OpenClaw session…"
                />
                <button type="submit">Send</button>
              </form>
            </section>
          ) : null}

          {tab === "files" ? (
            <section className="files-panel">
              <div className="toolbar">
                <input value={directoryPath} onChange={(event) => setDirectoryPath(event.target.value)} />
                <button onClick={() => void filesQuery.refetch()}>Open</button>
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
                        } else {
                          setSelectedFile(entry.path);
                        }
                      }}
                    >
                      <strong>{entry.name}</strong>
                      <span>{entry.kind}</span>
                    </button>
                  ))}
                </div>
                <pre className="viewer-panel">{fileContentQuery.data?.content ?? "Select a file to preview it."}</pre>
              </div>
            </section>
          ) : null}

          {tab === "jobs" ? (
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
                      await postJson("/api/jobs", {
                        command: commandInput,
                        cwd: jobCwdInput
                      });
                      await refreshDashboard();
                    }, "Job started.")
                  }
                >
                  Run
                </button>
              </div>
              <div className="stack-list">
                {(dashboard?.jobs ?? []).map((job: JobRecord) => (
                  <article key={job.id} className="panel-card compact">
                    <strong>{job.command}</strong>
                    <span>{job.status}</span>
                    <small>{job.lastLine || job.cwd}</small>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {tab === "models" ? (
            <section className="stack-list">
              {(dashboard?.runtimes ?? []).map((runtime: RuntimeStatus) => (
                <article key={runtime.id} className="panel-card">
                  <h3>{runtime.label}</h3>
                  <p>{runtime.healthMessage}</p>
                  <div className="button-row">
                    {!runtime.installed && runtime.id !== "openclaw" ? (
                      <button
                        onClick={() =>
                          void runAction(async () => {
                            await postJson(`/api/runtime/${runtime.id}/install`, {});
                            await refreshDashboard();
                          }, `${runtime.label} installed.`)
                        }
                      >
                        Install
                      </button>
                    ) : null}
                    <button
                      className="secondary"
                      onClick={() =>
                        void runAction(async () => {
                          await postJson(`/api/runtime/${runtime.id}/start`, {});
                          await refreshDashboard();
                        }, `${runtime.label} start requested.`)
                      }
                    >
                      Start
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        void runAction(async () => {
                          await postJson(`/api/runtime/${runtime.id}/stop`, {});
                          await refreshDashboard();
                        }, `${runtime.label} stop requested.`)
                      }
                    >
                      Stop
                    </button>
                  </div>
                </article>
              ))}
              {(dashboard?.providers ?? []).map((provider: ProviderProfile) => (
                <article key={provider.id} className={classNames("panel-card compact", provider.enabled && "active-card")}>
                  <strong>{provider.label}</strong>
                  <span>{provider.model}</span>
                  <small>{provider.healthMessage}</small>
                </article>
              ))}
            </section>
          ) : null}

          {tab === "channels" ? (
            <section className="stack-list">
              {(dashboard?.channels ?? []).map((channel: ChannelStatus) => (
                <article key={channel.id} className="panel-card">
                  <h3>{channel.label}</h3>
                  <p>{channel.healthMessage}</p>
                </article>
              ))}

              <article className="panel-card">
                <h3>Signal Runtime</h3>
                <p>
                  Install `signal-cli`, then either register a dedicated number or link an existing Signal account. The
                  web app remains primary; Signal is a paired owner ingress.
                </p>
                <div className="button-row">
                  <button
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/channels/signal/install", {});
                        await refreshDashboard();
                      }, "signal-cli installed or repaired.")
                    }
                  >
                    Install or Repair signal-cli
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/channels/signal/daemon/start", {});
                        await refreshDashboard();
                      }, "Signal daemon started.")
                    }
                  >
                    Start Daemon
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/channels/signal/daemon/stop", {});
                        await refreshDashboard();
                      }, "Signal daemon stopped.")
                    }
                  >
                    Stop Daemon
                  </button>
                </div>
                <pre>{JSON.stringify(signal ?? {}, null, 2)}</pre>
              </article>

              <article className="panel-card">
                <h3>Register Dedicated Number</h3>
                <label>
                  Phone number
                  <input value={signalPhone} onChange={(event) => setSignalPhone(event.target.value)} placeholder="+15555550123" />
                </label>
                <label>
                  Captcha token
                  <input
                    value={signalCaptcha}
                    onChange={(event) => setSignalCaptcha(event.target.value)}
                    placeholder="Optional, only when Signal requests one"
                  />
                </label>
                <div className="button-row">
                  <button
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/channels/signal/register/start", {
                          phoneNumber: signalPhone,
                          captcha: signalCaptcha || undefined,
                          autoInstall: true
                        });
                        await refreshDashboard();
                      }, "Signal registration started. Enter the SMS or voice code next.")
                    }
                  >
                    Register via SMS
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/channels/signal/register/start", {
                          phoneNumber: signalPhone,
                          useVoice: true,
                          captcha: signalCaptcha || undefined,
                          autoInstall: true
                        });
                        await refreshDashboard();
                      }, "Voice verification requested.")
                    }
                  >
                    Use Voice Call
                  </button>
                </div>
                <div className="field-stack">
                  <label>
                    Verification code
                    <input
                      value={signalVerificationCode}
                      onChange={(event) => setSignalVerificationCode(event.target.value)}
                      placeholder="123-456"
                    />
                  </label>
                  <label>
                    Registration lock PIN
                    <input
                      value={signalVerificationPin}
                      onChange={(event) => setSignalVerificationPin(event.target.value)}
                      placeholder="Optional"
                    />
                  </label>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/channels/signal/register/verify", {
                          verificationCode: signalVerificationCode,
                          pin: signalVerificationPin || undefined
                        });
                        await refreshDashboard();
                      }, "Signal account verified.")
                    }
                  >
                    Verify Registration
                  </button>
                </div>
              </article>

              <article className="panel-card">
                <h3>Link Existing Signal App</h3>
                <label>
                  Device name
                  <input value={signalDeviceName} onChange={(event) => setSignalDeviceName(event.target.value)} />
                </label>
                <div className="button-row">
                  <button
                    onClick={() =>
                      void runAction(async () => {
                        const response = await postJson<{ linkUri: string }>("/api/channels/signal/link/start", {
                          deviceName: signalDeviceName
                        });
                        setNotice(`Scan the QR in your Signal app. Link URI: ${response.linkUri}`);
                        await refreshDashboard();
                      })
                    }
                  >
                    Start Link Flow
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/channels/signal/link/cancel", {});
                        await refreshDashboard();
                      }, "Signal link flow cancelled.")
                    }
                  >
                    Cancel Link
                  </button>
                </div>
                {signal?.linkUri ? <pre>{signal.linkUri}</pre> : null}
              </article>

              <article className="panel-card">
                <h3>OpenClaw Pairing</h3>
                <p>Inbound Signal DMs stay on pairing mode by default. Approve the pairing code after the first contact.</p>
                <input value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} placeholder="Pairing code" />
                <div className="button-row">
                  <button
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/channels/signal/pairing/approve", {
                          code: pairingCode
                        });
                        await refreshDashboard();
                      }, "Signal pairing approved.")
                    }
                  >
                    Approve Pairing
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/channels/signal/disconnect", {
                          unregister: false,
                          clearLocalData: true
                        });
                        await refreshDashboard();
                      }, "Signal channel disconnected and local data cleared.")
                    }
                  >
                    Disconnect Signal
                  </button>
                </div>
              </article>
            </section>
          ) : null}

          {tab === "settings" ? (
            <section className="stack-list">
              <article className="panel-card">
                <h3>Workspace</h3>
                <p>{dashboard?.setup.workspaceRoot ?? "Not configured yet."}</p>
              </article>

              <article className="panel-card">
                <h3>LaunchAgent</h3>
                <p>{dashboard?.launchAgent.healthMessage}</p>
                <pre>{JSON.stringify(dashboard?.launchAgent ?? {}, null, 2)}</pre>
                <div className="button-row">
                  <button
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/service/launch-agent/install", {});
                        await refreshDashboard();
                      }, "LaunchAgent plist installed.")
                    }
                  >
                    Install
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/service/launch-agent/start", {});
                        await refreshDashboard();
                      }, "LaunchAgent start requested.")
                    }
                  >
                    Start
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/service/launch-agent/stop", {});
                        await refreshDashboard();
                      }, "LaunchAgent stop requested.")
                    }
                  >
                    Stop
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void runAction(async () => {
                        await postJson("/api/service/launch-agent/uninstall", {});
                        await refreshDashboard();
                      }, "LaunchAgent removed.")
                    }
                  >
                    Uninstall
                  </button>
                </div>
              </article>

              <article className="panel-card">
                <h3>Cloud Providers</h3>
                <p>API keys are stored in the macOS login keychain. Only provider metadata stays inside DroidAgent.</p>
                <div className="stack-list">
                  {(dashboard?.cloudProviders ?? []).map((provider: CloudProviderSummary) => {
                    const apiKey = providerApiKeys[provider.id] ?? "";
                    const defaultModel = providerModels[provider.id] ?? provider.defaultModel ?? "";
                    return (
                      <article key={provider.id} className={classNames("panel-card compact", provider.active && "active-card")}>
                        <strong>{provider.label}</strong>
                        <small>{provider.healthMessage}</small>
                        <label>
                          API key
                          <input
                            type="password"
                            value={apiKey}
                            onChange={(event) => setProviderKey(provider.id, event.target.value)}
                            placeholder={provider.stored ? "Stored in Keychain" : provider.envVar}
                          />
                        </label>
                        <label>
                          Default model
                          <input
                            value={defaultModel}
                            onChange={(event) => setProviderModel(provider.id, event.target.value)}
                            placeholder={provider.defaultModel ?? ""}
                          />
                        </label>
                        <div className="button-row">
                          <button
                            onClick={() =>
                              void runAction(async () => {
                                await postJson("/api/providers/secrets", {
                                  providerId: provider.id,
                                  apiKey,
                                  defaultModel
                                });
                                setProviderKey(provider.id, "");
                                await refreshDashboard();
                              }, `${provider.label} key stored in Keychain.`)
                            }
                          >
                            Save Secret
                          </button>
                          <button
                            className="secondary"
                            onClick={() =>
                              void runAction(async () => {
                                await postJson(`/api/providers/${provider.id}/select`, {
                                  modelId: defaultModel
                                });
                                await refreshDashboard();
                              }, `${provider.label} activated.`)
                            }
                          >
                            Activate
                          </button>
                          <button
                            className="secondary"
                            onClick={() =>
                              void runAction(async () => {
                                await api(`/api/providers/secrets/${provider.id}`, { method: "DELETE" });
                                await refreshDashboard();
                              }, `${provider.label} secret removed.`)
                            }
                          >
                            Delete
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </article>

              <article className="panel-card">
                <h3>Remote Access</h3>
                <p>
                  Private-network-first by design. Keep the service on loopback by default, then use Tailscale or SSH
                  forwarding in front of DroidAgent when you need remote access.
                </p>
              </article>

              <article className="panel-card">
                <h3>Current Setup State</h3>
                <pre>{JSON.stringify(dashboard?.setup ?? {}, null, 2)}</pre>
              </article>
            </section>
          ) : null}
        </div>

        <nav className="bottom-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={classNames(tab === item.id && "active")} onClick={() => setTab(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </section>
    </main>
  );
}
