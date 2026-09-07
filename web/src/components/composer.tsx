import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, ReactNode } from "react";
import { useRevalidator } from "react-router";
import { AArrowDown, AArrowUp, Camera, Check, FileText, Keyboard, Loader2, Paperclip, RotateCcw, Search, Send, Slash, Terminal, Trash2, WrapText, X, Zap } from "lucide-react";

import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { setStatus } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { NavTray } from "@/components/nav-tray";
import { CommandPalette } from "@/components/command-palette";
import { QuickActionsContent } from "@/components/quick-actions";
import { SectionLabel } from "@/components/ui/section-label";
import * as api from "@/lib/api";
import { commandsFor } from "@/lib/agent-commands";
import { isDestructiveInput } from "@/lib/destructive";
import { useHoldReload } from "@/lib/reload-guard";
import { isSelfEcho, normalizeDraft } from "@/hooks/use-terminal-draft";
import { sendGuardedReply } from "@/lib/reply-action";
import { TerminalDraftPreview } from "@/components/terminal-draft-preview";
import { uploadFile } from "@/lib/development-api";
import type { FileUploadResult } from "@/lib/development-api";

export interface ComposerHandle {
  /** Focus the input and put the caret at the end — used by the mirror-tap-to-focus in AgentChat. */
  focusInput: () => void;
}

interface ComposerProps {
  paneId: string;
  /** The session the pane lives in (undefined = primary) — scopes every write to the right Herdr. */
  session?: string;
  /** The pane's agent name — drives the slash-command palette and the reply-vs-shell placeholder. */
  agent: string | undefined | null;
  /** True for a bare shell pane (tweaks the placeholder copy). */
  isShell: boolean;
  /** Pane is gone (no agent) — locks the composer with a distinct placeholder. */
  gone: boolean;
  /** This device isn't authorised to type — locks the composer with a distinct placeholder. */
  readOnly: boolean;
  /** A dialog (prompt/wizard/preview/multi-select) is on screen, so the TUI's keyboard belongs to it.
   * Free-text sending is refused while true — see send(). Answer it with its own buttons instead. */
  dialogPresent: boolean;
  /** Latest pane text — clears the pending-send preview once the mirror echoes the send back. */
  text: string;
  /** A user draft stranded on the terminal's "❯" input line (extractInputDraft), STABILISED across
   * polls (useStableTerminalDraft) — non-null only once the same text has held for ~1.5s. Gates the
   * APPEARANCE of the read-only draft preview, so a one-poll blip or an in-flight send never flashes it. */
  terminalDraft: string | null;
  /** The SAME draft, but the RAW per-poll value (pre-stabilisation). Once the preview is showing, its
   * text tracks this live so host typing streams into it; it also drives the send()-time pre-clear (the
   * actual current "❯" line) and unmounts the preview when it goes null. Never written into the input. */
  rawTerminalDraft: string | null;
  /** Mirror display prefs — the View row lives here, but the mirror (in AgentChat) reads the same
   * single instance, so they're threaded through rather than each calling useDisplayPrefs. */
  prefs: DisplayPrefs;
  setWrap: (wrap: boolean) => void;
  stepFontSize: (delta: number) => void;
  setRawTerminal: (raw: boolean) => void;
  /** Snap the mirror to the live tail (follow + revalidate + scroll) after a successful send. */
  onSent: () => void;
  /** Open find-in-output (freezes the tail in AgentChat). Undefined when there's no buffered output
   * to search — the View-row Find button hides in that case. */
  onOpenFind?: () => void;
}

// The composer cluster at the bottom of the pane view — everything a phone keyboard can't do on its
// own: quick actions, an agent-aware slash-command palette, an inline key tray (via
// `pane.send_keys`), image upload, display prefs, and the reply Send (with a destructive-command
// two-tap guard). Its state (draft, sending, upload, pending preview, its own Keys/Quick/Agent
// sheets) is entirely local; it reaches AgentChat only through `onSent` (to re-follow the tail) and
// exposes `focusInput` so the mirror tap can bring up the keyboard.
type ComposerDrawer = "quick" | "cmd" | "keys" | null;

