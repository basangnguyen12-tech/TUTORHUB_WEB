import {
  APIRequestError,
  type ActiveMessage,
  type Conversation,
  type Message,
  type MessageAttachment,
  type Sticker,
} from "@tutorhub/api-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@tutorhub/ui";
import {
  ArrowDown,
  Copy,
  Download,
  FileText,
  ImageIcon,
  MessagesSquare,
  Paperclip,
  Pencil,
  RotateCcw,
  SendHorizontal,
  SquareCode,
  Trash2,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useSendConversationMessage } from "../../app/conversations";
import { useI18n, type TranslationKey } from "../../app/i18n";
import type { ChatCodeToken } from "../classroom-tools/chatCodeHighlight";
import { splitChatCodeBlocks } from "../classroom-tools/codeFence";
import {
  supportsChatDocument,
  type ChatDocumentReference,
} from "../classroom-tools/documentReference";
import "../classroom-tools/ChatDocumentActions.css";
import {
  CODE_LANGUAGES,
  type CodeFileLanguage,
} from "../classroom-tools/codeLanguages";
import { ChatExpressionPicker, ChatStickerView } from "./ChatExpressionPicker";
import {
  CHAT_COUNTER_THRESHOLD,
  CHAT_FILE_ACCEPT,
  CHAT_IMAGE_ACCEPT,
  CHAT_MAX_ATTACHMENTS,
  CHAT_MAX_MESSAGE_CHARACTERS,
  attachmentCacheKey,
  chatAvatarTone,
  chatInitials,
  chatMentionNames,
  chatStickerLabel,
  checkChatFile,
  createAttachmentObjectURLCache,
  createClientID,
  fileTypeLabel,
  formatAttachmentSize,
  isJumboEmoji,
  linkifyChatText,
  prefetchClassroomEmojiCatalog,
  prepareChatImage,
  subscribeClassroomChatComposer,
  type AttachmentObjectURLCache,
  type ClassroomChatComposerStore,
  type ClassroomChatStagedAttachment,
} from "./classroomChatMedia";

/** ROOM-TOOLS-CODE-01: a fenced block handed to the Code tool. */
export interface ClassroomChatCodeBlock {
  code: string;
  language: CodeFileLanguage | null;
}

export type {
  ClassroomChatComposerStore,
  ClassroomChatStagedAttachment,
} from "./classroomChatMedia";

/**
 * ROOM-CHAT-01 (ADR-0042) classroom messenger: host posting switch, calm
 * read-only notice, bottom-anchored stream with day pills and same-author
 * grouping, and a Teams-style composer with emoji, images, files, paste and
 * drag-and-drop. Data and mutations come from the caller, so the panel is
 * deterministic in tests and fixtures.
 */

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 80;

export interface ClassroomChatSendInput {
  attachmentIDs: string[];
  clientMessageID: string;
  content: string;
}

/** MSG-STICKER-03: one catalog sticker sent as its own message. */
export interface ClassroomChatStickerInput {
  clientMessageID: string;
  stickerID: string;
}

export interface ClassroomChatUploadInput {
  clientAttachmentID: string;
  file: Blob;
  fileName: string;
  heightPx?: number;
  widthPx?: number;
}

export interface ClassroomChatPanelProps {
  onOpenDocument?: (reference: ChatDocumentReference) => Promise<void>;
  onOpenAttachment?: (attachment: MessageAttachment) => Promise<void>;
  onSaveAttachment?: (attachment: MessageAttachment) => Promise<void>;
  actorID: string;
  attachmentCache?: AttachmentObjectURLCache;
  composerStore?: ClassroomChatComposerStore;
  conversation: Conversation;
  hasOlder: boolean;
  loadingOlder: boolean;
  messages: readonly Message[];
  open: boolean;
  tenantID: string;
  loadAttachment: (attachment: MessageAttachment) => Promise<Blob>;
  onDelete: (message: ActiveMessage) => Promise<void>;
  onEdit: (message: ActiveMessage, content: string) => Promise<void>;
  onLoadOlder: () => void;
  onSend: (input: ClassroomChatSendInput) => Promise<void>;
  /**
   * MSG-STICKER-03: sends a sticker message. Without it the panel sends
   * through the shared conversation mutation (same cache as `onSend`).
   */
  onSendSticker?: (input: ClassroomChatStickerInput) => Promise<void>;
  onToggleParticipantChat: (enabled: boolean) => Promise<void>;
  onUpload: (input: ClassroomChatUploadInput) => Promise<MessageAttachment>;
  /**
   * ROOM-TOOLS-CODE-01: opens a code card's block as a new tab in the Code
   * tool (never runs it). Without it, code cards only offer Copy.
   */
  onOpenInCode?: (block: ClassroomChatCodeBlock) => void;
  /** Test seam; defaults to the canvas EXIF-stripping re-encoder. */
  prepareImage?: typeof prepareChatImage;
}

function characterCount(value: string) {
  return Array.from(value).length;
}

function problemKey(error: unknown, fallback: TranslationKey): TranslationKey {
  if (!(error instanceof APIRequestError)) return fallback;
  const code = error.problem?.code;
  if (code === "conversation_read_only") return "media.chat.readOnlyPaused";
  if (code === "conversation_attachment_unavailable") {
    return "media.chat.attachmentExpired";
  }
  if (code === "conversation_attachment_unsupported" || error.status === 415) {
    return "media.chat.uploadType";
  }
  if (code === "conversation_attachment_too_large" || error.status === 413) {
    return "media.chat.uploadSize";
  }
  if (error.status === 429) return "media.chat.rateLimited";
  return fallback;
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

interface DayGroup {
  key: string;
  date: Date;
  items: { message: Message; grouped: boolean }[];
}

function groupMessages(messages: readonly Message[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let previous: Message | null = null;
  for (const message of messages) {
    const date = new Date(message.created_at);
    const key = dayKey(date);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, date, items: [] };
      groups.push(group);
      previous = null;
    }
    const grouped =
      previous !== null &&
      previous.author.user_id === message.author.user_id &&
      previous.state === "active" &&
      message.state === "active" &&
      date.getTime() - new Date(previous.created_at).getTime() <=
        GROUP_WINDOW_MS;
    group.items.push({ message, grouped });
    previous = message;
  }
  return groups;
}

