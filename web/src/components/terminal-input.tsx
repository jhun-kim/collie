import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

import { specialKeyInput } from "@/lib/live-terminal";
import {
  editTerminalDraft,
  nextTextOffset,
  previousTextOffset,
} from "@/lib/terminal-edit";
import type { TerminalDraft } from "@/lib/terminal-edit";

export interface TerminalInputHandle {
  focus: (reopen?: boolean) => void;
  sendKey: (key: string) => void;
}

interface TerminalInputProps {
  enabled: boolean;
  remoteFrame: { draft: TerminalDraft | null; revision: number };
  onSend: (data: string) => void;
}

interface PendingDraft {
  draft: TerminalDraft;
  at: number;
}

const REMOTE_RECOVERY_MS = 1_500;
const EMPTY_DRAFT: TerminalDraft = { text: "", cursor: 0 };

function sameDraft(a: TerminalDraft, b: TerminalDraft): boolean {
  return a.text === b.text && a.cursor === b.cursor;
}

function selectionDraft(text: string, cursor: number): TerminalDraft {
  return { text, cursor };
}

export const TerminalInput = forwardRef<TerminalInputHandle, TerminalInputProps>(function TerminalInput(
  { enabled, remoteFrame, onSend },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<TerminalDraft>(remoteFrame.draft ?? EMPTY_DRAFT);
  const pendingRef = useRef<PendingDraft[]>([]);
  const remoteRef = useRef(remoteFrame);
  const onSendRef = useRef(onSend);
  const composingRef = useRef(false);
  const compositionBaseRef = useRef<TerminalDraft | null>(null);
  const ignoreNextCompositionEndRef = useRef(false);
  const adoptNextRemoteRef = useRef(false);
  const clearedBeforeSpecialRef = useRef<TerminalDraft | null>(null);
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const desiredSelectionRef = useRef<number | null>(modelRef.current.cursor);
  const selectionRef = useRef<{ start: number; end: number }>({
    start: modelRef.current.cursor,
    end: modelRef.current.cursor,
  });
  const [model, setModel] = useState<TerminalDraft>(modelRef.current);

  function setModelDraft(draft: TerminalDraft, selection: number | null = draft.cursor) {
    if (sameDraft(draft, modelRef.current)) return;
    modelRef.current = draft;
    selectionRef.current = { start: draft.cursor, end: draft.cursor };
    desiredSelectionRef.current = selection;
    setModel(draft);
  }

  function setDisplayDraft(draft: TerminalDraft) {
    selectionRef.current = { start: draft.cursor, end: draft.cursor };
    desiredSelectionRef.current = draft.cursor;
    setModel(draft);
  }

  function sendEditFrom(before: TerminalDraft, next: TerminalDraft) {
    if (!enabled) return;
    const data = editTerminalDraft(before, next);
    if (!data) {
      setModelDraft(next);
      return;
    }
    pendingRef.current = [...pendingRef.current, { draft: next, at: Date.now() }];
    setModelDraft(next);
    onSendRef.current(data);
  }

  function focusInput(reopen = false) {
    if (!enabled) return;
    const el = textareaRef.current;
    if (!el) return;
    if (reopen) el.blur();
    el.focus({ preventScroll: true });
  }

  function rememberSelection() {
    const el = textareaRef.current;
    if (!el) return;
    selectionRef.current = {
      start: el.selectionStart ?? modelRef.current.cursor,
      end: el.selectionEnd ?? modelRef.current.cursor,
    };
  }

  function sendEdit(next: TerminalDraft) {
    if (!enabled || composingRef.current) return;
    sendEditFrom(modelRef.current, next);
  }

  function scheduleRecovery() {
    if (recoverTimerRef.current) clearTimeout(recoverTimerRef.current);
    const latest = pendingRef.current[pendingRef.current.length - 1];
    const delay = latest ? Math.max(0, REMOTE_RECOVERY_MS - (Date.now() - latest.at)) : REMOTE_RECOVERY_MS;
    recoverTimerRef.current = setTimeout(() => {
      recoverTimerRef.current = null;
      if (composingRef.current || pendingRef.current.length === 0) return;
      const currentLatest = pendingRef.current[pendingRef.current.length - 1];
      if (currentLatest && Date.now() - currentLatest.at < REMOTE_RECOVERY_MS) {
        scheduleRecovery();
        return;
      }
      pendingRef.current = [];
      if (remoteRef.current.draft) setModelDraft(remoteRef.current.draft);
    }, delay);
  }

  function reconcileRemote(frame: TerminalInputProps["remoteFrame"]) {
    remoteRef.current = frame;
    if (composingRef.current) return;
    const remoteDraft = frame.draft;
    const clearedBeforeSpecial = clearedBeforeSpecialRef.current;
    if (clearedBeforeSpecial) {
      if (remoteDraft === null) {
        clearedBeforeSpecialRef.current = null;
        return;
      }
      if (sameDraft(remoteDraft, clearedBeforeSpecial)) return;
      clearedBeforeSpecialRef.current = null;
    }
    if (remoteDraft === null) return;
    if (adoptNextRemoteRef.current) {
      adoptNextRemoteRef.current = false;
      pendingRef.current = [];
      setModelDraft(remoteDraft);
      return;
    }
    const pending = pendingRef.current;
    if (pending.length === 0) {
      setModelDraft(remoteDraft);
      return;
    }
    const matchIndex = pending.findIndex((entry) => sameDraft(entry.draft, remoteDraft));
    if (matchIndex >= 0) {
      pendingRef.current = pending.slice(matchIndex + 1);
      if (pendingRef.current.length === 0) setModelDraft(remoteDraft);
      return;
    }
    const latest = pending[pending.length - 1];
    if (latest && Date.now() - latest.at >= REMOTE_RECOVERY_MS) {
      pendingRef.current = [];
      setModelDraft(remoteDraft);
      return;
    }
    scheduleRecovery();
  }

  function sendSpecialAndAdopt(key: string, clear = false) {
    if (!enabled) return;
    const data = specialKeyInput(key);
    if (!data) return;
    pendingRef.current = [];
    if (clear) {
      clearedBeforeSpecialRef.current = modelRef.current;
      adoptNextRemoteRef.current = false;
      setModelDraft(EMPTY_DRAFT);
    } else {
      clearedBeforeSpecialRef.current = null;
      adoptNextRemoteRef.current = true;
    }
    onSendRef.current(data);
  }

  function finishCompositionIfNeeded() {
    if (!composingRef.current) return;
    const el = textareaRef.current;
    composingRef.current = false;
    ignoreNextCompositionEndRef.current = true;
    if (!el) return;
    const next = selectionDraft(el.value, el.selectionStart ?? el.value.length);
    sendEditFrom(compositionBaseRef.current ?? modelRef.current, next);
    compositionBaseRef.current = null;
  }

  function syncCollapsedCaretFromElement() {
    const el = textareaRef.current;
    if (!el || composingRef.current) return;
    rememberSelection();
    if (selectionRef.current.start !== selectionRef.current.end) return;
    const next = selectionDraft(el.value, selectionRef.current.start);
    if (sameDraft(next, modelRef.current)) return;
    sendEdit(next);
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    if (!enabled) return;
    const el = event.currentTarget;
    if (composingRef.current) {
      setDisplayDraft(selectionDraft(el.value, el.selectionStart ?? el.value.length));
      return;
    }
    sendEdit(selectionDraft(el.value, el.selectionStart ?? el.value.length));
  }

  function moveCaret(to: number) {
    sendEdit({ text: modelRef.current.text, cursor: to });
  }

  function deleteSelectionOrPrevious() {
    const el = textareaRef.current;
    const current = modelRef.current;
    if (el) rememberSelection();
    const start = selectionRef.current.start;
    const end = selectionRef.current.end;
    if (start !== end) {
      sendEdit({ text: current.text.slice(0, start) + current.text.slice(end), cursor: start });
      return;
    }
    const previous = previousTextOffset(current.text, current.cursor);
    if (previous === current.cursor) return;
    sendEdit({ text: current.text.slice(0, previous) + current.text.slice(current.cursor), cursor: previous });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!enabled) {
      event.preventDefault();
      return;
    }
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      sendSpecialAndAdopt("Enter", true);
      return;
    }
    if (event.key === "c" && event.ctrlKey) {
      event.preventDefault();
      sendSpecialAndAdopt("Ctrl+C", true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      sendSpecialAndAdopt(event.shiftKey ? "Shift+Tab" : "Tab");
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      sendSpecialAndAdopt(event.key);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      sendSpecialAndAdopt("Escape");
      return;
    }
    if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveCaret(previousTextOffset(modelRef.current.text, modelRef.current.cursor));
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveCaret(nextTextOffset(modelRef.current.text, modelRef.current.cursor));
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      focus: focusInput,
      sendKey: (key: string) => {
        if (!enabled) return;
        focusInput();
        finishCompositionIfNeeded();
        if (key === "Backspace") {
          deleteSelectionOrPrevious();
          return;
        }
        if (key === "ArrowLeft") {
          moveCaret(previousTextOffset(modelRef.current.text, modelRef.current.cursor));
          return;
        }
        if (key === "ArrowRight") {
          moveCaret(nextTextOffset(modelRef.current.text, modelRef.current.cursor));
          return;
        }
        if (key === "Enter" || key === "Ctrl+C") {
          sendSpecialAndAdopt(key, true);
          return;
        }
        if (key === "Escape") {
          sendSpecialAndAdopt(key);
          return;
        }
        if (key === "Tab" || key === "Shift+Tab" || key === "ArrowUp" || key === "ArrowDown") {
          sendSpecialAndAdopt(key);
        }
      },
    }),
    [enabled],
  );

  useEffect(() => {
    onSendRef.current = onSend;
  });

  useEffect(() => () => {
    if (recoverTimerRef.current) clearTimeout(recoverTimerRef.current);
  }, []);

  useEffect(() => {
    reconcileRemote(remoteFrame);
  }, [remoteFrame]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    const cursor = desiredSelectionRef.current;
    if (!el || composingRef.current || cursor === null || document.activeElement !== el) return;
    el.setSelectionRange(cursor, cursor);
    desiredSelectionRef.current = null;
  }, [model]);

  return (
    <textarea
      ref={textareaRef}
      aria-label="Terminal input"
      disabled={!enabled}
      placeholder="Terminal input"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      value={model.text}
      rows={1}
      onChange={handleChange}
      onClick={syncCollapsedCaretFromElement}
      onKeyUp={syncCollapsedCaretFromElement}
      onKeyDown={handleKeyDown}
      onSelect={rememberSelection}
      onCompositionStart={() => {
        ignoreNextCompositionEndRef.current = false;
        composingRef.current = true;
        compositionBaseRef.current = modelRef.current;
      }}
      onCompositionEnd={(event) => {
        if (ignoreNextCompositionEndRef.current) {
          ignoreNextCompositionEndRef.current = false;
          return;
        }
        composingRef.current = false;
        const el = event.currentTarget;
        const next = selectionDraft(el.value, el.selectionStart ?? el.value.length);
        sendEditFrom(compositionBaseRef.current ?? modelRef.current, next);
        compositionBaseRef.current = null;
      }}
    />
  );
});
