"use client";

import { Check, Copy, ExternalLink, LoaderCircle, LogOut, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { OpenAIDeviceCode } from "@/types/openai";

type OpenAIConnectionProps = {
  compact?: boolean;
  initiallyConnected: boolean;
};

type DialogState =
  | { status: "idle" | "starting" }
  | { status: "waiting"; device: OpenAIDeviceCode; copied: boolean; copiesCode: boolean }
  | { status: "error"; message: string };

/** Renders OpenAI connection state and the device-code sign-in dialog. */
export function OpenAIConnection({ compact = false, initiallyConnected }: OpenAIConnectionProps) {
  const router = useRouter();
  const [connected, setConnected] = useState(initiallyConnected);
  const [dialog, setDialog] = useState<DialogState>({ status: "idle" });
  const device = dialog.status === "waiting" ? dialog.device : null;
  const copied = dialog.status === "waiting" && dialog.copied;
  const copiesCode = dialog.status === "waiting" && dialog.copiesCode;

  useEffect(() => {
    if (!device) return;
    const currentDevice = device;

    let cancelled = false;
    let timer = 0;

    /** Schedules the next server-side approval check at OpenAI's requested interval. */
    function schedulePoll(): void {
      timer = window.setTimeout(pollForApproval, currentDevice.interval * 1_000);
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

        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error ?? "OpenAI sign-in could not finish.");

        setConnected(true);
        setDialog({ status: "idle" });
        router.refresh();
      } catch (pollError) {
        if (cancelled) return;
        const message = pollError instanceof Error ? pollError.message : "OpenAI sign-in could not finish.";
        setDialog({ status: "error", message });
      }
    }

    schedulePoll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [device, router]);

  useEffect(() => {
    if (!device) return;
    const currentDevice = device;

    /** Copies the authorization link first, then the device code on later C presses. */
    async function copyLoginValue(event: KeyboardEvent): Promise<void> {
      const target = event.target;
      const isEditing = target instanceof HTMLElement
        && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement);
      if (event.key.toLowerCase() !== "c" || event.metaKey || event.ctrlKey || event.altKey || isEditing) return;

      event.preventDefault();
      await navigator.clipboard.writeText(copiesCode ? currentDevice.userCode : currentDevice.verificationUrl);
      setDialog((current) => current.status === "waiting"
        ? { ...current, copied: copiesCode, copiesCode: true }
        : current);
    }

    document.addEventListener("keydown", copyLoginValue);
    return () => document.removeEventListener("keydown", copyLoginValue);
  }, [copiesCode, device]);

  /** Opens the connection dialog and requests a fresh one-time code. */
  async function startConnection(): Promise<void> {
    setDialog({ status: "starting" });

    try {
      const response = await fetch("/api/auth/openai/device", { method: "POST" });
      const body = await response.json() as OpenAIDeviceCode & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "OpenAI sign-in could not start.");
      setDialog({ status: "waiting", device: body, copied: false, copiesCode: false });
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : "OpenAI sign-in could not start.";
      setDialog({ status: "error", message });
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
    setDialog((current) => current.status === "waiting" ? { ...current, copied: true } : current);
  }

  /** Closes the dialog and stops client-side polling. */
  function closeDialog(): void {
    setDialog({ status: "idle" });
  }

  return (
    <>
      {connected ? (
        <button aria-label="Disconnect OpenAI" className={`openai-button connected ${compact ? "compact" : ""}`} type="button" onClick={disconnect} title="Disconnect OpenAI">
          <span className="connection-dot" />
          <span>{compact ? "OpenAI" : "OpenAI connected"}</span>
          <LogOut size={12} />
        </button>
      ) : (
        <button aria-label="Connect OpenAI" className={`openai-button ${compact ? "compact" : ""}`} type="button" onClick={startConnection}>
          <Sparkles size={14} />
          <span>Connect OpenAI</span>
        </button>
      )}

      {dialog.status !== "idle" && (
        <div className="openai-overlay">
          <section className="openai-dialog" role="dialog" aria-modal="true" aria-labelledby="openai-dialog-title">
            <button className="openai-dialog-close" type="button" aria-label="Close OpenAI sign-in" onClick={closeDialog}>
              <X size={16} />
            </button>

            <div className="openai-dialog-mark"><Sparkles size={18} /></div>
            <span className="openai-dialog-kicker">Code questions</span>
            <h2 id="openai-dialog-title">Connect your OpenAI account</h2>
            <p>Authorize directly on OpenAI. Diffs never sees your password, and GitHub access stays separate.</p>

            {dialog.status === "starting" && (
              <div className="openai-waiting"><LoaderCircle className="spinner" size={17} /> Creating a secure code…</div>
            )}

            {device && (
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
                    <kbd>C</kbd> {copiesCode ? (copied ? "Code copied" : "Copy code") : "Copy link"}
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

            {dialog.status === "error" && (
              <div className="openai-error">
                <span>{dialog.message}</span>
                <button type="button" onClick={startConnection}>Try again</button>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