export function ClassroomChatPanel({
  actorID,
  attachmentCache,
  composerStore,
  conversation,
  hasOlder,
  loadingOlder,
  messages,
  open,
  tenantID,
  loadAttachment,
  onDelete,
  onEdit,
  onLoadOlder,
  onSend,
  onSendSticker,
  onToggleParticipantChat,
  onUpload,
  onOpenInCode,
  onOpenDocument,
  onOpenAttachment,
  onSaveAttachment,
  prepareImage = prepareChatImage,
}: ClassroomChatPanelProps) {
  const { language, t } = useI18n();
  const id = useId();
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const viewer = conversation.viewer_access;
  const canPost = viewer.can_post_messages;
  const canModerate = viewer.can_moderate_chat === true;
  const canUpload = canPost && viewer.can_upload_attachments === true;
  const participantChatEnabled =
    conversation.participant_chat_enabled !== false;
  const roomEnded =
    conversation.media_space_status !== undefined &&
    conversation.media_space_status !== "open";

  const [ownCache] = useState(() =>
    attachmentCache ? null : createAttachmentObjectURLCache(),
  );
  const cache = attachmentCache ?? ownCache;
  useEffect(() => () => ownCache?.revokeAll(), [ownCache]);

  const [draft, setDraftState] = useState(() => composerStore?.draft ?? "");
  const [staged, setStagedState] = useState<ClassroomChatStagedAttachment[]>(
    () => composerStore?.staged ?? [],
  );
  const stagedRef = useRef(staged);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (!composerStore) {
        for (const item of stagedRef.current) {
          if (item.previewURL) URL.revokeObjectURL(item.previewURL);
        }
      }
    };
  }, [composerStore]);

  const setDraft = useCallback(
    (value: string) => {
      if (composerStore) composerStore.draft = value;
      setDraftState(value);
    },
    [composerStore],
  );
  const updateStaged = useCallback(
    (
      update: (
        items: ClassroomChatStagedAttachment[],
      ) => ClassroomChatStagedAttachment[],
    ) => {
      const next = update(stagedRef.current);
      stagedRef.current = next;
      if (composerStore) composerStore.staged = next;
      if (mountedRef.current) setStagedState(next);
    },
    [composerStore],
  );

  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [switchPending, setSwitchPending] = useState(false);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editPending, setEditPending] = useState(false);
  const [lightbox, setLightbox] = useState<MessageAttachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const dragDepth = useRef(0);
  const pendingSend = useRef<ClassroomChatSendInput | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiScope = useMemo(
    () => ({ actorID, tenantID }),
    [actorID, tenantID],
  );
  // MSG-MENTION-BLUE-01: "@Name" of room members renders in blue.
  const mentionNames = useMemo(
    () =>
      chatMentionNames([
        ...conversation.participants.map(
          (participant) => participant.display_name,
        ),
        ...messages.map((message) => message.author.display_name),
      ]),
    [conversation.participants, messages],
  );
  const fallbackStickerSend = useSendConversationMessage(
    tenantID,
    conversation.id,
  );
  const sendStickerMutation = fallbackStickerSend.mutateAsync;
  const [stickerFailure, setStickerFailure] = useState<{
    clientMessageID: string;
    message: string;
    sticker: Sticker;
  } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const forceScroll = useRef(true);
  const lastSeenSequence = useRef(0);
  const prependAnchor = useRef<{
    firstID: string | undefined;
    height: number;
    top: number;
  } | null>(null);
  const wasOpen = useRef(open);
  const firstMessageID = messages[0]?.id;
  const newest = messages[messages.length - 1];

  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    [locale],
  );
  const dayFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "long",
        weekday: "long",
      }),
    [locale],
  );
  const dayLabel = (date: Date) => {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (dayKey(date) === dayKey(today)) return t("media.chat.today");
    if (dayKey(date) === dayKey(yesterday)) return t("media.chat.yesterday");
    return dayFormatter.format(date);
  };
  const groups = useMemo(() => groupMessages(messages), [messages]);

  const scrollToBottom = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.scrollTop = stream.scrollHeight;
    nearBottom.current = true;
    setShowJump(false);
  }, []);

  // Reopening the inspector jumps to the newest message once.
  useLayoutEffect(() => {
    if (open && !wasOpen.current) forceScroll.current = true;
    wasOpen.current = open;
  }, [open]);

  useLayoutEffect(() => {
    const stream = streamRef.current;
    const anchor = prependAnchor.current;
    if (stream && anchor && anchor.firstID !== firstMessageID) {
      // Older history was prepended: keep the reader's place.
      stream.scrollTop = anchor.top + (stream.scrollHeight - anchor.height);
      prependAnchor.current = null;
    }
  }, [firstMessageID]);

  useEffect(() => {
    if (!loadingOlder) prependAnchor.current = null;
  }, [loadingOlder]);

  useLayoutEffect(() => {
    const sequence = newest?.sequence ?? 0;
    if (forceScroll.current || nearBottom.current) {
      forceScroll.current = false;
      scrollToBottom();
    } else if (sequence > lastSeenSequence.current) {
      setShowJump(true);
    }
    lastSeenSequence.current = Math.max(lastSeenSequence.current, sequence);
  }, [newest?.sequence, newest?.id, open, scrollToBottom]);

  const onStreamScroll = () => {
    const stream = streamRef.current;
    if (!stream) return;
    nearBottom.current =
      stream.scrollHeight - stream.scrollTop - stream.clientHeight <=
      NEAR_BOTTOM_PX;
    if (nearBottom.current) setShowJump(false);
  };

  const loadOlder = () => {
    const stream = streamRef.current;
    if (stream) {
      prependAnchor.current = {
        firstID: firstMessageID,
        height: stream.scrollHeight,
        top: stream.scrollTop,
      };
    }
    onLoadOlder();
  };

  const resizeComposer = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);
  useLayoutEffect(resizeComposer, [draft, resizeComposer]);

  // ROOM-TOOLS-CODE-01: the Code tool's "Send to chat" prefills the composer
  // store. Pick the text up live (or on mount when the inspector was closed)
  // and move focus to the composer so the person reviews it and presses Send.
  useEffect(() => {
    if (!composerStore) return undefined;
    const focusComposer = () => {
      if (!composerStore.focusRequested) return;
      composerStore.focusRequested = false;
      // After the inspector's own open auto-focus has run.
      globalThis.setTimeout(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
      }, 0);
    };
    focusComposer();
    return subscribeClassroomChatComposer(composerStore, () => {
      setDraftState(composerStore.draft);
      focusComposer();
    });
  }, [composerStore]);

  // ROOM-CHAT-EMOJI-02: after an emoji lands, park the caret right after it
  // (without stealing focus from the picker) so the next pick follows it.
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    textareaRef.current?.setSelectionRange(caret, caret);
  }, [draft]);

  // Warm the emoji data chunk once Chat is open and the viewer can post.
  useEffect(() => {
    if (!canPost) return undefined;
    const idle = globalThis.requestIdleCallback;
    if (typeof idle === "function") {
      const handle = idle(() => prefetchClassroomEmojiCatalog(), {
        timeout: 2_000,
      });
      return () => globalThis.cancelIdleCallback?.(handle);
    }
    const timer = globalThis.setTimeout(prefetchClassroomEmojiCatalog, 300);
    return () => globalThis.clearTimeout(timer);
  }, [canPost]);

  const uploadItem = useCallback(
    async (item: ClassroomChatStagedAttachment) => {
      try {
        let blob: Blob = item.file;
        let fileName = item.name;
        let widthPx: number | undefined;
        let heightPx: number | undefined;
        if (item.kind === "image") {
          try {
            const prepared = await prepareImage(item.file, item.mediaType);
            blob = prepared.blob;
            fileName = prepared.fileName;
            widthPx = prepared.width;
            heightPx = prepared.height;
          } catch {
            updateStaged((items) =>
              items.map((current) =>
                current.localID === item.localID
                  ? {
                      ...current,
                      problem: "media.chat.imageFailed",
                      status: "error",
                    }
                  : current,
              ),
            );
            return;
          }
        }
        const attachment = await onUpload({
          clientAttachmentID: item.clientAttachmentID,
          file: blob,
          fileName,
          heightPx,
          widthPx,
        });
        updateStaged((items) =>
          items.map((current) =>
            current.localID === item.localID
              ? {
                  ...current,
                  attachment,
                  problem: undefined,
                  status: "ready",
                }
              : current,
          ),
        );
      } catch (error) {
        updateStaged((items) =>
          items.map((current) =>
            current.localID === item.localID
              ? {
                  ...current,
                  problem: problemKey(error, "media.chat.uploadFailed"),
                  status: "error",
                }
              : current,
          ),
        );
      }
    },
    [onUpload, prepareImage, updateStaged],
  );

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (!canUpload || files.length === 0) return;
      setComposerError(null);
      const capacity = CHAT_MAX_ATTACHMENTS - stagedRef.current.length;
      const accepted: ClassroomChatStagedAttachment[] = [];
      let message: string | null = null;
      for (const file of files) {
        const check = checkChatFile(file);
        if (!check.ok) {
          message = t(
            check.problem === "size"
              ? "media.chat.sizeRejected"
              : "media.chat.typeRejected",
            { name: file.name || "file" },
          );
          continue;
        }
        if (accepted.length >= capacity) {
          message = t("media.chat.tooMany", { count: CHAT_MAX_ATTACHMENTS });
          break;
        }
        accepted.push({
          clientAttachmentID: createClientID(),
          file,
          kind: check.kind,
          localID: createClientID(),
          mediaType: check.mediaType,
          name: file.name || (check.kind === "image" ? "image.png" : "file"),
          previewURL:
            check.kind === "image" ? URL.createObjectURL(file) : undefined,
          size: file.size,
          status: "uploading",
        });
      }
      if (message) setComposerError(message);
      if (accepted.length === 0) return;
      updateStaged((items) => [...items, ...accepted]);
      for (const item of accepted) void uploadItem(item);
    },
    [canUpload, t, updateStaged, uploadItem],
  );

  const removeStaged = (localID: string) => {
    updateStaged((items) => {
      const removed = items.find((item) => item.localID === localID);
      if (removed?.previewURL) URL.revokeObjectURL(removed.previewURL);
      return items.filter((item) => item.localID !== localID);
    });
    textareaRef.current?.focus();
  };

  const retryStaged = (localID: string) => {
    const item = stagedRef.current.find(
      (current) => current.localID === localID,
    );
    if (!item) return;
    const next = { ...item, problem: undefined, status: "uploading" as const };
    updateStaged((items) =>
      items.map((current) => (current.localID === localID ? next : current)),
    );
    void uploadItem(next);
  };

  const trimmed = draft.trim();
  const count = characterCount(draft);
  const tooLong = count > CHAT_MAX_MESSAGE_CHARACTERS;
  const uploading = staged.some((item) => item.status === "uploading");
  const failed = staged.some((item) => item.status === "error");
  const readyIDs = staged.flatMap((item) =>
    item.status === "ready" && item.attachment ? [item.attachment.id] : [],
  );
  const canSend =
    canPost &&
    !sending &&
    !uploading &&
    !failed &&
    !tooLong &&
    (trimmed.length > 0 || readyIDs.length > 0);

  const submit = async () => {
    if (!canSend) return;
    const previous = pendingSend.current;
    const input: ClassroomChatSendInput =
      previous &&
      previous.content === trimmed &&
      previous.attachmentIDs.join() === readyIDs.join()
        ? previous
        : {
            attachmentIDs: readyIDs,
            clientMessageID: createClientID(),
            content: trimmed,
          };
    pendingSend.current = input;
    setEmojiOpen(false);
    setSending(true);
    setComposerError(null);
    forceScroll.current = true;
    try {
      await onSend(input);
      pendingSend.current = null;
      setDraft("");
      updateStaged((items) => {
        for (const item of items) {
          if (item.previewURL) URL.revokeObjectURL(item.previewURL);
        }
        return [];
      });
    } catch (error) {
      setComposerError(t(problemKey(error, "media.chat.sendFailed")));
    } finally {
      if (mountedRef.current) {
        setSending(false);
        textareaRef.current?.focus();
      }
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      void submit();
    }
  };

  const onComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0 || !canUpload) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    addFiles(files);
  };

  // MSG-STICKER-03: a picked sticker is its own message; the draft stays.
  const sendSticker = async (
    sticker: Sticker,
    clientMessageID: string = createClientID(),
  ) => {
    const label = chatStickerLabel(sticker.labels, language);
    setStickerFailure(null);
    forceScroll.current = true;
    try {
      if (onSendSticker) {
        await onSendSticker({ clientMessageID, stickerID: sticker.id });
      } else {
        await sendStickerMutation({
          client_message_id: clientMessageID,
          content: "",
          embed: { kind: "sticker", sticker_id: sticker.id },
        });
      }
      if (mountedRef.current) {
        setAnnouncement(t("conversations.stickerSent", { label }));
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setStickerFailure({
        clientMessageID,
        message: t(problemKey(error, "media.chat.sendFailed")),
        sticker,
      });
    }
  };

  // Multi-pick: the textarea keeps its caret while focus stays in the picker.
  const insertEmoji = (emoji: string) => {
    const element = textareaRef.current;
    const current = element?.value ?? draft;
    const start = element?.selectionStart ?? current.length;
    const end = element?.selectionEnd ?? current.length;
    pendingCaret.current = start + emoji.length;
    setDraft(`${current.slice(0, start)}${emoji}${current.slice(end)}`);
  };

  const onPick =
    (input: RefObject<HTMLInputElement | null>) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(event.target.files ?? []));
      event.target.value = "";
      if (input.current) input.current.value = "";
    };

  const toggleSwitch = async () => {
    setSwitchPending(true);
    setAnnouncement("");
    try {
      await onToggleParticipantChat(!participantChatEnabled);
      setAnnouncement(
        t(
          participantChatEnabled
            ? "media.chat.switchOffAnnouncement"
            : "media.chat.switchOnAnnouncement",
        ),
      );
    } catch {
      setAnnouncement(t("media.chat.switchFailed"));
    } finally {
      setSwitchPending(false);
    }
  };

  const startEdit = (message: ActiveMessage) => {
    setEditingID(message.id);
    setEditDraft(message.content);
  };

  useEffect(() => {
    if (!editingID) return;
    const element = document.getElementById(`${id}-edit-${editingID}`);
    if (element instanceof HTMLTextAreaElement) {
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    }
  }, [editingID, id]);

  const saveEdit = async (message: ActiveMessage) => {
    const next = editDraft.trim();
    if (!next || characterCount(next) > CHAT_MAX_MESSAGE_CHARACTERS) return;
    if (next === message.content) {
      setEditingID(null);
      return;
    }
    setEditPending(true);
    try {
      await onEdit(message, next);
      setEditingID(null);
    } catch (error) {
      setAnnouncement(t(problemKey(error, "media.chat.editFailed")));
    } finally {
      setEditPending(false);
    }
  };

  const remove = async (message: ActiveMessage) => {
    try {
      await onDelete(message);
      setAnnouncement(t("media.chat.deletedAnnouncement"));
    } catch (error) {
      setAnnouncement(t(problemKey(error, "media.chat.deleteFailed")));
    }
  };

  const copy = async (message: ActiveMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setAnnouncement(t("media.chat.copied"));
    } catch {
      setAnnouncement(t("media.chat.copyFailed"));
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setAnnouncement(t("media.chat.codeCopied"));
    } catch {
      setAnnouncement(t("media.chat.copyFailed"));
    }
  };

  // Received code never runs: it only becomes a new tab in the Code tool.
  const openInCode = onOpenInCode
    ? (block: ClassroomChatCodeBlock) => {
        onOpenInCode(block);
        setAnnouncement(t("media.chat.codeOpened"));
      }
    : undefined;

  const objectURLFor = useCallback(
    (attachment: MessageAttachment) =>
      cache
        ? cache.get(attachmentCacheKey(tenantID, attachment.id), () =>
            loadAttachment(attachment),
          )
        : Promise.reject(new Error("Attachment cache is unavailable.")),
    [cache, loadAttachment, tenantID],
  );

  const download = async (attachment: MessageAttachment) => {
    try {
      const url = await objectURLFor(attachment);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.display_name;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      setAnnouncement(t("media.chat.downloadFailed"));
    }
  };

  const hasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files");
  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!canUpload || !hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!canUpload || !hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = () => {
    if (!dragging) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!canUpload) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const readOnlyReason: TranslationKey = roomEnded
    ? "media.chat.readOnlyEnded"
    : !participantChatEnabled
      ? "media.chat.readOnlyPaused"
      : "media.chat.readOnlyGeneric";
  const switchLabelID = `${id}-switch-label`;
  const switchHintID = `${id}-switch-hint`;
  const composerHintID = `${id}-composer-hint`;
  const counterID = `${id}-counter`;

  return (
    <section
      aria-label={t("media.p408.title")}
      className="classroom-chat"
      data-dragging={dragging || undefined}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {canModerate && (
        <div className="classroom-chat__host-card">
          <div className="classroom-chat__host-copy">
            <span className="classroom-chat__host-label" id={switchLabelID}>
              {t("media.chat.hostSwitch")}
            </span>
            <span className="classroom-chat__host-hint" id={switchHintID}>
              {t("media.chat.hostSwitchHint")}
            </span>
          </div>
          <button
            aria-checked={participantChatEnabled}
            aria-describedby={switchHintID}
            aria-labelledby={switchLabelID}
            className="classroom-chat__switch"
            disabled={switchPending}
            onClick={() => void toggleSwitch()}
            role="switch"
            type="button"
          >
            <span aria-hidden="true" className="classroom-chat__switch-knob" />
          </button>
        </div>
      )}

      {!canPost && (
        <p className="classroom-chat__notice" role="status">
          {t(readOnlyReason)}
        </p>
      )}

      <div
        aria-label={t("media.chat.streamLabel")}
        className="classroom-chat__stream"
        onScroll={onStreamScroll}
        ref={streamRef}
        role="log"
        tabIndex={0}
      >
        {hasOlder && (
          <button
            className="classroom-chat__older"
            disabled={loadingOlder}
            onClick={loadOlder}
            type="button"
          >
            {t(
              loadingOlder ? "media.chat.loadingOlder" : "media.chat.loadOlder",
            )}
          </button>
        )}
        {messages.length === 0 ? (
          <div className="classroom-chat__empty">
            <span aria-hidden="true" className="classroom-chat__empty-icon">
              <MessagesSquare />
            </span>
            <p className="classroom-chat__empty-title">
              {t("media.chat.emptyTitle")}
            </p>
            <p className="classroom-chat__empty-hint">
              {t(canPost ? "media.chat.emptyHint" : "media.chat.emptyReadOnly")}
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section
              aria-label={dayLabel(group.date)}
              className="classroom-chat__day"
              key={group.key}
            >
              <p aria-hidden="true" className="classroom-chat__day-pill">
                <span>{dayLabel(group.date)}</span>
              </p>
              <ol className="classroom-chat__messages">
                {group.items.map(({ grouped, message }) => {
                  const own = message.author.user_id === actorID;
                  const created = new Date(message.created_at);
                  const time = timeFormatter.format(created);
                  const author = own
                    ? t("media.chat.you")
                    : message.author.display_name;
                  const active = message.state === "active" ? message : null;
                  const attachments = active?.attachments ?? [];
                  const jumbo =
                    active !== null &&
                    attachments.length === 0 &&
                    isJumboEmoji(active.content);
                  const editing = active !== null && editingID === message.id;
                  return (
                    <li
                      className="classroom-chat__message"
                      data-grouped={grouped || undefined}
                      data-own={own || undefined}
                      data-state={message.state}
                      key={message.id}
                    >
                      {!own && (
                        <span
                          aria-hidden="true"
                          className="classroom-chat__avatar"
                          data-hidden={grouped || undefined}
                          data-tone={chatAvatarTone(
                            message.author.display_name,
                          )}
                        >
                          {grouped
                            ? ""
                            : chatInitials(message.author.display_name)}
                        </span>
                      )}
                      <div className="classroom-chat__column">
                        {grouped ? (
                          <span className="classroom-chat__sr">
                            {`${author}, ${time}`}
                          </span>
                        ) : (
                          <p className="classroom-chat__meta">
                            {!own && (
                              <strong className="classroom-chat__author">
                                {author}
                              </strong>
                            )}
                            {own && (
                              <span className="classroom-chat__sr">
                                {author}
                              </span>
                            )}
                            <time dateTime={message.created_at}>{time}</time>
                            {active?.edited_at && (
                              <span className="classroom-chat__edited">
                                {t("media.chat.edited")}
                              </span>
                            )}
                          </p>
                        )}
                        {grouped && active?.edited_at && (
                          <span className="classroom-chat__edited classroom-chat__edited--inline">
                            {t("media.chat.edited")}
                          </span>
                        )}
                        {active === null ? (
                          <p className="classroom-chat__tombstone">
                            {t("media.chat.deleted")}
                          </p>
                        ) : editing ? (
                          <div className="classroom-chat__edit">
                            <label
                              className="classroom-chat__sr"
                              htmlFor={`${id}-edit-${message.id}`}
                            >
                              {t("media.chat.editLabel")}
                            </label>
                            <textarea
                              className="classroom-chat__edit-input"
                              disabled={editPending}
                              id={`${id}-edit-${message.id}`}
                              onChange={(event) =>
                                setEditDraft(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setEditingID(null);
                                } else if (
                                  event.key === "Enter" &&
                                  !event.shiftKey &&
                                  !event.nativeEvent.isComposing
                                ) {
                                  event.preventDefault();
                                  void saveEdit(active);
                                }
                              }}
                              rows={2}
                              value={editDraft}
                            />
                            <div className="classroom-chat__edit-actions">
                              <span className="classroom-chat__edit-hint">
                                {t("media.chat.editHint")}
                              </span>
                              <button
                                className="classroom-chat__text-button"
                                onClick={() => setEditingID(null)}
                                type="button"
                              >
                                {t("media.chat.cancel")}
                              </button>
                              <button
                                className="classroom-chat__text-button classroom-chat__text-button--primary"
                                disabled={
                                  editPending || editDraft.trim().length === 0
                                }
                                onClick={() => void saveEdit(active)}
                                type="button"
                              >
                                {t("media.chat.save")}
                              </button>
                            </div>
                          </div>
                        ) : active.embed?.kind === "sticker" ? (
                          <div className="classroom-chat__sticker">
                            <ChatStickerView embed={active.embed} size={128} />
                          </div>
                        ) : (
                          active.content && (
                            <ChatBubble
                              jumbo={jumbo}
                              mentions={mentionNames}
                              onCopyCode={(code) => void copyCode(code)}
                              onOpenInCode={openInCode}
                              onOpenDocument={onOpenDocument}
                              text={active.content}
                            />
                          )
                        )}
                        {active !== null && attachments.length > 0 && (
                          <ul
                            aria-label={t("media.chat.attachmentsLabel")}
                            className="classroom-chat__attachments"
                          >
                            {attachments.map((attachment) => (
                              <li key={attachment.id}>
                                {attachment.kind === "image" ? (
                                  <ChatImage
                                    attachment={attachment}
                                    load={objectURLFor}
                                    onOpen={() => setLightbox(attachment)}
                                  />
                                ) : (
                                  <ChatFileCard
                                    attachment={attachment}
                                    language={language}
                                    onDownload={() => void download(attachment)}
                                    actions={
                                      <ChatAttachmentActions
                                        attachment={attachment}
                                        onOpen={onOpenAttachment}
                                        onSave={
                                          roomEnded
                                            ? undefined
                                            : onSaveAttachment
                                        }
                                      />
                                    }
                                  />
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                        {active !== null && !editing && (
                          <div
                            aria-label={t("media.chat.actionsLabel")}
                            className="classroom-chat__tools"
                            role="toolbar"
                          >
                            {own && canPost && !active.embed && (
                              <button
                                aria-label={t("media.chat.edit")}
                                className="classroom-chat__tool-button"
                                data-tooltip={t("media.chat.edit")}
                                onClick={() => startEdit(active)}
                                type="button"
                              >
                                <Pencil aria-hidden="true" />
                              </button>
                            )}
                            {own && canPost && (
                              <button
                                aria-label={t("media.chat.delete")}
                                className="classroom-chat__tool-button"
                                data-tooltip={t("media.chat.delete")}
                                onClick={() => void remove(active)}
                                type="button"
                              >
                                <Trash2 aria-hidden="true" />
                              </button>
                            )}
                            {active.content && (
                              <button
                                aria-label={t("media.chat.copy")}
                                className="classroom-chat__tool-button"
                                data-tooltip={t("media.chat.copy")}
                                onClick={() => void copy(active)}
                                type="button"
                              >
                                <Copy aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))
        )}
      </div>

      {showJump && (
        <button
          className="classroom-chat__jump"
          onClick={scrollToBottom}
          type="button"
        >
          <ArrowDown aria-hidden="true" />
          {t("media.chat.jumpToLatest")}
        </button>
      )}

      <p aria-live="polite" className="classroom-chat__sr" role="status">
        {announcement}
      </p>

      {canPost && (
        <form
          className="classroom-chat__composer"
          ref={composerRef}
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void submit();
          }}
        >
          {staged.length > 0 && (
            <ul
              aria-label={t("media.chat.stagedLabel")}
              className="classroom-chat__staged"
            >
              {staged.map((item) => (
                <li
                  className="classroom-chat__staged-item"
                  data-kind={item.kind}
                  data-status={item.status}
                  key={item.localID}
                >
                  {item.kind === "image" && item.previewURL ? (
                    <img
                      alt=""
                      className="classroom-chat__staged-thumb"
                      src={item.previewURL}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="classroom-chat__staged-badge"
                    >
                      {fileTypeLabel(item.name, item.mediaType)}
                    </span>
                  )}
                  <span className="classroom-chat__staged-copy">
                    <span className="classroom-chat__staged-name">
                      {item.name}
                    </span>
                    <span className="classroom-chat__staged-meta">
                      {item.status === "error"
                        ? t(item.problem ?? "media.chat.uploadFailed")
                        : item.status === "uploading"
                          ? t("media.chat.uploadingShort")
                          : formatAttachmentSize(item.size, language)}
                    </span>
                    {item.status === "uploading" && (
                      <span
                        aria-label={t("media.chat.uploading", {
                          name: item.name,
                        })}
                        className="classroom-chat__progress"
                        role="progressbar"
                      />
                    )}
                  </span>
                  {item.status === "error" && (
                    <button
                      aria-label={t("media.chat.retryAttachment", {
                        name: item.name,
                      })}
                      className="classroom-chat__staged-action"
                      onClick={() => retryStaged(item.localID)}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" />
                    </button>
                  )}
                  <button
                    aria-label={t("media.chat.removeAttachment", {
                      name: item.name,
                    })}
                    className="classroom-chat__staged-action"
                    onClick={() => removeStaged(item.localID)}
                    type="button"
                  >
                    <X aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="classroom-chat__sr" htmlFor={`${id}-composer`}>
            {t("media.chat.composerLabel")}
          </label>
          <textarea
            aria-describedby={`${composerHintID}${count >= CHAT_COUNTER_THRESHOLD ? ` ${counterID}` : ""}`}
            aria-invalid={tooLong || undefined}
            className="classroom-chat__input"
            id={`${id}-composer`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            onPaste={onComposerPaste}
            placeholder={t("media.chat.placeholder")}
            ref={textareaRef}
            rows={1}
            value={draft}
          />
          <span className="classroom-chat__sr" id={composerHintID}>
            {t(
              canUpload
                ? "media.chat.composerHintUpload"
                : "media.chat.composerHint",
            )}
          </span>
          {composerError && (
            <p className="classroom-chat__error" role="alert">
              {composerError}
            </p>
          )}
          {stickerFailure && (
            <div
              className="classroom-chat__error classroom-chat__error--sticker"
              role="alert"
            >
              <span>
                {t("conversations.stickerSendFailed", {
                  label: chatStickerLabel(
                    stickerFailure.sticker.labels,
                    language,
                  ),
                })}{" "}
                {stickerFailure.message}
              </span>
              <button
                className="classroom-chat__error-action"
                onClick={() =>
                  void sendSticker(
                    stickerFailure.sticker,
                    stickerFailure.clientMessageID,
                  )
                }
                type="button"
              >
                {t("media.chat.sticker.retry")}
              </button>
            </div>
          )}
          <div className="classroom-chat__actions">
            <ChatExpressionPicker
              boundaryRef={composerRef}
              composerRef={textareaRef}
              disabled={sending}
              onOpenChange={setEmojiOpen}
              onSelectEmoji={insertEmoji}
              onSendSticker={(sticker) => void sendSticker(sticker)}
              open={emojiOpen}
              readOnly={!canPost}
              recentScope={emojiScope}
              tenantID={tenantID}
            />
            {canUpload && (
              <button
                aria-label={t("media.chat.attachImage")}
                className="classroom-chat-tool"
                data-tooltip={t("media.chat.attachImage")}
                disabled={sending || staged.length >= CHAT_MAX_ATTACHMENTS}
                onClick={() => imageInputRef.current?.click()}
                type="button"
              >
                <ImageIcon aria-hidden="true" />
              </button>
            )}
            {canUpload && (
              <button
                aria-label={t("media.chat.attachFile")}
                className="classroom-chat-tool"
                data-tooltip={t("media.chat.attachFile")}
                disabled={sending || staged.length >= CHAT_MAX_ATTACHMENTS}
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                <Paperclip aria-hidden="true" />
              </button>
            )}
            {count >= CHAT_COUNTER_THRESHOLD && (
              <span
                className="classroom-chat__counter"
                data-over={tooLong || undefined}
                id={counterID}
              >
                {t("media.chat.counter", {
                  count,
                  max: CHAT_MAX_MESSAGE_CHARACTERS,
                })}
              </span>
            )}
            <span aria-hidden="true" className="classroom-chat__divider" />
            <button
              aria-label={t("media.chat.send")}
              className="classroom-chat__send"
              data-tooltip={t("media.chat.send")}
              disabled={!canSend}
              type="submit"
            >
              <SendHorizontal aria-hidden="true" />
            </button>
          </div>
          {canUpload && (
            <>
              <input
                accept={CHAT_IMAGE_ACCEPT}
                className="classroom-chat__file-input"
                data-testid="classroom-chat-image-input"
                multiple
                onChange={onPick(imageInputRef)}
                ref={imageInputRef}
                hidden
                tabIndex={-1}
                type="file"
              />
              <input
                accept={CHAT_FILE_ACCEPT}
                className="classroom-chat__file-input"
                data-testid="classroom-chat-file-input"
                multiple
                onChange={onPick(fileInputRef)}
                ref={fileInputRef}
                hidden
                tabIndex={-1}
                type="file"
              />
            </>
          )}
        </form>
      )}

      {dragging && (
        <div aria-hidden="true" className="classroom-chat__drop">
          <Paperclip />
          <span>{t("media.chat.dropTitle")}</span>
        </div>
      )}

      <Dialog
        onOpenChange={(next) => {
          if (!next) setLightbox(null);
        }}
        open={lightbox !== null}
      >
        {lightbox && (
          <DialogContent
            className="classroom-chat-lightbox"
            closeLabel={t("media.chat.lightboxClose")}
            data-theme="dark"
          >
            <DialogTitle className="classroom-chat-lightbox__title">
              {lightbox.display_name}
            </DialogTitle>
            <DialogDescription className="classroom-chat__sr">
              {t("media.chat.lightboxDescription")}
            </DialogDescription>
            <ChatLightboxImage
              attachment={lightbox}
              language={language}
              load={objectURLFor}
              actions={
                <ChatAttachmentActions
                  attachment={lightbox}
                  onOpen={onOpenAttachment}
                  onSave={roomEnded ? undefined : onSaveAttachment}
                  onDone={() => setLightbox(null)}
                />
              }
            />
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}

/**
 * ROOM-TOOLS-CODE-01: a message bubble. Fenced ```lang blocks become
 * read-only code cards; every piece is a React text node (never HTML).
 */
function ChatBubble({
  jumbo,
  mentions,
  onCopyCode,
  onOpenInCode,
  onOpenDocument,
  text,
}: {
  jumbo: boolean;
  mentions: readonly string[];
  onCopyCode: (code: string) => void;
  onOpenInCode: ((block: ClassroomChatCodeBlock) => void) | undefined;
  onOpenDocument?: ClassroomChatPanelProps["onOpenDocument"];
  text: string;
}) {
  const pieces = useMemo(() => splitChatCodeBlocks(text), [text]);
  const hasCode = pieces.some((piece) => piece.kind !== "text");
  return (
    <div
      className="classroom-chat__bubble"
      data-has-code={hasCode || undefined}
      data-jumbo={(jumbo && !hasCode) || undefined}
    >
      {hasCode ? (
        pieces.map((piece, index) =>
          piece.kind === "document" ? (
            <ChatDocumentCard
              key={index}
              reference={piece.reference}
              onOpen={onOpenDocument}
            />
          ) : piece.kind === "literal" ? (
            <p className="classroom-chat__text-piece" key={index}>
              {piece.text}
            </p>
          ) : piece.kind === "code" ? (
            <ChatCodeCard
              code={piece.code}
              key={`code-${index}`}
              language={piece.language}
              onCopy={onCopyCode}
              onOpenInCode={onOpenInCode}
              tag={piece.tag}
            />
          ) : (
            <p className="classroom-chat__text-piece" key={`text-${index}`}>
              <ChatText mentions={mentions} text={piece.text} />
            </p>
          ),
        )
      ) : (
        <ChatText mentions={mentions} text={text} />
      )}
    </div>
  );
}

function ChatDocumentCard({
  reference,
  onOpen,
}: {
  reference: ChatDocumentReference;
  onOpen?: ClassroomChatPanelProps["onOpenDocument"];
}) {
  const { t } = useI18n();
  return (
    <figure className="classroom-chat__document">
      <FileText aria-hidden="true" />
      <figcaption>
        <strong>{reference.name}</strong>
        <span>
          {t("classroomTools.files.viewer.page", { page: reference.page })}
        </span>
      </figcaption>
      {onOpen && <DocumentActionButtons open={() => onOpen(reference)} />}
    </figure>
  );
}

function ChatAttachmentActions({
  attachment,
  onOpen,
  onSave,
  onDone,
}: {
  attachment: MessageAttachment;
  onOpen?: ClassroomChatPanelProps["onOpenAttachment"];
  onSave?: ClassroomChatPanelProps["onSaveAttachment"];
  onDone?: () => void;
}) {
  if (
    !supportsChatDocument(attachment.media_type) ||
    attachment.size_bytes <= 0 ||
    attachment.size_bytes > 10 * 1024 * 1024 ||
    !onOpen
  )
    return null;
  return (
    <DocumentActionButtons
      open={() => onOpen(attachment)}
      save={onSave && (() => onSave(attachment))}
      onDone={onDone}
    />
  );
}

function DocumentActionButtons({
  open,
  save,
  onDone,
}: {
  open: () => Promise<void>;
  save?: () => Promise<void>;
  onDone?: () => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const run = async (action: () => Promise<void>, errorKey: TranslationKey) => {
    setPending(true);
    setError(null);
    try {
      await action();
      onDone?.();
    } catch {
      setError(errorKey);
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className="classroom-chat__document-actions"
      aria-busy={pending || undefined}
    >
      <button
        className="classroom-chat__code-action"
        type="button"
        disabled={pending}
        onClick={() => void run(open, "classroomTools.files.chat.openFailed")}
      >
        {t("classroomTools.files.chat.open")}
      </button>
      {save && (
        <button
          className="classroom-chat__code-action"
          type="button"
          disabled={pending}
          onClick={() => void run(save, "classroomTools.files.chat.saveFailed")}
        >
          {t("classroomTools.files.chat.save")}
        </button>
      )}
      {error && <span role="alert">{t(error)}</span>}
    </div>
  );
}

/**
 * ROOM-TOOLS-CODE-03B: syntax colours load on demand. The chat chunk only
 * holds this `import()` and a small token cache; the tokenizer and each
 * language parser are separate chunks, fetched once a highlightable card is
 * on screen. Until then (or if loading fails) the card shows plain text in
 * the same `<pre><code>`, so the layout never shifts.
 */
const CHAT_HIGHLIGHT_MAX_CHARACTERS = 4_000;
const CHAT_HIGHLIGHT_CACHE_LIMIT = 64;
const chatHighlightCache = new Map<string, readonly ChatCodeToken[]>();
let chatHighlightModule: Promise<
  typeof import("../classroom-tools/chatCodeHighlight")
> | null = null;

function loadChatHighlight() {
  chatHighlightModule ??= import("../classroom-tools/chatCodeHighlight").catch(
    (error: unknown) => {
      chatHighlightModule = null;
      throw error;
    },
  );
  return chatHighlightModule;
}

function rememberChatHighlight(key: string, tokens: readonly ChatCodeToken[]) {
  chatHighlightCache.delete(key);
  chatHighlightCache.set(key, tokens);
  if (chatHighlightCache.size > CHAT_HIGHLIGHT_CACHE_LIMIT) {
    const oldest = chatHighlightCache.keys().next().value;
    if (oldest !== undefined) chatHighlightCache.delete(oldest);
  }
}

function useChatCodeTokens(
  code: string,
  language: CodeFileLanguage | null,
): readonly ChatCodeToken[] | null {
  const key =
    language !== null &&
    code.length > 0 &&
    code.length <= CHAT_HIGHLIGHT_MAX_CHARACTERS
      ? `${language}\u0000${code}`
      : null;
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly tokens: readonly ChatCodeToken[];
  } | null>(null);
  useEffect(() => {
    if (key === null || language === null || chatHighlightCache.has(key)) {
      return undefined;
    }
    let active = true;
    loadChatHighlight()
      .then((module) => module.highlightChatCode(code, language))
      .then(
        (tokens) => {
          if (!tokens) return;
          rememberChatHighlight(key, tokens);
          if (active) setLoaded({ key, tokens });
        },
        () => undefined, // Plain text stays: colour is an enhancement.
      );
    return () => {
      active = false;
    };
  }, [code, key, language]);
  if (key === null) return null;
  return (
    chatHighlightCache.get(key) ?? (loaded?.key === key ? loaded.tokens : null)
  );
}

function ChatCodeCard({
  code,
  language,
  onCopy,
  onOpenInCode,
  tag,
}: {
  code: string;
  language: CodeFileLanguage | null;
  onCopy: (code: string) => void;
  onOpenInCode: ((block: ClassroomChatCodeBlock) => void) | undefined;
  tag: string;
}) {
  const { t } = useI18n();
  const labelID = useId();
  const tokens = useChatCodeTokens(code, language);
  const languageLabel = language
    ? CODE_LANGUAGES[language].label
    : tag.trim() || t("media.chat.codeUnknownLanguage");
  return (
    <figure aria-labelledby={labelID} className="classroom-chat__code">
      <figcaption className="classroom-chat__code-header">
        <span className="classroom-chat__code-language">
          <SquareCode aria-hidden="true" />
          <span aria-hidden="true">{languageLabel}</span>
          <span className="classroom-chat__sr" id={labelID}>
            {t("media.chat.codeCardLabel", { language: languageLabel })}
          </span>
        </span>
        <span className="classroom-chat__code-actions">
          <button
            aria-label={t("media.chat.codeCopy")}
            className="classroom-chat__code-action"
            data-tooltip={t("media.chat.codeCopy")}
            onClick={() => onCopy(code)}
            type="button"
          >
            <Copy aria-hidden="true" />
          </button>
          {onOpenInCode && (
            <button
              className="classroom-chat__code-action classroom-chat__code-action--open"
              onClick={() => onOpenInCode({ code, language })}
              type="button"
            >
              {t("media.chat.codeOpen")}
            </button>
          )}
        </span>
      </figcaption>
      <pre
        aria-labelledby={labelID}
        className="classroom-chat__code-body"
        tabIndex={0}
      >
        <code data-highlighted={tokens ? "true" : undefined}>
          {tokens
            ? tokens.map((piece, index) =>
                piece.token ? (
                  <span
                    className="classroom-chat__token"
                    data-token={piece.token}
                    key={index}
                  >
                    {piece.text}
                  </span>
                ) : (
                  <Fragment key={index}>{piece.text}</Fragment>
                ),
              )
            : code}
        </code>
      </pre>
    </figure>
  );
}

function ChatText({
  mentions,
  text,
}: {
  mentions: readonly string[];
  text: string;
}) {
  const pieces = useMemo(
    () => linkifyChatText(text, mentions),
    [mentions, text],
  );
  return (
    <>
      {pieces.map((piece, index) =>
        piece.kind === "mention" ? (
          <span className="classroom-chat__mention" key={`${index}-mention`}>
            {piece.text}
          </span>
        ) : piece.kind === "link" ? (
          <a
            className="classroom-chat__link"
            href={piece.href}
            key={`${index}-${piece.href}`}
            rel="noopener noreferrer"
            target="_blank"
          >
            {piece.text}
          </a>
        ) : (
          <span key={`${index}-text`}>{piece.text}</span>
        ),
      )}
    </>
  );
}

function useAttachmentURL(
  attachment: MessageAttachment,
  load: (attachment: MessageAttachment) => Promise<string>,
) {
  const [state, setState] = useState<{
    id: string;
    status: "loading" | "ready" | "error";
    url?: string;
  }>({ id: attachment.id, status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    load(attachment)
      .then((url) => {
        if (active) setState({ id: attachment.id, status: "ready", url });
      })
      .catch(() => {
        if (active) setState({ id: attachment.id, status: "error" });
      });
    return () => {
      active = false;
    };
  }, [attachment, attempt, load]);
  const current =
    state.id === attachment.id
      ? state
      : { id: attachment.id, status: "loading" as const };
  return {
    ...current,
    retry: () => {
      setState({ id: attachment.id, status: "loading" });
      setAttempt((value) => value + 1);
    },
  };
}

function ChatImage({
  attachment,
  load,
  onOpen,
}: {
  attachment: MessageAttachment;
  load: (attachment: MessageAttachment) => Promise<string>;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const image = useAttachmentURL(attachment, load);
  const ratio =
    attachment.width_px && attachment.height_px
      ? `${attachment.width_px} / ${attachment.height_px}`
      : "4 / 3";
  if (image.status === "error") {
    return (
      <button
        className="classroom-chat__image classroom-chat__image--error"
        onClick={image.retry}
        style={{ aspectRatio: ratio }}
        type="button"
      >
        <ImageIcon aria-hidden="true" />
        <span>{t("media.chat.imageError")}</span>
      </button>
    );
  }
  return (
    <button
      aria-label={t("media.chat.viewImage", { name: attachment.display_name })}
      aria-busy={image.status === "loading" || undefined}
      className="classroom-chat__image"
      data-loading={image.status === "loading" || undefined}
      disabled={image.status !== "ready"}
      onClick={onOpen}
      style={{ aspectRatio: ratio }}
      type="button"
    >
      {image.status === "ready" && image.url ? (
        <img alt="" src={image.url} />
      ) : (
        <span className="classroom-chat__image-skeleton">
          <span className="classroom-chat__sr">
            {t("media.chat.imageLoading")}
          </span>
        </span>
      )}
    </button>
  );
}

function ChatFileCard({
  actions,
  attachment,
  language,
  onDownload,
}: {
  actions?: React.ReactNode;
  attachment: MessageAttachment;
  language: "vi" | "en";
  onDownload: () => void;
}) {
  const { t } = useI18n();
  const label = fileTypeLabel(attachment.display_name, attachment.media_type);
  return (
    <div className="classroom-chat__file" data-type={label}>
      <span aria-hidden="true" className="classroom-chat__file-badge">
        <FileText />
        <span>{label}</span>
      </span>
      <span className="classroom-chat__file-copy">
        <span className="classroom-chat__file-name">
          {attachment.display_name}
        </span>
        <span className="classroom-chat__file-meta">
          {`${label} · ${formatAttachmentSize(attachment.size_bytes, language)}`}
        </span>
      </span>
      <button
        aria-label={t("media.chat.download", { name: attachment.display_name })}
        className="classroom-chat__file-download"
        data-tooltip={t("media.chat.downloadShort")}
        onClick={onDownload}
        type="button"
      >
        <Download aria-hidden="true" />
      </button>
      {actions}
    </div>
  );
}

function ChatLightboxImage({
  actions,
  attachment,
  language,
  load,
}: {
  actions?: React.ReactNode;
  attachment: MessageAttachment;
  language: "vi" | "en";
  load: (attachment: MessageAttachment) => Promise<string>;
}) {
  const { t } = useI18n();
  const image = useAttachmentURL(attachment, load);
  return (
    <div className="classroom-chat-lightbox__body">
      <div className="classroom-chat-lightbox__frame">
        {image.status === "ready" && image.url ? (
          <img alt={attachment.display_name} src={image.url} />
        ) : image.status === "error" ? (
          <p role="alert">{t("media.chat.imageError")}</p>
        ) : (
          <span className="classroom-chat__image-skeleton" role="status">
            <span className="classroom-chat__sr">
              {t("media.chat.imageLoading")}
            </span>
          </span>
        )}
      </div>
      <div className="classroom-chat-lightbox__footer">
        <span className="classroom-chat-lightbox__meta">
          {formatAttachmentSize(attachment.size_bytes, language)}
          {attachment.width_px && attachment.height_px
            ? ` · ${attachment.width_px}×${attachment.height_px}`
            : ""}
        </span>
        {image.status === "ready" && image.url && (
          <a
            className="classroom-chat-lightbox__download"
            download={attachment.display_name}
            href={image.url}
          >
            <Download aria-hidden="true" />
            {t("media.chat.downloadOriginal")}
          </a>
        )}
        {actions}
      </div>
    </div>
  );
}
