"use client";

import { Check, Copy, ExternalLink, LoaderCircle, LogOut, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { OpenAIConnection as OpenAIConnectionState } from "@/lib/openai-auth";

type DeviceCode = {
  interval: number;
  userCode: string;
  verificationUrl: string;
};

type OpenAIConnectionProps = {
  compact?: boolean;
  initialConnection: OpenAIConnectionState;
};

type ConnectionStatus = "idle" | "starting" | "waiting" | "error";

/** Renders OpenAI connection state and the device-code sign-in dialog. */
export function OpenAIConnection({ compact = false, initialConnection }: OpenAIConnectionProps) {
  const router = useRouter();
  const [connected, setConnected] = useState(initialConnection.connected);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [shortcutCopiesCode, setShortcutCopiesCode] = useState(false);

  useEffect(() => {
    if (!device || status !== "waiting") return;
    const activeDevice = device;

    let cancelled = false;
    let timer = 0;

    /** Schedules the next server-side approval check at OpenAI's requested interval. */
    function schedulePoll(): void {
      timer = window.setTimeout(pollForApproval, activeDevice.interval * 1_000);
    }

    /** Polls once and completes the local session after OpenAI approves the device. */
    async function pollForApproval(): Promise<void> {
      try {
        const response = await fetch("/api/auth/openai/device/poll", { method: "POST" });
        if (cancelled) return;

        if (response.status === 202 || response.status >= 500) {
          schedulePoll();
          return;
        }

        const body = await response.json() as OpenAIConnectionState & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "OpenAI sign-in could not finish.");

        setConnected(body.connected);
        setStatus("idle");
        setDevice(null);
        router.refresh();
      } catch (pollError) {
        if (cancelled) return;
        setError(pollError instanceof Error ? pollError.message : "OpenAI sign-in could not finish.");
        setStatus("error");
      }
    }

    schedulePoll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [device, router, status]);

  useEffect(() => {
    if (!device || status !== "waiting") return;
    const activeDevice = device;

    /** Copies the authorization link first, then the device code on later C presses. */
    async function copyLoginValue(event: KeyboardEvent): Promise<void> {
      const target = event.target;
      const isEditing = target instanceof HTMLElement
        && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement);
      if (event.key.toLowerCase() !== "c" || event.metaKey || event.ctrlKey || event.altKey || isEditing) return;

      event.preventDefault();
      await navigator.clipboard.writeText(shortcutCopiesCode ? activeDevice.userCode : activeDevice.verificationUrl);
      if (shortcutCopiesCode) setCopied(true);
      else setShortcutCopiesCode(true);
    }

    document.addEventListener("keydown", copyLoginValue);
    return () => document.removeEventListener("keydown", copyLoginValue);
  }, [device, shortcutCopiesCode, status]);

  /** Opens the connection dialog and requests a fresh one-time code. */
  async function startConnection(): Promise<void> {
    setDevice(null);
    setError("");
    setCopied(false);
    setShortcutCopiesCode(false);
    setStatus("starting");

    try {
      const response = await fetch("/api/auth/openai/device", { method: "POST" });
      const body = await response.json() as DeviceCode & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "OpenAI sign-in could not start.");
      setDevice(body);
      setStatus("waiting");
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "OpenAI sign-in could not start.");
      setStatus("error");
    }
  }

  /** Clears the OpenAI session while leaving GitHub authentication untouched. */
  async function disconnect(): Promise<void> {
    await fetch("/api/auth/openai/logout", { method: "POST" });
    setConnected(false);
    router.refresh();
  }

  /** Copies the short-lived device code after an explicit user click. */
  async function copyCode(): Promise<void> {
    if (!device) return;
    await navigator.clipboard.writeText(device.userCode);
    setCopied(true);
  }

  /** Closes the dialog and stops client-side polling. */
  function closeDialog(): void {
    setDevice(null);
    setStatus("idle");
  }

  return (
    <>
      {connected ? (
        <button className={`openai-button connected ${compact ? "compact" : ""}`} type="button" onClick={disconnect} title="Disconnect OpenAI">
          <span className="connection-dot" />
          <span>{compact ? "OpenAI" : "OpenAI connected"}</span>
          <LogOut size={12} />
        </button>
      ) : (
        <button className={`openai-button ${compact ? "compact" : ""}`} type="button" onClick={startConnection}>
          <Sparkles size={14} />
          <span>Connect OpenAI</span>
        </button>
      )}

      {status !== "idle" && (
        <div className="openai-overlay">
          <section className="openai-dialog" role="dialog" aria-modal="true" aria-labelledby="openai-dialog-title">
            <button className="openai-dialog-close" type="button" aria-label="Close OpenAI sign-in" onClick={closeDialog}>
              <X size={16} />
            </button>

            <div className="openai-dialog-mark"><Sparkles size={18} /></div>
            <span className="openai-dialog-kicker">Code questions</span>
            <h2 id="openai-dialog-title">Connect your OpenAI account</h2>
            <p>Authorize directly on OpenAI. Diffs never sees your password, and GitHub access stays separate.</p>

            {status === "starting" && (
              <div className="openai-waiting"><LoaderCircle className="spinner" size={17} /> Creating a secure code…</div>
            )}

            {device && status === "waiting" && (
              <div className="openai-device-flow">
                <div className="openai-step">
                  <span>1</span>
                  <div><strong>Open OpenAI</strong><small>Use the official authorization page.</small></div>
                </div>
                <div className="openai-continue-row">
                  <a className="openai-continue" href={device.verificationUrl} target="_blank" rel="noreferrer">
                    Continue to OpenAI <ExternalLink size={14} />
                  </a>
                  <span className="openai-copy-shortcut" aria-live="polite">
                    <kbd>C</kbd> {shortcutCopiesCode ? (copied ? "Code copied" : "Copy code") : "Copy link"}
                  </span>
                </div>

                <div className="openai-step">
                  <span>2</span>
                  <div><strong>Enter this one-time code</strong><small>It expires in fifteen minutes.</small></div>
                </div>
                <div className="device-code">
                  <code>{device.userCode}</code>
                  <button type="button" onClick={copyCode} aria-label="Copy one-time code">
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                </div>

                <div className="openai-waiting"><LoaderCircle className="spinner" size={15} /> Waiting for OpenAI…</div>
              </div>
            )}

            {status === "error" && (
              <div className="openai-error">
                <span>{error}</span>
                <button type="button" onClick={startConnection}>Try again</button>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