// Pause after clearing a stranded terminal draft so the TUI settles before pane.send_text.
const TUI_SETTLE_MS = 350;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type AttachmentStatus = "uploading" | "uploaded" | "failed";

interface AttachmentItem {
  id: string;
  key: string;
  file: File;
  name: string;
  size: number;
  mime: string;
  status: AttachmentStatus;
  progress: number;
  path?: string;
  error?: string;
  previewUrl?: string;
}


// Grace window after a send during which a terminal draft matching what we just sent is treated as
// our own in-flight reply (still on the "❯" line before the bridge's pending Enter lands), NOT a
// stranded draft. Wide enough to cover a slow tailnet round-trip; the parent's cross-poll
// stabilisation (useStableTerminalDraft) closes the other half of the same window.
const SENT_ECHO_GRACE_MS = 5_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function isAllowedAttachment(file: File): boolean {
  return file.type.startsWith("image/") || file.type.startsWith("text/") || file.type === "application/pdf";
}

function attachmentKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}


// Shared in-flow dock chrome for Keys/Quick — an IN-FLOW panel (never an overlay), so the terminal
// mirror's flex-1 box shrinks and its tail stays visible while the dock is open (a covering sheet
// hid exactly the prompt you were driving). Full-bleed top border + capped height keep the mirror
// usable on a phone. The header (title + Close X) is a NON-scrolling child of a flex column; only the
// body below it scrolls (max-h + overflow), so the Close X can never scroll out of reach on a short
// viewport with a tall tray. One wrapper so Keys and Quick can't drift apart.
function ComposerDock({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="-mx-3 mb-2 flex flex-col border-t border-border bg-background">
      <div className="flex items-center justify-between px-3 pt-2">
        <SectionLabel>{title}</SectionLabel>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="max-h-[45dvh] min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { paneId, session, agent, isShell, gone, readOnly, dialogPresent, text, terminalDraft, rawTerminalDraft, prefs, setWrap, stepFontSize, setRawTerminal, onSent, onOpenFind },
  ref,
) {
  const revalidator = useRevalidator();
  // Every write affordance is off when the pane is gone OR this device is read-only.
  const locked = gone || readOnly;

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  // Pending-send preview: set on a successful send, cleared when the mirror catches up (next text
  // update) or after a 6s safety timeout. Shows "You sent: …" so the user knows the message landed.
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false); // brief ✓ on the send button after a send
  // Terminal-draft preview bookkeeping. The composer input is EXCLUSIVELY phone-owned — a host draft
  // is never written into it implicitly; it only surfaces in a read-only preview the user can
  // deliberately Take over. There is no user-facing dismiss — the preview is honest state (a draft
  // really is stranded on the host's line), so it stays visible until the host line clears, the user
  // takes it over, or the user sends. `handledKey` is the NORMALISED text the user has handled (took
  // over or sent) — the preview stays hidden while the live draft still normalises to it, so it can't
  // re-latch onto the same text we just copied/sent (the raw line still holds it until the host clears
  // or Enter lands); a genuinely different draft is fair game again. `previewLatched` is the show/hide
  // latch: a STABLE draft flips it on (gating appearance behind the 1.5s stability), and it stays on —
  // its text tracking the RAW draft live — until the host line clears or the user acts (see the effects
  // below).
  const [handledKey, setHandledKey] = useState<string | null>(null);
  const [previewLatched, setPreviewLatched] = useState(false);
  // Composer sheets are mutually exclusive — at most one open (Keys / Quick / Agent).
  const [drawer, setDrawer] = useState<ComposerDrawer>(null);
  const closeDrawer = () => setDrawer(null);
  // Two-tap guard for destructive commands (rm -rf, force-push, …): the first tap arms a "Really
  // send?" state on the Send button (auto-disarms after 3 s), the second actually sends. Same shared
  // confirm the command palette uses for /clear.
  const sendConfirm = usePendingConfirm();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<AttachmentItem[]>([]);
  const uploadHandlesRef = useRef(new Map<string, AbortController>());
  const attachmentScopeRef = useRef(`${paneId}\u0000${session ?? ""}`);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What we last sent, and when — so we can recognise our OWN reply momentarily echoing on the "❯"
  // line (during the bridge's send_text→settle→Enter gap) and NOT treat it as a stranded draft. A
  // ref, not state: it feeds a render-time derivation but must not itself trigger re-renders.
  const lastSentRef = useRef<{ text: string; at: number } | null>(null);
  // Trailing-edge debounce for post-keypress revalidation: a burst of raw key sends (arrow-key
  // spam) coalesces into a single pane refetch instead of one per press.
  const keyRevalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Guard against a false stranded-draft: if the detected draft is what we JUST sent, it's our own
  // reply still echoing on the "❯" line before the bridge's pending Enter — suppress both the preview
  // AND the destructive clear-prefix on the next Send. Applied to the raw and the stabilised value
  // alike (during the echo both carry our text). Recomputed each render (each poll re-renders), so it
  // lapses on its own once the grace expires or the echo resolves; a genuinely stranded draft (never
  // matches a recent send) is untouched.
  const suppressEcho = (draft: string | null): string | null => {
    if (
      draft !== null &&
      lastSentRef.current !== null &&
      Date.now() - lastSentRef.current.at < SENT_ECHO_GRACE_MS &&
      isSelfEcho(draft, lastSentRef.current.text)
    ) {
      return null;
    }
    return draft;
  };
  // effectiveStable gates the preview's APPEARANCE (stabilised value); effectiveRaw is the live line
  // its text tracks and that the send()-time pre-clear sweeps.
  const effectiveStable = suppressEcho(terminalDraft);
  const effectiveRaw = suppressEcho(rawTerminalDraft);
  const uploading = attachments.some((item) => item.status === "uploading");
  const hasUnreadyAttachments = attachments.some((item) => item.status !== "uploaded");
  const uploadedPaths = attachments
    .filter((item): item is AttachmentItem & { path: string } => item.status === "uploaded" && Boolean(item.path))
    .map((item) => item.path);
  const sendText = [input.trim(), ...uploadedPaths].filter(Boolean).join("\n");

  useImperativeHandle(ref, () => ({ focusInput: focusInputImmediately }), []);

  useEffect(
    () => () => {
      if (sentTimer.current) clearTimeout(sentTimer.current);
      if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
      if (keyRevalidateTimer.current) clearTimeout(keyRevalidateTimer.current);
      for (const controller of uploadHandlesRef.current.values()) controller.abort();
      for (const item of attachmentsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    const nextScope = `${paneId}\u0000${session ?? ""}`;
    if (attachmentScopeRef.current === nextScope) return;
    attachmentScopeRef.current = nextScope;
    for (const controller of uploadHandlesRef.current.values()) controller.abort();
    uploadHandlesRef.current.clear();
    for (const item of attachmentsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    setAttachments([]);
  }, [paneId, session]);

  // When the mirror delivers fresh output (text changed), the send has been echoed back — clear the
  // pending preview immediately regardless of the 6s fallback timer.
  useEffect(() => {
    setLastSent(null);
    if (lastSentTimerRef.current) {
      clearTimeout(lastSentTimerRef.current);
      lastSentTimerRef.current = null;
    }
  }, [text]);

  // Block a self-update reload while there's unsent work here: real typed text OR an upload in flight.
  // The composer input is phone-owned, so any non-empty value is genuine unsent work. A terminal draft
  // is SAFE on its own — it lives on the "❯" line and its preview re-derives after a reload — so it
  // never holds. When held, the self-updater shows the "tap to update" banner instead and updates once
  // the hold clears (see lib/self-update.ts). Keyed by pane so panes don't clobber each other's hold.
  useHoldReload(`composer:${paneId}`, input.trim() !== "" || attachments.length > 0 || uploading);

  // Preview appearance latch. A STABLE, non-echo, not-already-handled draft flips the preview on —
  // this is the ONLY gate that waits for the 1.5s stability, so a blip or an in-flight send never
  // flashes it. Deliberately one-directional: once latched, rapid host typing (which keeps blanking
  // the stabilised value) can't turn it back off — the raw-tracking + unlatch effects own the hide
  // side. Skipped when the pane is gone.
  useEffect(() => {
    if (gone) return;
    if (effectiveStable !== null && normalizeDraft(effectiveStable) !== handledKey) {
      setPreviewLatched(true);
    }
  }, [effectiveStable, handledKey, gone]);

  // Unlatch when the host clears the "❯" line — the draft was submitted or wiped on the host, or our
  // own send echoed back and got suppressed to null. The preview unmounts on the next render. Also
  // forget the handled key: it exists only to stop the JUST-handled text re-latching before the line
  // clears — once the line has actually emptied, a later re-strand of the same text is a fresh draft
  // and must surface again (without this, taking over "continue" once muted every future "continue"
  // in the pane until you navigated away).
  useEffect(() => {
    if (effectiveRaw === null) {
      setPreviewLatched(false);
      setHandledKey(null);
    }
  }, [effectiveRaw]);

  // Show the preview while it's latched, the host line still carries a (non-echo) draft, and the user
  // hasn't already handled this exact text. Its displayed text is the LIVE raw line — host typing
  // streams straight into it (display-only; it can never write back into the phone-owned input). There
  // is no dismiss action — this is the ONLY way the preview hides short of the host line itself
  // clearing, since a draft that still normalises to `handledKey` is the one the user just took over
  // or sent, not a fresh one to re-show. Not gated on `locked`: read-only devices get the preview +
  // Take over (a local text copy); only the actual Send stays gated.
  const showPreview =
    !gone && previewLatched && effectiveRaw !== null && normalizeDraft(effectiveRaw) !== handledKey;

  // Take over: the explicit "I'll handle this on mobile now" action. One-shot COPY of the current raw
  // draft into the composer (set on an empty input, else appended on a new line so mobile-typed work
  // survives), mark that exact text handled (so it can't instantly re-latch the preview — the raw line
  // still holds it until the host clears it), and hide the preview. No keys touch the terminal here —
  // the stranded line is only ever swept by the send()-time pre-clear. If the host keeps typing and
  // produces a DIFFERENT draft afterwards, the preview honestly reappears with the new text.
  function takeOverDraft() {
    if (effectiveRaw === null) return;
    const draft = effectiveRaw;
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${draft}` : draft));
    setHandledKey(normalizeDraft(draft));
    setPreviewLatched(false);
    focusInputEnd();
  }

  const commands = commandsFor(agent);

  function focusInputImmediately() {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  function focusInputEnd() {
    setTimeout(focusInputImmediately, 0);
  }

  async function send(value: string, isDraft: boolean) {
    const t = value.trim();
    if (!t || locked || sending || hasUnreadyAttachments) return;
    // A dialog on screen owns the TUI's keyboard: our text is swallowed and the submit key ANSWERS
    // the dialog, approving whatever option was highlighted (#34). Refuse BEFORE the destructive
    // pre-clear sweep below — those ctrl+k/Backspaces would land in the dialog too. The input is
    // kept: the user answers the dialog with its own buttons, then taps Send again. We never
    // queue-and-auto-send, because the text may be a reaction to state the dialog just changed —
    // sending is consent, and the conditions moved.
    if (dialogPresent) {
      setStatus("A dialog is waiting — answer it first, then send.", "error");
      return;
    }
    setSending(true);
    try {
      // Clear a stranded draft on the terminal's "❯" line before pane.send_text appends at cursor —
      // ctrl+k kills cursor→end, Backspace sweep kills the head (preview-action.ts pattern). Skip when
      // there's no draft: a blind sweep races the TUI and Enter can fire before the PTY settles. Keys
      // on effectiveRaw (the actual current line, echo-suppressed), so our own in-flight echo never
      // triggers a (destructive) clear of a message that's already on its way, and a live host draft
      // is swept exactly once whether or not the user took it over first.
      if (effectiveRaw !== null) {
        // Overshoot well past the snapshotted length: the count comes from the LAST-POLLED line, so
        // anything the host typed inside the poll gap (~1.5s) isn't counted. Extra Backspace on an
        // already-empty input is a no-op, so a generous margin costs nothing and shrinks the window
        // where a mid-gap host burst leaves a remnant that corrupts the send.
        const clearCount = [...effectiveRaw].length + 32;
        const clearRes = await api.sendKeys(
          paneId,
          ["ctrl+k", ...Array(clearCount).fill("Backspace")],
          session,
        );
        if (!clearRes.ok) {
          setStatus(clearRes.error ?? "Couldn't clear the terminal input", "error");
          return;
        }
        scheduleKeyRevalidate();
        await new Promise((resolve) => setTimeout(resolve, TUI_SETTLE_MS));
      }

      // Guarded: types the text, verifies it reached the input box, and only THEN sends the submit
      // key. A "stalled" outcome means nothing was submitted and the draft must survive (#34).
      const res = await sendGuardedReply({ paneId, text: t, agent, session });
      if (res.status === "sent") {
        if (isDraft) setInput(""); // phone-owned input — clear it once the reply is on its way
        clearUploadedAttachments();
        // Remember what/when we sent, so the next few polls recognise this text echoing on the "❯"
        // line as our own in-flight reply rather than a stranded draft (suppressEcho above).
        lastSentRef.current = { text: t, at: Date.now() };
        // The stranded line was just swept and our text sent — mark it handled and drop the preview so
        // it can't flash back before the mirror echoes the cleared line.
        if (effectiveRaw !== null) {
          setHandledKey(normalizeDraft(effectiveRaw));
          setPreviewLatched(false);
        }
        // ✓ flash on the send button + status line acknowledge a VERIFIED send (the text was seen in
        // the input box before the submit key went out), so this lands slightly later than the old
        // fire-and-forget ✓ but is now actually true. The "You sent: …" pending preview keeps the
        // typed text visible until the mirror catches up (cleared by the next text update or a 6s
        // safety timeout).
        setJustSent(true);
        if (sentTimer.current) clearTimeout(sentTimer.current);
        sentTimer.current = setTimeout(() => setJustSent(false), 1500);
        setStatus("Sent ✓", "success");
        const preview = t.length > 60 ? `${t.slice(0, 57)}…` : t;
        setLastSent(preview);
        if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
        lastSentTimerRef.current = setTimeout(() => setLastSent(null), 6000);
        onSent(); // you just acted — snap the mirror back to the live tail to see the result
      } else {
        // "stalled" = the text never reached the input box, so NO submit key was sent (a dialog was
        // probably holding focus). "error" with textDelivered = the text is in the pane but the
        // submit failed. Either way the draft stays put: the user checks the pane rather than
        // double-sending, and on a stall their message is still here to re-send once the dialog is
        // answered.
        setStatus(res.error, "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSending(false);
    }
  }

  // Gate the composer's Send through the destructive-input confirm: a matching command arms the
  // "Really send?" state instead of sending; the confirming second tap goes through. Non-destructive
  // input sends immediately (and any stray armed state is cleared).
  function onSendClick() {
    if (hasUnreadyAttachments) return;
    const reason = isDestructiveInput(sendText);
    if (reason && !sendConfirm.confirm("send")) {
      setStatus(`Destructive: ${reason} — tap Send again to confirm`, "info");
      return;
    }
    sendConfirm.reset();
    send(sendText, true);
  }
  const confirmingSend = sendConfirm.pending === "send";

  // Coalesce revalidations from a burst of key presses into one trailing-edge refetch (~300ms).
  // Single presses still feel instant; arrow-key spam no longer triggers a refetch per key.
  function scheduleKeyRevalidate() {
    if (keyRevalidateTimer.current) clearTimeout(keyRevalidateTimer.current);
    keyRevalidateTimer.current = setTimeout(() => {
      keyRevalidateTimer.current = null;
      revalidator.revalidate();
    }, 300);
  }

  // Raw key send (nav tray). Silent on success — the mirror is the source of truth; only show errors.
  function pressKeys(k: string[]) {
    if (locked) return;
    api
      .sendKeys(paneId, k, session)
      .then((res) => {
        if (!res.ok) setStatus(res.error ?? "Key send failed", "error");
        else scheduleKeyRevalidate();
      })
      .catch((e) => setStatus(e instanceof Error ? e.message : String(e), "error"));
  }

  // Insert "/cmd " into the composer (arg-taking commands) and focus it. Appends to any draft already
  // typed (with a separating space) rather than clobbering it; an empty draft just gets set.
  function insertCommand(value: string) {
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${value}` : value));
    focusInputEnd();
  }

  function updateAttachment(id: string, patch: Partial<AttachmentItem>) {
    setAttachments((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function startUpload(item: AttachmentItem) {
    const controller = new AbortController();
    uploadHandlesRef.current.set(item.id, controller);
    void uploadFile(
      item.file,
      session,
      (progress) => updateAttachment(item.id, { progress }),
      controller.signal,
    )
      .then((uploaded: FileUploadResult) => {
        uploadHandlesRef.current.delete(item.id);
        updateAttachment(item.id, {
          status: "uploaded",
          progress: 100,
          path: uploaded.path,
          name: uploaded.name,
          size: uploaded.size,
          mime: uploaded.mime,
          error: undefined,
        });
        setStatus("Attachment uploaded", "success");
      })
      .catch((err) => {
        uploadHandlesRef.current.delete(item.id);
        updateAttachment(item.id, {
          status: "failed",
          progress: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  function addFiles(files: File[]) {
    if (locked || files.length === 0) return;
    const current = attachmentsRef.current;
    const keys = new Set(current.map((item) => item.key));
    const next: AttachmentItem[] = [];
    let skipped = 0;
    let hitMax = false;
    for (const file of files) {
      if (current.length + next.length >= MAX_ATTACHMENTS) {
        hitMax = true;
        skipped += 1;
        continue;
      }
      if (!isAllowedAttachment(file)) {
        setStatus("Only images, text files, and PDFs can be attached", "error");
        skipped += 1;
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setStatus(`${file.name} is over 10 MB`, "error");
        skipped += 1;
        continue;
      }
      const key = attachmentKey(file);
      if (keys.has(key)) {
        setStatus("That file is already attached", "info");
        skipped += 1;
        continue;
      }
      keys.add(key);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      next.push({
        id,
        key,
        file,
        name: file.name,
        size: file.size,
        mime: file.type,
        status: "uploading",
        progress: 1,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      });
    }
    if (hitMax) setStatus("Maximum 5 attachments", "error");
    if (next.length === 0) {
      if (skipped > 0 && current.length >= MAX_ATTACHMENTS) setStatus("Maximum 5 attachments", "error");
      return;
    }
    setAttachments((prev) => [...prev, ...next]);
    for (const item of next) startUpload(item);
    focusInputEnd();
  }

  function retryAttachment(id: string) {
    const item = attachmentsRef.current.find((entry) => entry.id === id);
    if (!item || item.status !== "failed" || locked) return;
    updateAttachment(id, { status: "uploading", progress: 1, error: undefined });
    startUpload({ ...item, status: "uploading", progress: 1, error: undefined });
  }

  function removeAttachment(id: string) {
    const controller = uploadHandlesRef.current.get(id);
    if (controller) {
      controller.abort();
      uploadHandlesRef.current.delete(id);
    }
    setAttachments((prev) => {
      const item = prev.find((entry) => entry.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((entry) => entry.id !== id);
    });
  }

  function clearUploadedAttachments() {
    setAttachments((prev) => {
      for (const item of prev) {
        if (item.status === "uploaded" && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      return prev.filter((item) => item.status !== "uploaded");
    });
  }

  function onPickFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    addFiles(files);
  }

  // Paste an image straight from the clipboard (e.g. a screenshot) the same way the picker does.
  // Only intercepts when the clipboard actually carries an image file — a plain text paste (the
  // common case) falls through untouched.
  function onPasteImage(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (locked) return;
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }

  return (
    <>
      <div className="border-t border-border/60 bg-zinc-800 px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)] pt-2.5">
        {/* Pending-send preview: visible from send until the mirror echoes back (or 6s). Shows the
            user what landed so they don't double-tap while waiting for the terminal to update. */}
        {lastSent && (
          <div className="mb-2 flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span className="truncate">
              <span className="font-medium">You sent:</span> {lastSent}
            </span>
          </div>
        )}

        {/* File input stays mounted here (not inside the keyboard-only key row) so the picker
            callback survives the keyboard collapsing. Attach-image fires it from the reply-input row
            below (always visible, not gated behind the keyboard-open quick keys); structural commands
            (New tab/space, Kill) and Stop (Esc, in the Keys dock) live elsewhere. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,text/*,application/pdf"
          multiple
          hidden
          onChange={onPickFiles}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={onPickFiles}
        />
        {/* Display prefs (wrap + font size) on their own compact, right-aligned row. Kept off the
            Keys/Quick/Agent action row below — three extra buttons there overflowed a narrow phone
            and broke the layout. */}
        <div className="mb-2 flex items-center gap-1">
          <SectionLabel>View</SectionLabel>
          <div className="ml-auto flex items-center gap-1">
            {/* Find in output — search the already-fetched pane buffer without leaving the pane.
                Lives here (not the header) so search sits with the other view controls; only shown
                when AgentChat passes a handler (i.e. there's buffered output to search). */}
            {onOpenFind && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground"
                onClick={onOpenFind}
                aria-label="Find in output"
                title="Find in output"
              >
                <Search className="size-3.5" />
              </Button>
            )}
            {/* Raw-terminal escape hatch: turns off the block renderer (native prompt buttons, chrome
                strip, status strip) so a mis-parsed dialog can always be driven by hand with the keys
                pad. Highlighted when active so it's obvious the plain mirror is showing. */}
            <Button
              variant={prefs.rawTerminal ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={() => setRawTerminal(!prefs.rawTerminal)}
              aria-label={
                prefs.rawTerminal
                  ? "Raw terminal on — tap for the enhanced view"
                  : "Raw terminal off — tap to show the plain terminal"
              }
              aria-pressed={prefs.rawTerminal}
              title="Toggle raw terminal (disable native prompt buttons)"
            >
              <Terminal className="size-3.5" />
            </Button>
            <Button
              variant={prefs.wrap ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={() => setWrap(!prefs.wrap)}
              aria-label={prefs.wrap ? "Wrap on — tap to disable" : "Wrap off — tap to enable"}
              aria-pressed={prefs.wrap}
              title="Toggle line wrap"
            >
              <WrapText className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              disabled={prefs.fontSize <= 9}
              onClick={() => stepFontSize(-1)}
              aria-label="Decrease font size"
              title="Smaller text"
            >
              <AArrowDown className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              disabled={prefs.fontSize >= 16}
              onClick={() => stepFontSize(1)}
              aria-label="Increase font size"
              title="Larger text"
            >
              <AArrowUp className="size-3.5" />
            </Button>
          </div>
        </div>
        {/* Keys / Quick dock — a single in-flow site ABOVE the Controls row (so the toggle you tapped
            stays put and the panel grows over the mirror, not the input). Whichever of the mutually
            exclusive drawers is active renders here via the shared ComposerDock chrome. Keys mounts
            the NavTray (unmounts on close, so tab/queue reset each open); Quick mounts the two
            one-tap reply grids. Agent stays a covering BottomSheet below (it's a palette, not a pad). */}
        {drawer === "keys" && (
          <ComposerDock title="Keys" onClose={closeDrawer}>
            <NavTray onSend={pressKeys} disabled={locked} />
          </ComposerDock>
        )}
        {drawer === "quick" && (
          <ComposerDock title="Quick" onClose={closeDrawer}>
            <QuickActionsContent
              onSend={(t) => send(t, false)}
              onClose={closeDrawer}
              disabled={locked || sending || hasUnreadyAttachments}
            />
          </ComposerDock>
        )}
        {/* Action row: Keys · Quick · Agent (Agent only when the pane's agent has commands). */}
        <div className="mb-2 flex items-center gap-2">
          <SectionLabel>Controls</SectionLabel>
          {/* Keys and Quick are TOGGLES for the in-flow dock above (not overlays): tap to open, tap
              again to close. aria-expanded ties each to the dock; secondary variant marks it pressed
              while open. Both share the single-valued `drawer`, so opening one closes the other. */}
          <Button
            variant={drawer === "keys" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 flex-1 gap-1.5 text-muted-foreground"
            disabled={locked}
            aria-expanded={drawer === "keys"}
            onClick={() => setDrawer(drawer === "keys" ? null : "keys")}
          >
            <Keyboard className="size-4" />
            Keys
          </Button>
          <Button
            variant={drawer === "quick" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 flex-1 gap-1.5 text-muted-foreground"
            disabled={locked}
            aria-expanded={drawer === "quick"}
            onClick={() => setDrawer(drawer === "quick" ? null : "quick")}
          >
            <Zap className="size-4" />
            Quick
          </Button>
          {commands.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 flex-1 gap-1.5 text-muted-foreground"
              disabled={locked}
              onClick={() => setDrawer("cmd")}
            >
              <Slash className="size-4" />
              Agent
            </Button>
          )}
        </div>
        {/* Terminal-draft preview: a read-only view of a stranded "❯"-line draft (a message queued
            then recalled on the HOST, which stripChrome hides from the mirror). It appears only after
            the draft stabilises (never a blip/self-echo), then its text tracks the live line — host
            typing streams straight in. It NEVER writes into the phone-owned input; only the explicit
            Take over copies the text here. No dismiss — it's honest state and persists until the user
            takes over, sends, or the host line clears. Same zinc/text-xs chrome as the "You sent:"
            strip above. */}
        {showPreview && effectiveRaw !== null && (
          <TerminalDraftPreview text={effectiveRaw} onTakeOver={takeOverDraft} />
        )}
        {attachments.length > 0 && (
          <div className="mb-2 grid gap-1.5" aria-label="Attachments">
            {attachments.map((item) => (
              <div
                key={item.id}
                className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs"
              >
                {item.previewUrl ? (
                  <img
                    src={item.previewUrl}
                    alt=""
                    className="size-9 shrink-0 rounded object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="flex size-9 shrink-0 items-center justify-center rounded bg-background/70 text-muted-foreground">
                    <FileText className="size-4" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">{item.name}</div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span>{formatBytes(item.size)}</span>
                    {item.status === "uploading" && <span>{item.progress}%</span>}
                    {item.status === "uploaded" && <span>Ready</span>}
                    {item.status === "failed" && <span className="text-destructive">Failed</span>}
                  </div>
                  {item.status === "uploading" && (
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-background/70">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${item.progress}%` }} />
                    </div>
                  )}
                  {item.status === "failed" && item.error && (
                    <div className="mt-0.5 truncate text-destructive">{item.error}</div>
                  )}
                </div>
                {item.status === "failed" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    disabled={locked}
                    onClick={() => retryAttachment(item.id)}
                    aria-label={`Retry ${item.name}`}
                    title="Retry upload"
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground"
                  onClick={() => removeAttachment(item.id)}
                  aria-label={`Remove ${item.name}`}
                  title="Remove attachment"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          {/* Attach files — messenger-style, left of the input, always available (previously buried
              in the keyboard-only quick-key strip). preventDefault keeps the textarea focused so the
              picker opens without the soft keyboard collapsing first. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-full text-muted-foreground"
            disabled={locked || attachments.length >= MAX_ATTACHMENTS}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            aria-label="Attach file"
            title="Attach file"
          >
            <Paperclip className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-full text-muted-foreground"
            disabled={locked || attachments.length >= MAX_ATTACHMENTS}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => cameraRef.current?.click()}
            aria-label="Take photo"
            title="Take photo"
          >
            <Camera className="size-4" />
          </Button>
          <ChatInput
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSendClick();
              }
            }}
            onPaste={onPasteImage}
            placeholder={
              gone
                ? "Pane is gone"
                : readOnly
                  ? "Read-only — device not authorised"
                  : isShell
                    ? "Type a shell command…"
                    : "Type a reply…"
            }
            disabled={locked}
            rows={1}
          />
          {confirmingSend ? (
            <Button
              variant="destructive"
              className="h-11 shrink-0 rounded-full px-4 text-sm font-semibold"
              onClick={onSendClick}
              disabled={locked || !sendText || hasUnreadyAttachments || sending}
              aria-label="Really send?"
            >
              Really send?
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-11 shrink-0 rounded-full"
              onClick={onSendClick}
              disabled={locked || !sendText || hasUnreadyAttachments || sending}
              aria-label="Send"
            >
              {sending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : justSent ? (
                <Check className="size-4" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Slash-command palette */}
      <CommandPalette
        open={drawer === "cmd"}
        onClose={closeDrawer}
        agent={agent}
        onInsert={insertCommand}
        onSubmit={(t) => send(t, false)}
      />
    </>
  );
});
