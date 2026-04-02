import { memo, useEffect, useState } from "react";

import type {
  ApprovalRecord,
  ChatAttachment,
  ChatMessage,
  ChatMessagePart,
  HostPressureContributor,
} from "@droidagent/shared";

import {
  buildRunInChatPrompt,
  extractRunnableCommand,
} from "../lib/command-suggestions";
import { formatBytes } from "../lib/formatters";

export interface ExpandedImageState {
  src: string;
  alt: string;
  label?: string;
}

type MarkdownRendererModule = {
  ReactMarkdown: typeof import("react-markdown").default;
  remarkGfm: typeof import("remark-gfm").default;
};

export function formatMessageTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

export function formatHostRatio(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }
  return `${Math.round(value * 100)}%`;
}

function looksLikeRichMarkdown(text: string): boolean {
  return (
    text.includes("\n") ||
    /[`*_#[\]-]/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    /https?:\/\//.test(text)
  );
}

function PlainTextMessage({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter(Boolean);
  return (
    <>
      {blocks.map((block, index) => (
        <p key={`${block.slice(0, 24)}-${index}`}>
          {block.split("\n").map((line, lineIndex) => (
            <span key={`${lineIndex}-${line.slice(0, 24)}`}>
              {lineIndex > 0 ? <br /> : null}
              {line}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

export function shouldShowCopyButton(message: ChatMessage): boolean {
  if (!message.text.trim()) {
    return false;
  }

  if (message.role === "user") {
    return message.text.trim().length >= 180;
  }

  return true;
}

export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="message-copy-button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function MarkdownCodeBlock({
  text,
  className,
  onRunCommand,
  onOpenInTerminal,
  commandActionsEnabled = true,
  commandActionDisabledReason,
}: {
  text: string;
  className: string | undefined;
  onRunCommand?: ((command: string) => void) | null | undefined;
  onOpenInTerminal?: ((command: string) => void) | null | undefined;
  commandActionsEnabled?: boolean;
  commandActionDisabledReason?: string | null | undefined;
}) {
  const runnableCommand = extractRunnableCommand(
    className?.replace("language-", "") ?? null,
    text,
  );

  return (
    <div className="markdown-code-shell">
      <div className="markdown-code-toolbar">
        <span>{className?.replace("language-", "") || "code"}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre className="markdown-pre">
        <code className={className}>{text}</code>
      </pre>
      {runnableCommand && onRunCommand && onOpenInTerminal ? (
        <>
          <div className="message-action-row">
            <button
              type="button"
              className="secondary"
              disabled={!commandActionsEnabled}
              title={
                commandActionsEnabled
                  ? undefined
                  : (commandActionDisabledReason ?? undefined)
              }
              onClick={() => onRunCommand(buildRunInChatPrompt(runnableCommand))}
            >
              Run in Chat
            </button>
            <details className="message-details">
              <summary>More</summary>
              <div className="message-action-row compact">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => onOpenInTerminal(runnableCommand)}
                >
                  Open in Terminal
                </button>
              </div>
            </details>
          </div>
          {!commandActionsEnabled && commandActionDisabledReason ? (
            <p className="message-action-note">{commandActionDisabledReason}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ChatMarkdown({
  text,
  onRunCommand,
  onOpenInTerminal,
  onOpenImage,
  commandActionsEnabled = true,
  commandActionDisabledReason,
}: {
  text: string;
  onRunCommand?: ((command: string) => void) | null | undefined;
  onOpenInTerminal?: ((command: string) => void) | null | undefined;
  onOpenImage?: ((image: ExpandedImageState) => void) | null | undefined;
  commandActionsEnabled?: boolean;
  commandActionDisabledReason?: string | null | undefined;
}) {
  const [renderer, setRenderer] = useState<MarkdownRendererModule | null>(null);

  useEffect(() => {
    if (!looksLikeRichMarkdown(text)) {
      return;
    }

    let active = true;
    void Promise.all([import("react-markdown"), import("remark-gfm")]).then(
      ([reactMarkdownModule, remarkGfmModule]) => {
        if (!active) {
          return;
        }
        setRenderer({
          ReactMarkdown: reactMarkdownModule.default,
          remarkGfm: remarkGfmModule.default,
        });
      },
    );
    return () => {
      active = false;
    };
  }, [text]);

  if (!looksLikeRichMarkdown(text) || !renderer) {
    return <PlainTextMessage text={text} />;
  }

  const { ReactMarkdown, remarkGfm } = renderer;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a(props) {
          return <a {...props} rel="noreferrer" target="_blank" />;
        },
        code({ children, className }) {
          const content = String(children).replace(/\n$/, "");
          const blockLike = Boolean(className) || content.includes("\n");

          return blockLike ? (
            <MarkdownCodeBlock
              className={className}
              commandActionDisabledReason={commandActionDisabledReason}
              commandActionsEnabled={commandActionsEnabled}
              onOpenInTerminal={onOpenInTerminal}
              onRunCommand={onRunCommand}
              text={content}
            />
          ) : (
            <code className="markdown-inline-code">{content}</code>
          );
        },
        pre({ children }) {
          return <>{children}</>;
        },
        img(props) {
          const src = props.src ?? "";
          const alt = props.alt ?? "Chat image";
          if (!src) {
            return null;
          }
          return (
            <button
              type="button"
              className="message-inline-image"
              onClick={() =>
                onOpenImage?.({
                  src,
                  alt,
                  label: alt,
                })
              }
            >
              <img alt={alt} loading="lazy" src={src} />
              <span>Expand image</span>
            </button>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export function StreamingMarkdown({
  text,
  onOpenImage,
}: {
  text: string;
  onOpenImage?: ((image: ExpandedImageState) => void) | null | undefined;
}) {
  if (!text.includes("\n") && !/[`*_#[\]-]/.test(text)) {
    return <p>{text}</p>;
  }

  return (
    <div className="message-markdown">
      <ChatMarkdown onOpenImage={onOpenImage} text={text} />
    </div>
  );
}

function AttachmentPart({
  attachments,
  onOpenImage,
}: {
  attachments: ChatAttachment[];
  onOpenImage?: ((image: ExpandedImageState) => void) | null | undefined;
}) {
  const imageAttachments = attachments.filter(
    (attachment) => attachment.kind === "image",
  );
  const fileAttachments = attachments.filter(
    (attachment) => attachment.kind !== "image",
  );

  return (
    <div className="attachment-stack">
      {imageAttachments.length > 0 ? (
        <div className="attachment-image-grid">
          {imageAttachments.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              className="attachment-image-card"
              onClick={() =>
                onOpenImage?.({
                  src: attachment.url,
                  alt: attachment.name,
                  label: attachment.name,
                })
              }
            >
              <img alt={attachment.name} loading="lazy" src={attachment.url} />
              <span>{attachment.name}</span>
            </button>
          ))}
        </div>
      ) : null}

      {fileAttachments.length > 0 ? (
        <div className="attachment-chip-row">
          {fileAttachments.map((attachment) => (
            <a
              key={attachment.id}
              className="attachment-chip"
              href={attachment.url}
              rel="noreferrer"
              target="_blank"
            >
              <strong>{attachment.kind}</strong>
              <span>{attachment.name}</span>
              <small>{formatBytes(attachment.size)}</small>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalRecord | null;
  onResolve: (approvalId: string, resolution: "approved" | "denied") => void;
}) {
  if (!approval) {
    return null;
  }

  return (
    <div className="inline-approval-card">
      <div className="inline-approval-copy">
        <strong>{approval.title}</strong>
        <p>{approval.details}</p>
      </div>
      <div className="button-row compact-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => onResolve(approval.id, "denied")}
        >
          Deny
        </button>
        <button type="button" onClick={() => onResolve(approval.id, "approved")}>
          Approve
        </button>
      </div>
    </div>
  );
}

export const MessagePartView = memo(function MessagePartView({
  part,
  approval,
  onResolveApproval,
  onRunCommand,
  onOpenInTerminal,
  onOpenImage,
  commandActionsEnabled,
  commandActionDisabledReason,
}: {
  part: ChatMessagePart;
  approval: ApprovalRecord | null;
  onResolveApproval: (approvalId: string, resolution: "approved" | "denied") => void;
  onRunCommand: (command: string) => void;
  onOpenInTerminal: (command: string) => void;
  onOpenImage: (image: ExpandedImageState) => void;
  commandActionsEnabled: boolean;
  commandActionDisabledReason?: string | null | undefined;
}) {
  if (part.type === "markdown") {
    return (
      <div className="message-markdown">
        <ChatMarkdown
          commandActionDisabledReason={commandActionDisabledReason}
          commandActionsEnabled={commandActionsEnabled}
          onOpenImage={onOpenImage}
          onOpenInTerminal={onOpenInTerminal}
          onRunCommand={onRunCommand}
          text={part.text}
        />
      </div>
    );
  }

  if (part.type === "attachments") {
    return (
      <AttachmentPart
        attachments={part.attachments}
        onOpenImage={onOpenImage}
      />
    );
  }

  if (part.type === "code_block") {
    return (
      <MarkdownCodeBlock
        className={part.language ?? undefined}
        commandActionDisabledReason={commandActionDisabledReason}
        commandActionsEnabled={commandActionsEnabled}
        onOpenInTerminal={onOpenInTerminal}
        onRunCommand={onRunCommand}
        text={part.code}
      />
    );
  }

  if (part.type === "tool_call_summary") {
    return (
      <div className="message-inline-card tool">
        <strong>{part.summary}</strong>
        <span>{part.toolName}</span>
        {part.details ? (
          <details className="message-details">
            <summary>Inspect details</summary>
            <pre>{part.details}</pre>
          </details>
        ) : null}
      </div>
    );
  }

  if (part.type === "tool_result_summary") {
    return (
      <div className="message-inline-card result">
        <strong>{part.summary}</strong>
        {part.toolName ? <span>{part.toolName}</span> : null}
        {part.details ? (
          <details className="message-details">
            <summary>Inspect details</summary>
            <pre>{part.details}</pre>
          </details>
        ) : null}
      </div>
    );
  }

  if (part.type === "approval_request") {
    return (
      <ApprovalCard
        approval={approval}
        onResolve={onResolveApproval}
      />
    );
  }

  return (
    <div className="message-inline-card error">
      <strong>{part.message}</strong>
      {part.details ? <span>{part.details}</span> : null}
    </div>
  );
});

export function PendingAttachmentList({
  attachments,
  onRemove,
}: {
  attachments: ChatAttachment[];
  onRemove: (attachmentId: string) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="composer-attachment-list">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="composer-attachment-chip">
          <div>
            <strong>{attachment.name}</strong>
            <span>
              {attachment.kind} • {formatBytes(attachment.size)}
            </span>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => onRemove(attachment.id)}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

export function MessageMemoryActions({
  onAddMemory,
  onAddPreferences,
  onAddTodayNote,
}: {
  onAddMemory: () => void;
  onAddPreferences: () => void;
  onAddTodayNote: () => void;
}) {
  return (
    <div className="message-utility-tray">
      <span className="message-utility-label">Save memory</span>
      <div className="message-action-row compact">
        <button
          type="button"
          className="secondary"
          onClick={onAddMemory}
        >
          Memory
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onAddPreferences}
        >
          Preferences
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onAddTodayNote}
        >
          Today Note
        </button>
      </div>
    </div>
  );
}

export function PressureContributorBadge({
  contributor,
}: {
  contributor: HostPressureContributor;
}) {
  return (
    <div
      className={`pressure-contributor-badge ${contributor.severity}`.trim()}
      title={contributor.detail}
    >
      <strong>{contributor.label}</strong>
      <span>{contributor.value}</span>
    </div>
  );
}
