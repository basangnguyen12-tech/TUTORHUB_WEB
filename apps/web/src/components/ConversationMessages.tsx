import {
  APIRequestError,
  type ActiveMessage,
  type Conversation,
  type Message,
  type MessageAttachment,
  type Sticker,
} from "@tutorhub/api-client";
import {
  Button,
  EmptyState,
  ErrorState,
  ForbiddenState,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
  SkeletonGroup,
  StatusBadge,
} from "@tutorhub/ui";
import {
  AtSign,
  CalendarClock,
  Check,
  ChevronRight,
  ChevronUp,
  Contact,
  Copy,
  Lock,
  MessageCircle,
  Pencil,
  PenLine,
  Presentation,
  RefreshCw,
  Reply,
  RotateCcw,
  Search,
  SendHorizontal,
  Trash2,
  UserPlus,
  Users,
  Video,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import {
  coverThemeFor,
  defaultCoverTheme,
  type ClassCoverTheme,
  useClassroomPreferences,
} from "../app/classroomPreferences";
import { foldSearchText } from "../app/conversationPreferences";
import {
  fetchConversationAttachmentBlob,
  useConversationMessages,
  useDeleteConversationMessage,
  useEditConversationMessage,
  useMarkConversationRead,
  useSendConversationMessage,
  useUploadConversationAttachment,
} from "../app/conversations";
import { useI18n } from "../app/i18n";
import { useTenantCapabilities } from "../app/tenantCapabilities";
import { shouldConcealTenantScopedData } from "../app/tenantDataAccess";
import {
  ChatRichComposer,
  type ChatRichEditorHandle,
} from "../features/chat-format/ChatRichComposer";
import { ChatFormattedText } from "../features/chat-format/ChatFormattedText";
import {
  chatMarkupHasFormatting,
  chatMarkupToPlainText,
} from "../features/chat-format/chatMarkup";
import { ChatExpressionPicker } from "../features/media/ChatExpressionPicker";
import {
  CHAT_FILE_ACCEPT,
  CHAT_MAX_ATTACHMENTS,
  chatMentionNames,
  chatStickerLabel,
  checkChatFile,
  createClientID,
  formatAttachmentSize,
  prepareChatImage,
  splitChatMentions,
  type ChatAttachmentKind,
} from "../features/media/classroomChatMedia";
import { ClassCoverArt } from "./ClassCoverArt";
import {
  buildQuotedReply,
  parseQuotedMessage,
  quoteExcerpt,
  rebuildQuotedContent,
  type ParsedQuotedMessage,
  type ReplyTarget,
} from "./ConversationQuote";
import {
  ComposerCaptureMenu,
  ComposerFileMenu,
} from "./conversation-composer/ComposerToolMenus";
import { isScreenCaptureSupported } from "./conversation-composer/screenCapture";
import { ScreenshotEditor } from "./conversation-composer/ScreenshotEditor";
import {
  useCaptureShortcut,
  useScreenshotFlow,
} from "./conversation-composer/useScreenshotFlow";
import {
  ContactCardDialog,
  InstantClassDialog,
} from "./conversation-composer/ComposerCardDialogs";
import {
  cardPreviewText,
  createInstantClassSpace,
  embedSearchText,
  type MessageEmbedInput,
} from "./conversation-composer/composerCards";
import { MessageEmbedCard } from "./conversation-composer/MessageEmbedCard";
import { FileTypeIcon } from "./FileTypeIcon";
import { UserAvatar, type UserAvatarSize } from "./UserAvatar";

const maximumMessageCharacters = 4000;
const maximumMessageBytes = 16 * 1024;
const composerMaxHeight = 160;
/** Consecutive messages of one author within this window share one header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

type Translate = ReturnType<typeof useI18n>["t"];

interface PendingMessage {
  attachmentKey: string;
  clientMessageID: string;
  content: string;
}

interface StagedAttachment {
  attachment?: MessageAttachment;
  clientAttachmentID: string;
  file: File;
  kind: ChatAttachmentKind;
  localID: string;
  mediaType: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
}

interface MessageRow {
  /** The next message continues this one's group. */
  continued: boolean;
  dayLabel: string | null;
  grouped: boolean;
  message: Message;
  parsed: ParsedQuotedMessage | null;
}

function cx(...values: (string | false | null | undefined)[]) {
  return values.filter(Boolean).join(" ");
}

/**
 * MSG-AVATAR-SEARCH-CLASSIN-01: a person is the shared Zalo-style default
 * avatar (no initials, no tone). It is decorative: the name always sits next
 * to it. `src` takes a profile photo once the API exposes one.
 */
export function PersonAvatar({
  className,
  size = "sm",
  src,
}: {
  className?: string;
  size?: UserAvatarSize;
  src?: string | null;
}) {
  return (
    <UserAvatar
      className={cx("conversation-person-avatar", className)}
      size={size}
      src={src}
    />
  );
}

/**
 * Conversation identity. Classes and rooms (including a standalone instant
 * class) are a ClassIn rounded-square cover with a green badge; a direct chat
 * is the other person's avatar. A conversation tied to a class uses that
 * class's cover, so the class and its rooms match; a standalone room gets a
 * stable cover from its media space (or its own) ID.
 */
export function ConversationAvatar({
  conversation,
  coverTheme,
  size = "md",
}: {
  conversation: Pick<
    Conversation,
    "class_id" | "id" | "kind" | "media_space_id"
  >;
  /** The class's chosen cover; only meaningful with a `class_id`. */
  coverTheme?: ClassCoverTheme;
  size?: "sm" | "md" | "lg";
}) {
  if (conversation.kind === "class" || conversation.kind === "room") {
    const theme =
      (conversation.class_id ? coverTheme : undefined) ??
      defaultCoverTheme(
        conversation.class_id ?? conversation.media_space_id ?? conversation.id,
      );
    return (
      <span
        aria-hidden="true"
        className={cx(
          "conversation-avatar",
          "conversation-avatar--cover",
          `conversation-avatar--${conversation.kind}`,
          `conversation-avatar--${size}`,
        )}
      >
        <ClassCoverArt theme={theme} />
        <span className="conversation-avatar__badge">
          {conversation.kind === "class" ? <Users /> : <Video />}
        </span>
      </span>
    );
  }
  return (
    <PersonAvatar
      className={cx("conversation-avatar", `conversation-avatar--${size}`)}
      size={size}
    />
  );
}

export function ConversationMessages({
  actorID,
  canPostMessages,
  conversation,
  conversationID,
  formatter,
  readOnlyNotice,
  tenantID,
  toolbarTarget,
}: {
  actorID: string;
  canPostMessages: boolean;
  /** The loaded conversation projection (kind, links, permissions). */
  conversation?: Conversation;
  conversationID: string;
  formatter: Intl.DateTimeFormat;
  /** Shown in place of the composer while the conversation is read-only. */
  readOnlyNotice?: string;
  tenantID: string;
  /** Header slot for the thread tools; rendered inline when absent. */
  toolbarTarget?: HTMLElement | null;
}) {
  const { language, t } = useI18n();
  const messages = useConversationMessages(tenantID, conversationID);
  const markRead = useMarkConversationRead(tenantID, conversationID);
  const sendMessage = useSendConversationMessage(tenantID, conversationID);
  // MSG-STICKER-03: stickers use their own mutation so the typed draft and
  // its send/error state are never touched by a sticker.
  const stickerSend = useSendConversationMessage(tenantID, conversationID);
  const editMessage = useEditConversationMessage(tenantID, conversationID);
  const deleteMessage = useDeleteConversationMessage(tenantID, conversationID);
  const uploadAttachment = useUploadConversationAttachment(
    tenantID,
    conversationID,
  );
  const classroomPreferences = useClassroomPreferences(
    tenantID || undefined,
    actorID || undefined,
  );
  const [draft, setDraft] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [sentFeedback, setSentFeedback] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [confirmDeleteID, setConfirmDeleteID] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    messageID: string;
    text: string;
  } | null>(null);
  const [actionFeedback, setActionFeedback] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const pendingMessage = useRef<PendingMessage | null>(null);
  const lastReadAttempt = useRef<string | null>(null);
  const focusComposerAfterSuccess = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerCard = useRef<HTMLFormElement>(null);
  // MSG-RICH-COMPOSE-01: "Format text" swaps the textarea for the rich
  // editor. The editor stays while its draft carries formatting, even with
  // the toolbar hidden (Zoom), and the draft is always chat markup.
  const [formatOpen, setFormatOpen] = useState(false);
  const [richMode, setRichMode] = useState(false);
  const richEditor = useRef<ChatRichEditorHandle>(null);
  const richField = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const oldestMessage = useRef<HTMLLIElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const stickToBottom = useRef(true);
  const selection = useRef<{ end: number; start: number } | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const mentionInserted = useRef(false);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [captureSupported] = useState(() => isScreenCaptureSupported());

  const canModerate = conversation?.viewer_access.can_moderate_chat === true;
  const canUpload =
    canPostMessages &&
    conversation?.viewer_access.can_upload_attachments === true;
  const classID =
    conversation?.kind === "class" ? conversation.class_id : undefined;
  const recentScope = useMemo(
    () => (tenantID && actorID ? { actorID, tenantID } : null),
    [actorID, tenantID],
  );

  const focusComposer = useCallback(() => {
    if (richMode) {
      richEditor.current?.focus();
    } else {
      composer.current?.focus();
    }
  }, [richMode]);

  useEffect(() => {
    if (!sendMessage.isPending && focusComposerAfterSuccess.current) {
      focusComposerAfterSuccess.current = false;
      focusComposer();
    }
  }, [focusComposer, sendMessage.isPending]);

  const items = useMemo(() => {
    const byID = new Map<string, Message>();
    for (const page of messages.data?.pages ?? []) {
      for (const item of page.items) {
        byID.set(item.id, item);
      }
    }
    return [...byID.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }, [messages.data?.pages]);

  const newestPage = messages.data?.pages[0];
  const newestMessage = newestPage?.items.reduce<Message | undefined>(
    (newest, item) =>
      !newest || item.sequence > newest.sequence ? item : newest,
    undefined,
  );
  const unreadCount = newestPage?.unread_count ?? 0;
  const unreadCountCapped = newestPage?.unread_count_capped ?? false;

  const markNewestRead = useCallback(() => {
    if (
      document.visibilityState !== "visible" ||
      !messages.isSuccess ||
      unreadCount === 0 ||
      !newestMessage ||
      markRead.isPending ||
      lastReadAttempt.current === newestMessage.id
    ) {
      return;
    }
    lastReadAttempt.current = newestMessage.id;
    markRead.mutate(newestMessage.id);
  }, [markRead, messages.isSuccess, newestMessage, unreadCount]);

  useEffect(() => {
    markNewestRead();
    const handleVisibilityChange = () => markNewestRead();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [markNewestRead]);

  const timeZone = formatter.resolvedOptions().timeZone;
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        timeZone,
      }),
    [locale, timeZone],
  );
  const rows = useMemo(
    () => buildMessageRows(items, { language, locale, t, timeZone }),
    [items, language, locale, t, timeZone],
  );

  const foldedSearch = foldSearchText(searchQuery);
  const searching = searchOpen && foldedSearch.length > 0;
  const matchingIDs = useMemo(() => {
    if (!searching) {
      return null;
    }
    const matches = new Set<string>();
    for (const row of rows) {
      if (row.message.state !== "active") {
        continue;
      }
      const haystack = foldSearchText(
        [
          row.message.author.display_name,
          chatMarkupToPlainText(row.message.content),
          ...(row.message.attachments ?? []).map(
            (attachment) => attachment.display_name,
          ),
          embedSearchText(row.message.embed),
        ].join(" "),
      );
      if (haystack.includes(foldedSearch)) {
        matches.add(row.message.id);
      }
    }
    return matches;
  }, [foldedSearch, rows, searching]);

  const newestID = items[items.length - 1]?.id;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!newestID || !element || !stickToBottom.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [newestID]);

  useLayoutEffect(() => {
    const element = composer.current;
    if (!element) {
      return;
    }
    element.style.height = "auto";
    if (element.scrollHeight > 0) {
      element.style.height = `${Math.min(element.scrollHeight, composerMaxHeight)}px`;
    } else {
      element.style.removeProperty("height");
    }
  }, [draft]);

  // MSG-MENTION-BLUE-01: every member name that can appear after "@".
  const mentionNames = useMemo(
    () =>
      chatMentionNames([
        ...(conversation?.participants ?? []).map(
          (participant) => participant.display_name,
        ),
        ...items.map((item) => item.author.display_name),
      ]),
    [conversation?.participants, items],
  );
  const composerPieces = useMemo(
    () => splitChatMentions(draft, mentionNames),
    [draft, mentionNames],
  );
  const draftHasMention = composerPieces.some(
    (piece) => piece.kind === "mention",
  );
  const mentionMirror = useRef<HTMLDivElement>(null);
  const syncMentionMirror = () => {
    if (mentionMirror.current && composer.current) {
      mentionMirror.current.scrollTop = composer.current.scrollTop;
    }
  };
  useLayoutEffect(() => {
    if (mentionMirror.current && composer.current) {
      mentionMirror.current.scrollTop = composer.current.scrollTop;
    }
  }, [draft, draftHasMention]);

  const mentionCandidates = useMemo(() => {
    const byID = new Map<string, string>();
    for (const participant of conversation?.participants ?? []) {
      if (participant.user_id !== actorID) {
        byID.set(participant.user_id, participant.display_name);
      }
    }
    for (const message of items) {
      if (message.author.user_id !== actorID) {
        byID.set(message.author.user_id, message.author.display_name);
      }
    }
    return [...byID.entries()]
      .map(([userID, name]) => ({ name, userID }))
      .sort((left, right) => left.name.localeCompare(right.name, locale));
  }, [actorID, conversation?.participants, items, locale]);

  const rememberSelection = () => {
    const element = composer.current;
    if (element) {
      selection.current = {
        end: element.selectionEnd,
        start: element.selectionStart,
      };
    }
  };

  const insertIntoDraft = (text: string, focus: boolean) => {
    if (richMode) {
      richEditor.current?.insertText(text, { focus });
      return;
    }
    const element = composer.current;
    const start = Math.min(
      selection.current?.start ?? draft.length,
      draft.length,
    );
    const end = Math.min(
      Math.max(selection.current?.end ?? start, start),
      draft.length,
    );
    const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
    const caret = start + text.length;
    selection.current = { end: caret, start: caret };
    setDraft(next);
    setValidationError(null);
    setSentFeedback(false);
    if (sendMessage.isError) {
      sendMessage.reset();
    }
    window.requestAnimationFrame(() => {
      if (!element) {
        return;
      }
      if (focus) {
        element.focus();
      }
      element.setSelectionRange(caret, caret);
    });
  };

  const updateStaged = (
    change: (current: StagedAttachment[]) => StagedAttachment[],
  ) => setStaged(change);

  const uploadStaged = async (item: StagedAttachment) => {
    try {
      let input: Parameters<typeof uploadAttachment.mutateAsync>[0] = {
        clientAttachmentID: item.clientAttachmentID,
        file: item.file,
        fileName: item.name,
      };
      if (item.kind === "image") {
        const prepared = await prepareChatImage(item.file, item.mediaType);
        input = {
          clientAttachmentID: item.clientAttachmentID,
          file: prepared.blob,
          fileName: prepared.fileName,
          heightPx: prepared.height,
          widthPx: prepared.width,
        };
      }
      const attachment = await uploadAttachment.mutateAsync(input);
      updateStaged((current) =>
        current.map((entry) =>
          entry.localID === item.localID
            ? { ...entry, attachment, status: "ready" }
            : entry,
        ),
      );
    } catch {
      updateStaged((current) =>
        current.map((entry) =>
          entry.localID === item.localID
            ? { ...entry, status: "error" }
            : entry,
        ),
      );
    }
  };

  const addFiles = (files: readonly File[]) => {
    if (!canUpload || files.length === 0) {
      return;
    }
    const capacity = CHAT_MAX_ATTACHMENTS - staged.length;
    const accepted: StagedAttachment[] = [];
    let problem: string | null = null;
    for (const file of files) {
      const check = checkChatFile(file);
      const name = file.name || "file";
      if (!check.ok) {
        problem = t(
          check.problem === "size"
            ? "conversations.attachSizeRejected"
            : "conversations.attachTypeRejected",
          { name },
        );
        continue;
      }
      if (accepted.length >= capacity) {
        problem = t("conversations.attachTooMany", {
          count: CHAT_MAX_ATTACHMENTS,
        });
        break;
      }
      accepted.push({
        clientAttachmentID: createClientID(),
        file,
        kind: check.kind,
        localID: createClientID(),
        mediaType: check.mediaType,
        name,
        size: file.size,
        status: "uploading",
      });
    }
    setValidationError(problem);
    if (accepted.length === 0) {
      return;
    }
    updateStaged((current) => [...current, ...accepted]);
    for (const item of accepted) {
      void uploadStaged(item);
    }
  };

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles([...(event.target.files ?? [])]);
    event.target.value = "";
  };

  // MSG-COMPOSER-TOOLS-01: Ctrl+V and drag-and-drop reuse the staged path.
  const onComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0 || !canUpload) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    addFiles(files);
  };
  const hasDraggedFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files");
  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!canUpload || !hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!canUpload || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = () => {
    if (!dragging) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!canUpload || !hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const attachmentsFull = staged.length >= CHAT_MAX_ATTACHMENTS;
  const fullReason = attachmentsFull
    ? t("conversations.attachTooMany", { count: CHAT_MAX_ATTACHMENTS })
    : null;
  // Mirrors when the composer itself is rendered (see `initialError`).
  const composerHidden =
    messages.isPending ||
    (messages.isError &&
      (items.length === 0 || shouldConcealTenantScopedData(messages.error)));
  const canCapture =
    canUpload && captureSupported && !composerHidden && !sendMessage.isPending;
  const screenshot = useScreenshotFlow({
    onCancelled: () =>
      setActionFeedback(t("conversations.screenshotCancelled")),
    onFile: (file) => addFiles([file]),
  });
  useCaptureShortcut(canCapture && !attachmentsFull, () =>
    screenshot.start("screen"),
  );

  // MSG-COMPOSER-TOOLS-01: server-authored cards (contact, instant class).
  const capabilities = useTenantCapabilities(tenantID || undefined);
  const [cardDialog, setCardDialog] = useState<"contact" | "class" | null>(
    null,
  );
  const [cardNotice, setCardNotice] = useState<string | null>(null);
  // Stable keys per attempt so a retry replays instead of duplicating.
  const cardAttempt = useRef<{
    clientMessageID: string;
    idempotencyKey: string;
    payload: string;
  } | null>(null);
  const canShareInstantClass =
    canPostMessages &&
    (conversation?.kind === "direct" || conversation?.kind === "class") &&
    capabilities.data?.features.instant_study_rooms?.enabled === true &&
    capabilities.data?.features.classroom_media_rooms?.enabled === true;
  const attemptKeys = (payload: string) => {
    if (cardAttempt.current?.payload !== payload) {
      cardAttempt.current = {
        clientMessageID: crypto.randomUUID(),
        idempotencyKey: `instant-class-${crypto.randomUUID()}`,
        payload,
      };
    }
    return cardAttempt.current;
  };
  const [stickerFailure, setStickerFailure] = useState<{
    clientMessageID: string;
    sticker: Sticker;
  } | null>(null);
  const sendSticker = (
    sticker: Sticker,
    clientMessageID: string = crypto.randomUUID(),
  ) => {
    const label = chatStickerLabel(sticker.labels, language);
    setStickerFailure(null);
    stickToBottom.current = true;
    stickerSend.mutate(
      {
        client_message_id: clientMessageID,
        content: "",
        embed: { kind: "sticker", sticker_id: sticker.id },
      },
      {
        onError: () => setStickerFailure({ clientMessageID, sticker }),
        onSuccess: () =>
          setActionFeedback(t("conversations.stickerSent", { label })),
      },
    );
  };
  const sendCard = async (
    embed: MessageEmbedInput,
    keys: { clientMessageID: string },
  ) => {
    stickToBottom.current = true;
    await sendMessage.mutateAsync({
      client_message_id: keys.clientMessageID,
      content: "",
      embed,
    });
    cardAttempt.current = null;
  };
  const openCardDialog = (kind: "contact" | "class") => {
    cardAttempt.current = null;
    setCardNotice(null);
    setCardDialog(kind);
  };
  const sendContactCard = async (userID: string) => {
    const keys = attemptKeys(`contact:${userID}`);
    await sendCard({ kind: "contact_card", user_id: userID }, keys);
    setCardDialog(null);
  };
  const createInstantClass = async (input: {
    durationMinutes: number;
    title: string;
  }) => {
    const keys = attemptKeys(`class:${input.durationMinutes}:${input.title}`);
    const space = await createInstantClassSpace(tenantID, {
      durationMinutes: input.durationMinutes,
      idempotencyKey: keys.idempotencyKey,
      title: input.title,
    });
    await sendCard({ kind: "instant_class", media_space_id: space.id }, keys);
    setCardDialog(null);
    setCardNotice(t("conversations.instantClassCreated"));
  };

  const readyAttachmentIDs = staged.flatMap((item) =>
    item.status === "ready" && item.attachment ? [item.attachment.id] : [],
  );
  const uploading = staged.some((item) => item.status === "uploading");

  const submitMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sendMessage.isPending) {
      return;
    }
    const body = normalizeDraft(draft);
    if (uploading) {
      setValidationError(t("conversations.attachWaiting"));
      return;
    }
    if (!body && readyAttachmentIDs.length === 0) {
      setValidationError(t("conversations.messageRequired"));
      return;
    }
    const content =
      replyTarget && body ? buildQuotedReply(replyTarget, body) : body;
    if (
      [...content].length > maximumMessageCharacters ||
      new TextEncoder().encode(content).length > maximumMessageBytes
    ) {
      setValidationError(t("conversations.messageTooLong"));
      return;
    }

    setValidationError(null);
    setSentFeedback(false);
    const attachmentKey = readyAttachmentIDs.join(",");
    const existing = pendingMessage.current;
    const request =
      existing?.content === content && existing.attachmentKey === attachmentKey
        ? existing
        : { attachmentKey, clientMessageID: crypto.randomUUID(), content };
    pendingMessage.current = request;
    stickToBottom.current = true;
    sendMessage.mutate(
      {
        client_message_id: request.clientMessageID,
        content: request.content,
        ...(readyAttachmentIDs.length > 0
          ? { attachment_ids: readyAttachmentIDs }
          : {}),
      },
      {
        onSuccess: () => {
          pendingMessage.current = null;
          setDraft("");
          richEditor.current?.clear();
          if (!formatOpen) setRichMode(false);
          selection.current = null;
          setReplyTarget(null);
          setStaged([]);
          setEmojiOpen(false);
          setSentFeedback(true);
          focusComposerAfterSuccess.current = true;
        },
      },
    );
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
      return;
    }
    if (event.key === "Escape" && replyTarget) {
      event.preventDefault();
      setReplyTarget(null);
    }
  };

  const updateDraft = (value: string) => {
    setDraft(value);
    setValidationError(null);
    setSentFeedback(false);
    if (sendMessage.isError) {
      sendMessage.reset();
    }
  };

  const toggleFormatting = () => {
    if (!richMode) {
      setRichMode(true);
      setFormatOpen(true);
      window.requestAnimationFrame(() =>
        richEditor.current?.focus({ atEnd: true }),
      );
      return;
    }
    if (!formatOpen) {
      setFormatOpen(true);
      window.requestAnimationFrame(() => richEditor.current?.focus());
      return;
    }
    setFormatOpen(false);
    if (chatMarkupHasFormatting(draft)) {
      window.requestAnimationFrame(() => richEditor.current?.focus());
      return;
    }
    // Nothing formatted: back to the plain textarea, caret at the end.
    setRichMode(false);
    selection.current = { end: draft.length, start: draft.length };
    window.requestAnimationFrame(() => {
      const element = composer.current;
      element?.focus();
      element?.setSelectionRange(draft.length, draft.length);
    });
  };

  const loadOlderMessages = async () => {
    const result = await messages.fetchNextPage();
    if (!result.isError && !result.hasNextPage) {
      window.requestAnimationFrame(() => oldestMessage.current?.focus());
    }
  };

  const focusLater = (element: HTMLElement | null) => {
    window.requestAnimationFrame(() => element?.focus());
  };

  const startReply = (message: ActiveMessage) => {
    const excerpt =
      quoteExcerpt(chatMarkupToPlainText(message.content)) ||
      message.attachments?.map((item) => item.display_name).join(", ") ||
      cardPreviewText(message.embed, t, language) ||
      t("conversations.attachmentPreview");
    setReplyTarget({
      authorName: message.author.display_name,
      excerpt,
      messageID: message.id,
    });
    setEditingID(null);
    focusLater(richMode ? richField.current : composer.current);
  };

  const copyMessage = async (text: string) => {
    setActionError(null);
    setActionFeedback("");
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(text);
      setActionFeedback(t("conversations.copied"));
    } catch {
      setActionError(t("conversations.copyError"));
    }
  };

  const startEdit = (message: ActiveMessage, trigger: HTMLElement) => {
    restoreFocus.current = trigger;
    setRowError(null);
    setConfirmDeleteID(null);
    editMessage.reset();
    setEditingID(message.id);
  };

  const finishEdit = () => {
    setEditingID(null);
    focusLater(restoreFocus.current);
  };

  const saveEdit = (
    message: ActiveMessage,
    parsed: ParsedQuotedMessage,
    value: string,
  ) => {
    const body = normalizeDraft(value);
    if (!body) {
      setRowError({
        messageID: message.id,
        text: t("conversations.messageRequired"),
      });
      return;
    }
    const content = rebuildQuotedContent(parsed.quote, body);
    if (
      [...content].length > maximumMessageCharacters ||
      new TextEncoder().encode(content).length > maximumMessageBytes
    ) {
      setRowError({
        messageID: message.id,
        text: t("conversations.messageTooLong"),
      });
      return;
    }
    if (content === message.content) {
      finishEdit();
      return;
    }
    setRowError(null);
    editMessage.mutate(
      { content, expectedVersion: message.version, messageID: message.id },
      {
        onError: (error) =>
          setRowError({
            messageID: message.id,
            text: rowMutationError(error, "conversations.editError", t),
          }),
        onSuccess: finishEdit,
      },
    );
  };

  const askDelete = (message: ActiveMessage, trigger: HTMLElement) => {
    restoreFocus.current = trigger;
    setRowError(null);
    setEditingID(null);
    deleteMessage.reset();
    setConfirmDeleteID(message.id);
  };

  const cancelDelete = () => {
    setConfirmDeleteID(null);
    focusLater(restoreFocus.current);
  };

  const confirmDelete = (message: ActiveMessage) => {
    deleteMessage.mutate(
      { expectedVersion: message.version, messageID: message.id },
      {
        onError: (error) =>
          setRowError({
            messageID: message.id,
            text: rowMutationError(error, "conversations.recallError", t),
          }),
        onSuccess: () => {
          setConfirmDeleteID(null);
          if (replyTarget?.messageID === message.id) {
            setReplyTarget(null);
          }
          focusLater(
            (richMode ? richField.current : composer.current) ??
              scroller.current,
          );
        },
      },
    );
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    focusLater(searchToggle.current);
  };

  const concealed = shouldConcealTenantScopedData(messages.error);
  const forbidden =
    messages.error instanceof APIRequestError && messages.error.status === 403;
  const initialError = messages.isError && (items.length === 0 || concealed);
  const refreshError =
    messages.isRefetchError &&
    !messages.isFetchNextPageError &&
    items.length > 0 &&
    !concealed;
  const hasContent =
    normalizeDraft(draft).length > 0 || readyAttachmentIDs.length > 0;
  const searchID = `conversation-thread-search-${conversationID}`;

  const tools = (
    <div className="conversation-thread-tools">
      <IconButton
        aria-controls={searchOpen ? searchID : undefined}
        aria-expanded={searchOpen}
        className="conversation-thread-tools__button"
        disabled={initialError}
        label={t("conversations.messagesSearchOpen")}
        onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        ref={searchToggle}
        size="sm"
        variant="quiet"
      >
        <Search />
      </IconButton>
      <IconButton
        className="conversation-thread-tools__button"
        label={t("conversations.messagesRefresh")}
        loading={messages.isRefetching && !messages.isFetchingNextPage}
        onClick={() => void messages.refetch()}
        size="sm"
        variant="quiet"
      >
        <RefreshCw />
      </IconButton>
    </div>
  );

  return (
    <section
      aria-labelledby={`conversation-messages-title-${conversationID}`}
      className="conversation-messages"
      data-dragging={dragging || undefined}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <h3
        className="visually-hidden"
        id={`conversation-messages-title-${conversationID}`}
      >
        {t("conversations.messagesTitle")}
      </h3>
      {toolbarTarget ? (
        createPortal(tools, toolbarTarget)
      ) : (
        <div className="conversation-messages__toolbar">{tools}</div>
      )}

      {searchOpen && !initialError && (
        <div
          aria-label={t("conversations.messagesSearchLabel")}
          className="conversation-thread-search"
          id={searchID}
          role="search"
        >
          <Search
            aria-hidden="true"
            className="conversation-thread-search__icon"
          />
          <label className="visually-hidden" htmlFor={`${searchID}-input`}>
            {t("conversations.messagesSearchLabel")}
          </label>
          <input
            autoComplete="off"
            autoFocus
            id={`${searchID}-input`}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              }
            }}
            placeholder={t("conversations.messagesSearchLabel")}
            type="search"
            value={searchQuery}
          />
          <span className="conversation-thread-search__count" role="status">
            {searching && matchingIDs
              ? matchingIDs.size > 0
                ? t("conversations.messagesSearchCount", {
                    count: matchingIDs.size,
                  })
                : t("conversations.messagesSearchEmpty")
              : ""}
          </span>
          <button
            aria-label={t("conversations.messagesSearchClose")}
            className="conversation-thread-search__close"
            onClick={closeSearch}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <div
        className="conversation-messages__scroller scroll-autohide"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            96;
        }}
        ref={scroller}
      >
        {!initialError && unreadCount > 0 && (
          <div className="conversation-messages__unread">
            <StatusBadge tone="warning">
              {t("conversations.unreadBadge", {
                count: unreadCountCapped ? "100+" : unreadCount,
              })}
            </StatusBadge>
          </div>
        )}

        {messages.isPending && (
          <SkeletonGroup label={t("conversations.messagesLoading")}>
            <Skeleton height={56} width="60%" />
            <Skeleton height={56} width="45%" />
            <Skeleton height={56} width="70%" />
          </SkeletonGroup>
        )}

        {initialError &&
          (() => {
            const State = forbidden
              ? ForbiddenState
              : concealed
                ? EmptyState
                : ErrorState;
            return (
              <State
                actions={
                  concealed && !forbidden ? undefined : (
                    <Button
                      leadingIcon={<RefreshCw />}
                      onClick={() => void messages.refetch()}
                      variant="secondary"
                    >
                      {t("state.retry")}
                    </Button>
                  )
                }
                description={
                  forbidden
                    ? t("conversations.messagesForbiddenDescription")
                    : concealed
                      ? t("conversations.messagesUnavailableDescription")
                      : t("conversations.messagesErrorDescription")
                }
                title={
                  forbidden
                    ? t("conversations.messagesForbiddenTitle")
                    : concealed
                      ? t("conversations.messagesUnavailableTitle")
                      : t("conversations.messagesErrorTitle")
                }
              />
            );
          })()}

        {refreshError && (
          <div className="conversations-page__inline-error" role="alert">
            <span>{t("conversations.messagesRefreshError")}</span>
            <Button
              onClick={() => void messages.refetch()}
              size="sm"
              variant="secondary"
            >
              {t("state.retry")}
            </Button>
          </div>
        )}

        {!initialError && messages.hasNextPage && (
          <div className="conversation-messages__history-action">
            <Button
              leadingIcon={<ChevronUp />}
              loading={messages.isFetchingNextPage}
              loadingLabel={t("conversations.messagesLoadingOlder")}
              onClick={() => void loadOlderMessages()}
              size="sm"
              variant="secondary"
            >
              {messages.isFetchNextPageError
                ? t("state.retry")
                : t("conversations.messagesLoadOlder")}
            </Button>
          </div>
        )}

        {!initialError && messages.isFetchNextPageError && (
          <div className="conversations-page__inline-error" role="alert">
            <span>{t("conversations.messagesOlderError")}</span>
          </div>
        )}

        {messages.isSuccess && items.length === 0 && (
          <ConversationWelcome
            conversation={conversation}
            coverTheme={
              conversation?.class_id
                ? coverThemeFor(
                    classroomPreferences.preferences,
                    conversation.class_id,
                  )
                : undefined
            }
          />
        )}

        {!initialError && items.length > 0 && (
          <ol
            aria-label={t("conversations.messagesHistoryLabel")}
            className="conversation-message-list"
          >
            {rows.map((row, index) => {
              const { message } = row;
              const own = message.author.user_id === actorID;
              const active = message.state === "active" ? message : null;
              const parsed = row.parsed;
              const body = parsed?.body ?? "";
              const canReply = Boolean(active) && canPostMessages;
              const canCopy = Boolean(active && body.trim());
              const canEdit =
                Boolean(active) && own && canPostMessages && body.length > 0;
              const canDelete =
                Boolean(active) && ((own && canPostMessages) || canModerate);
              const editing = active !== null && editingID === message.id;
              const confirming =
                active !== null && confirmDeleteID === message.id;
              const created = new Date(message.created_at);
              return (
                <li
                  className={cx(
                    "conversation-message",
                    own && "conversation-message--own",
                    row.grouped && "conversation-message--grouped",
                    row.continued && "conversation-message--continued",
                    !active && "conversation-message--deleted",
                  )}
                  hidden={
                    matchingIDs ? !matchingIDs.has(message.id) : undefined
                  }
                  key={message.id}
                  ref={index === 0 ? oldestMessage : undefined}
                  tabIndex={index === 0 ? -1 : undefined}
                >
                  {row.dayLabel && (
                    <div
                      className="conversation-day-divider"
                      role="presentation"
                    >
                      <span>{row.dayLabel}</span>
                    </div>
                  )}
                  <div className="conversation-message__row">
                    {!own && (
                      <PersonAvatar className="conversation-message__avatar" />
                    )}
                    <div className="conversation-message__stack">
                      <div
                        className={cx(
                          "conversation-message__meta",
                          row.grouped && "visually-hidden",
                        )}
                      >
                        <strong>{message.author.display_name}</strong>
                        <time
                          dateTime={message.created_at}
                          title={formatter.format(created)}
                        >
                          {timeFormatter.format(created)}
                        </time>
                      </div>
                      <div
                        className={cx(
                          "conversation-message__bubble",
                          active?.embed?.kind === "sticker" &&
                            "conversation-message__bubble--sticker",
                        )}
                      >
                        {!active ? (
                          <p className="conversation-message__deleted">
                            {t("conversations.messageDeleted")}
                          </p>
                        ) : editing && parsed ? (
                          <MessageEditor
                            error={
                              rowError?.messageID === message.id
                                ? rowError.text
                                : null
                            }
                            initialValue={parsed.body}
                            onCancel={finishEdit}
                            onSave={(value) => saveEdit(active, parsed, value)}
                            pending={editMessage.isPending}
                          />
                        ) : (
                          <>
                            {parsed?.quote && (
                              <blockquote className="conversation-message__quote">
                                <span className="visually-hidden">
                                  {t("conversations.quotePrefix")}:{" "}
                                </span>
                                {parsed.quote.author && (
                                  <strong>{parsed.quote.author}</strong>
                                )}
                                <span>{parsed.quote.text}</span>
                              </blockquote>
                            )}
                            {active.embed && (
                              <MessageEmbedCard
                                actorID={actorID}
                                avatar={() => <PersonAvatar />}
                                embed={active.embed}
                                messageID={active.id}
                                tenantID={tenantID}
                              />
                            )}
                            {(body ||
                              (!active.attachments?.length &&
                                !active.embed)) && (
                              <ChatFormattedText
                                className="conversation-message__content"
                                mentionClassName="conversation-mention"
                                mentions={mentionNames}
                                text={body}
                              />
                            )}
                            {active.attachments &&
                              active.attachments.length > 0 && (
                                <MessageAttachments
                                  attachments={active.attachments}
                                  tenantID={tenantID}
                                />
                              )}
                            {active.edited_at && (
                              <span className="conversation-message__edited">
                                {t("conversations.messageEdited")}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                      {active &&
                        !editing &&
                        rowError?.messageID === message.id && (
                          <p
                            className="conversation-message__error"
                            role="alert"
                          >
                            {rowError.text}
                          </p>
                        )}
                      {active && confirming && (
                        <div
                          aria-label={t("conversations.recallConfirm")}
                          className="conversation-message__confirm"
                          role="group"
                        >
                          <span>{t("conversations.recallConfirm")}</span>
                          <Button
                            autoFocus
                            loading={deleteMessage.isPending}
                            loadingLabel={t("conversations.recalling")}
                            onClick={() => confirmDelete(active)}
                            size="sm"
                            variant="danger"
                          >
                            {t("conversations.recall")}
                          </Button>
                          <Button
                            disabled={deleteMessage.isPending}
                            onClick={cancelDelete}
                            size="sm"
                            variant="secondary"
                          >
                            {t("conversations.editCancel")}
                          </Button>
                        </div>
                      )}
                    </div>
                    {active &&
                      (canReply || canCopy || canEdit || canDelete) && (
                        <div
                          aria-label={t("conversations.messageActions", {
                            name: message.author.display_name,
                          })}
                          className="conversation-message__actions"
                          role="group"
                        >
                          {canReply && (
                            <MessageActionButton
                              label={t("conversations.reply")}
                              onClick={() => startReply(active)}
                            >
                              <Reply />
                            </MessageActionButton>
                          )}
                          {canCopy && (
                            <MessageActionButton
                              label={t("conversations.copy")}
                              onClick={() =>
                                void copyMessage(chatMarkupToPlainText(body))
                              }
                            >
                              <Copy />
                            </MessageActionButton>
                          )}
                          {canEdit && (
                            <MessageActionButton
                              disabled={editing}
                              label={t("conversations.edit")}
                              onClick={(trigger) => startEdit(active, trigger)}
                            >
                              <Pencil />
                            </MessageActionButton>
                          )}
                          {canDelete && (
                            <MessageActionButton
                              danger
                              disabled={confirming}
                              label={t("conversations.recall")}
                              onClick={(trigger) => askDelete(active, trigger)}
                            >
                              <Trash2 />
                            </MessageActionButton>
                          )}
                        </div>
                      )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {!initialError && markRead.isError && (
          <div className="conversations-page__inline-error" role="alert">
            <span>{t("conversations.markReadError")}</span>
            <Button
              onClick={() => {
                markRead.reset();
                lastReadAttempt.current = null;
                markNewestRead();
              }}
              size="sm"
              variant="secondary"
            >
              {t("state.retry")}
            </Button>
          </div>
        )}
      </div>

      <p className="visually-hidden" role="status">
        {actionFeedback}
      </p>
      {actionError && (
        <p className="conversations-page__form-error" role="alert">
          {actionError}
        </p>
      )}

      {canPostMessages && !messages.isPending && !initialError && (
        <form
          className="conversation-composer"
          onSubmit={submitMessage}
          ref={composerCard}
        >
          {replyTarget && (
            <div className="conversation-composer__reply">
              <Reply aria-hidden="true" />
              <div>
                <strong>
                  {t("conversations.replyingTo", {
                    name: replyTarget.authorName,
                  })}
                </strong>
                <span>{replyTarget.excerpt}</span>
              </div>
              <button
                aria-label={t("conversations.replyCancel")}
                className="conversation-composer__chip-close"
                onClick={() => {
                  setReplyTarget(null);
                  focusComposer();
                }}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          )}
          {staged.length > 0 && (
            <div
              aria-label={t("conversations.attachmentsLabel")}
              className="conversation-composer__staged"
              role="group"
            >
              {staged.map((item) => (
                <div
                  className="conversation-staged"
                  data-status={item.status}
                  key={item.localID}
                >
                  <FileTypeIcon
                    fileName={item.name}
                    mediaType={item.mediaType}
                    size="sm"
                  />
                  <span className="conversation-staged__text">
                    <span className="conversation-staged__name">
                      {item.name}
                    </span>
                    <span className="conversation-staged__meta">
                      {item.status === "uploading"
                        ? t("conversations.attachUploading")
                        : item.status === "error"
                          ? t("conversations.attachFailed")
                          : formatAttachmentSize(item.size, language)}
                    </span>
                  </span>
                  {item.status === "error" && (
                    <button
                      aria-label={t("conversations.attachRetry", {
                        name: item.name,
                      })}
                      className="conversation-composer__chip-close"
                      onClick={() => {
                        const retry = { ...item, status: "uploading" as const };
                        updateStaged((current) =>
                          current.map((entry) =>
                            entry.localID === item.localID ? retry : entry,
                          ),
                        );
                        void uploadStaged(retry);
                      }}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" />
                    </button>
                  )}
                  <button
                    aria-label={t("conversations.attachRemove", {
                      name: item.name,
                    })}
                    className="conversation-composer__chip-close"
                    onClick={() => {
                      updateStaged((current) =>
                        current.filter(
                          (entry) => entry.localID !== item.localID,
                        ),
                      );
                      focusComposer();
                    }}
                    type="button"
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {richMode ? (
            <ChatRichComposer
              ariaDescribedBy={`conversation-composer-hint-${conversationID}`}
              ariaLabel={t("conversations.composerLabel")}
              disabled={sendMessage.isPending}
              editorRef={richField}
              handleRef={richEditor}
              id={`conversation-composer-${conversationID}`}
              initialMarkup={draft}
              menuClassName="conversation-mention-menu"
              onChange={updateDraft}
              onEscape={() => {
                if (!replyTarget) return false;
                setReplyTarget(null);
                return true;
              }}
              onPasteFiles={canUpload ? addFiles : undefined}
              onSubmit={() => composerCard.current?.requestSubmit()}
              placeholder={t("conversations.composerPlaceholder")}
              submitOnEnter={false}
              toolbarOpen={formatOpen}
              variant="conversation"
            />
          ) : (
            <>
              <label
                className="visually-hidden"
                htmlFor={`conversation-composer-${conversationID}`}
              >
                {t("conversations.composerLabel")}
              </label>
              {/* MSG-MENTION-BLUE-01: while the draft names a member, a mirror
              behind the transparent textarea paints "@Name" in blue. The
              textarea stays the only editable, focusable, readable element. */}
              <div
                className="conversation-composer__field"
                data-mentions={draftHasMention ? "true" : undefined}
              >
                {draftHasMention && (
                  <div
                    aria-hidden="true"
                    className="conversation-composer__mirror"
                    data-testid="conversation-composer-mirror"
                    ref={mentionMirror}
                  >
                    {composerPieces.map((piece, index) =>
                      piece.kind === "mention" ? (
                        <span className="conversation-mention" key={index}>
                          {piece.text}
                        </span>
                      ) : (
                        <span key={index}>{piece.text}</span>
                      ),
                    )}
                    {draft.endsWith("\n") ? "​" : null}
                  </div>
                )}
                <textarea
                  aria-describedby={`conversation-composer-hint-${conversationID}`}
                  disabled={sendMessage.isPending}
                  id={`conversation-composer-${conversationID}`}
                  onChange={(event) => {
                    updateDraft(event.target.value);
                    selection.current = {
                      end: event.target.selectionEnd,
                      start: event.target.selectionStart,
                    };
                  }}
                  onKeyDown={handleComposerKeyDown}
                  onPaste={onComposerPaste}
                  onScroll={syncMentionMirror}
                  onSelect={rememberSelection}
                  placeholder={t("conversations.composerPlaceholder")}
                  ref={composer}
                  rows={1}
                  spellCheck={draftHasMention ? false : undefined}
                  value={draft}
                />
              </div>
            </>
          )}
          {validationError && (
            <p className="conversations-page__form-error" role="alert">
              {validationError}
            </p>
          )}
          {sendMessage.isError && (
            <p className="conversations-page__form-error" role="alert">
              {messageMutationError(sendMessage.error, t)}
            </p>
          )}
          {stickerFailure && (
            <div
              className="conversation-composer__notice"
              data-tone="error"
              role="alert"
            >
              <span>
                {t("conversations.stickerSendFailed", {
                  label: chatStickerLabel(
                    stickerFailure.sticker.labels,
                    language,
                  ),
                })}{" "}
                {stickerSend.error
                  ? messageMutationError(stickerSend.error, t)
                  : null}
              </span>
              <button
                className="conversation-composer__notice-action"
                disabled={stickerSend.isPending}
                onClick={() =>
                  sendSticker(
                    stickerFailure.sticker,
                    stickerFailure.clientMessageID,
                  )
                }
                type="button"
              >
                {t("media.chat.sticker.retry")}
              </button>
              <button
                aria-label={t("conversations.screenshotDismiss")}
                className="conversation-composer__chip-close"
                onClick={() => setStickerFailure(null)}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          )}
          {cardNotice && (
            <div className="conversation-composer__notice" role="status">
              <span>{cardNotice}</span>
              <button
                aria-label={t("conversations.screenshotDismiss")}
                className="conversation-composer__chip-close"
                onClick={() => setCardNotice(null)}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          )}
          {screenshot.phase === "countdown" && (
            <div className="conversation-composer__notice" role="status">
              <span>
                {t("conversations.screenshotCountdown", {
                  seconds: screenshot.countdown,
                })}
              </span>
              <button
                className="conversation-composer__notice-action"
                onClick={screenshot.cancelCountdown}
                type="button"
              >
                {t("conversations.screenshotCancel")}
              </button>
            </div>
          )}
          {screenshot.failedMode && (
            <div
              className="conversation-composer__notice"
              data-tone="error"
              role="alert"
            >
              <span>{t("conversations.screenshotFailed")}</span>
              <button
                className="conversation-composer__notice-action"
                onClick={() => {
                  const mode = screenshot.failedMode;
                  if (mode) screenshot.start(mode);
                }}
                type="button"
              >
                {t("conversations.screenshotRetry")}
              </button>
              <button
                aria-label={t("conversations.screenshotDismiss")}
                className="conversation-composer__chip-close"
                onClick={screenshot.dismissFailure}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          )}
          <div className="conversation-composer__toolbar">
            <div className="conversation-composer__tools">
              <button
                aria-label={t("chatFormat.toggle")}
                aria-pressed={formatOpen}
                className="conversation-composer__tool conversation-composer__format"
                data-tooltip={t("chatFormat.toggle")}
                disabled={sendMessage.isPending}
                onClick={toggleFormatting}
                type="button"
              >
                <PenLine aria-hidden="true" />
              </button>
              <ChatExpressionPicker
                boundaryRef={composerCard}
                composerRef={richMode ? richField : composer}
                disabled={sendMessage.isPending}
                onOpenChange={setEmojiOpen}
                onSelectEmoji={(emoji) => insertIntoDraft(emoji, false)}
                onSendSticker={(sticker) => sendSticker(sticker)}
                open={emojiOpen}
                recentScope={recentScope}
                tenantID={tenantID}
              />
              <Menu>
                <MenuTrigger asChild>
                  <button
                    aria-label={t("conversations.mention")}
                    className="conversation-composer__tool"
                    data-tooltip={t("conversations.mention")}
                    disabled={sendMessage.isPending}
                    onPointerDown={rememberSelection}
                    type="button"
                  >
                    <AtSign aria-hidden="true" />
                  </button>
                </MenuTrigger>
                <MenuContent
                  align="start"
                  className="conversation-mention-menu"
                  onCloseAutoFocus={(event) => {
                    if (mentionInserted.current) {
                      event.preventDefault();
                      mentionInserted.current = false;
                      focusComposer();
                    }
                  }}
                  side="top"
                >
                  {mentionCandidates.length > 0 ? (
                    mentionCandidates.map((candidate) => (
                      <MenuItem
                        key={candidate.userID}
                        onSelect={() => {
                          mentionInserted.current = true;
                          insertIntoDraft(`@${candidate.name} `, true);
                        }}
                      >
                        <PersonAvatar size="xs" />
                        <span>{candidate.name}</span>
                      </MenuItem>
                    ))
                  ) : (
                    <MenuItem disabled>
                      {t("conversations.mentionEmpty")}
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
              {canUpload && captureSupported && (
                <ComposerCaptureMenu
                  busy={
                    screenshot.phase === "picking" ||
                    screenshot.phase === "countdown"
                  }
                  disabled={sendMessage.isPending}
                  fullReason={fullReason}
                  onCapture={screenshot.start}
                />
              )}
              {(canUpload || classID) && (
                <ComposerFileMenu
                  canUpload={canUpload}
                  classID={classID}
                  disabled={sendMessage.isPending}
                  fullReason={fullReason}
                  onPickFromDevice={() => fileInput.current?.click()}
                />
              )}
              {canUpload && (
                <input
                  accept={CHAT_FILE_ACCEPT}
                  data-testid="conversation-file-input"
                  hidden
                  multiple
                  onChange={onPickFiles}
                  ref={fileInput}
                  type="file"
                />
              )}
              <button
                aria-label={t("conversations.contactCard")}
                className="conversation-composer__tool"
                data-tooltip={t("conversations.contactCard")}
                disabled={sendMessage.isPending}
                onClick={() => openCardDialog("contact")}
                type="button"
              >
                <Contact aria-hidden="true" />
              </button>
              {canShareInstantClass && (
                <button
                  aria-label={t("conversations.instantClass")}
                  className="conversation-composer__tool"
                  data-tooltip={t("conversations.instantClass")}
                  disabled={sendMessage.isPending}
                  onClick={() => openCardDialog("class")}
                  type="button"
                >
                  <Presentation aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="conversation-composer__end">
              <span
                className="visually-hidden"
                id={`conversation-composer-hint-${conversationID}`}
              >
                {t("conversations.composerHint")}
              </span>
              {sentFeedback && (
                <span className="conversation-composer__success" role="status">
                  <Check aria-hidden="true" />
                  {t("conversations.messageSent")}
                </span>
              )}
              <Button
                className="conversation-composer__send"
                data-ready={hasContent ? "true" : "false"}
                leadingIcon={<SendHorizontal />}
                loading={sendMessage.isPending}
                loadingLabel={t("conversations.messageSending")}
                type="submit"
              >
                {sendMessage.isError
                  ? t("conversations.messageRetry")
                  : t("conversations.messageSend")}
              </Button>
            </div>
          </div>
        </form>
      )}

      {!canPostMessages && readOnlyNotice && (
        <div className="conversation-composer-locked">
          <Lock aria-hidden="true" />
          <p role="status">{readOnlyNotice}</p>
        </div>
      )}
      {dragging && (
        <div aria-hidden="true" className="conversation-messages__drop">
          {t("conversations.dropFiles")}
        </div>
      )}
      {screenshot.frame && (
        <ScreenshotEditor
          capture={screenshot.frame}
          onCancel={screenshot.cancelEditor}
          onConfirm={screenshot.confirm}
          onRetake={screenshot.retake}
          returnFocus={focusComposer}
        />
      )}
      {cardDialog === "contact" && (
        <ContactCardDialog
          actorID={actorID}
          avatar={() => <PersonAvatar size="xs" />}
          onClose={() => setCardDialog(null)}
          onSend={sendContactCard}
          tenantID={tenantID}
        />
      )}
      {cardDialog === "class" && (
        <InstantClassDialog
          onClose={() => setCardDialog(null)}
          onCreate={createInstantClass}
        />
      )}
    </section>
  );
}

function MessageActionButton({
  children,
  danger = false,
  disabled = false,
  label,
  onClick,
}: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  label: string;
  onClick: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <button
      aria-label={label}
      className={cx(
        "conversation-message__action",
        danger && "conversation-message__action--danger",
      )}
      data-tooltip={label}
      disabled={disabled}
      onClick={(event) => onClick(event.currentTarget)}
      type="button"
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

function MessageEditor({
  error,
  initialValue,
  onCancel,
  onSave,
  pending,
}: {
  error: string | null;
  initialValue: string;
  onCancel: () => void;
  onSave: (value: string) => void;
  pending: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialValue);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = field.current;
    if (!element) {
      return;
    }
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  return (
    <form
      className="conversation-message__editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value);
      }}
    >
      <textarea
        aria-label={t("conversations.editLabel")}
        disabled={pending}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (
            event.key === "Enter" &&
            (event.ctrlKey || event.metaKey)
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        ref={field}
        rows={2}
        value={value}
      />
      <span className="conversation-message__editor-hint">
        {t("conversations.editHint")}
      </span>
      {error && (
        <p className="conversation-message__error" role="alert">
          {error}
        </p>
      )}
      <div className="conversation-message__editor-actions">
        <Button
          disabled={pending}
          onClick={onCancel}
          size="sm"
          variant="secondary"
        >
          {t("conversations.editCancel")}
        </Button>
        <Button
          loading={pending}
          loadingLabel={t("conversations.editSaving")}
          size="sm"
          type="submit"
        >
          {t("conversations.editSave")}
        </Button>
      </div>
    </form>
  );
}

function MessageAttachments({
  attachments,
  tenantID,
}: {
  attachments: readonly MessageAttachment[];
  tenantID: string;
}) {
  const { language, t } = useI18n();
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loadingID, setLoadingID] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const objectURLs = useRef<string[]>([]);

  useEffect(
    () => () => {
      for (const url of objectURLs.current) {
        URL.revokeObjectURL(url);
      }
      objectURLs.current = [];
    },
    [],
  );

  const open = async (attachment: MessageAttachment) => {
    setFailed(false);
    setLoadingID(attachment.id);
    try {
      const blob = await fetchConversationAttachmentBlob(
        tenantID,
        attachment.conversation_id,
        attachment.id,
      );
      const url = URL.createObjectURL(blob);
      objectURLs.current.push(url);
      if (attachment.kind === "image") {
        setPreviews((current) => ({ ...current, [attachment.id]: url }));
      } else {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = attachment.display_name;
        anchor.rel = "noopener";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      }
    } catch {
      setFailed(true);
    } finally {
      setLoadingID(null);
    }
  };

  return (
    <div
      aria-label={t("conversations.attachmentsLabel")}
      className="conversation-message__attachments"
      role="group"
    >
      {attachments.map((attachment) => {
        const preview = previews[attachment.id];
        if (preview) {
          return (
            <a
              className="conversation-attachment conversation-attachment--image"
              href={preview}
              key={attachment.id}
              rel="noopener noreferrer"
              target="_blank"
            >
              <img alt={attachment.display_name} src={preview} />
            </a>
          );
        }
        return (
          <button
            aria-busy={loadingID === attachment.id || undefined}
            aria-label={t("conversations.attachmentOpen", {
              name: attachment.display_name,
            })}
            className="conversation-attachment"
            disabled={loadingID === attachment.id}
            key={attachment.id}
            onClick={() => void open(attachment)}
            type="button"
          >
            <FileTypeIcon
              fileName={attachment.display_name}
              mediaType={attachment.media_type}
              size="sm"
            />
            <span className="conversation-attachment__text">
              <span className="conversation-attachment__name">
                {attachment.display_name}
              </span>
              <span className="conversation-attachment__size">
                {formatAttachmentSize(attachment.size_bytes, language)}
              </span>
            </span>
          </button>
        );
      })}
      {failed && (
        <p className="conversation-message__error" role="alert">
          {t("conversations.attachmentError")}
        </p>
      )}
    </div>
  );
}

function ConversationWelcome({
  conversation,
  coverTheme,
}: {
  conversation?: Conversation;
  coverTheme?: ClassCoverTheme;
}) {
  const { t } = useI18n();
  const classID =
    conversation?.kind === "class" && conversation.class_status !== "archived"
      ? conversation.class_id
      : undefined;

  if (conversation && classID) {
    return (
      <div className="conversation-welcome conversation-welcome--class">
        <h4 className="conversation-welcome__title">
          {t("conversations.welcomeClassTitle")}
        </h4>
        <p className="visually-hidden">
          {t("conversations.messagesEmptyTitle")}.{" "}
          {t("conversations.messagesEmptyDescription")}
        </p>
        <ul className="conversation-welcome__actions">
          <li>
            <Link
              className="conversation-welcome__action"
              to={`/app/classrooms/${classID}?tab=members`}
            >
              <span aria-hidden="true" className="conversation-welcome__icon">
                <UserPlus />
              </span>
              <span className="conversation-welcome__text">
                <strong>{t("conversations.welcomeMembersTitle")}</strong>
                <span>{t("conversations.welcomeMembersDescription")}</span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="conversation-welcome__chevron"
              />
            </Link>
          </li>
          <li>
            <Link
              className="conversation-welcome__action"
              to={`/app/classrooms/${classID}`}
            >
              <span aria-hidden="true" className="conversation-welcome__icon">
                <CalendarClock />
              </span>
              <span className="conversation-welcome__text">
                <strong>{t("conversations.welcomeSessionsTitle")}</strong>
                <span>{t("conversations.welcomeSessionsDescription")}</span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="conversation-welcome__chevron"
              />
            </Link>
          </li>
        </ul>
      </div>
    );
  }

  const description =
    conversation?.kind === "direct"
      ? t("conversations.welcomeDirectDescription")
      : conversation?.kind === "room"
        ? t("conversations.welcomeRoomDescription")
        : t("conversations.messagesEmptyDescription");
  return (
    <div className="conversation-welcome">
      {conversation ? (
        <ConversationAvatar
          conversation={conversation}
          coverTheme={coverTheme}
          size="lg"
        />
      ) : (
        <span aria-hidden="true" className="conversation-welcome__glyph">
          <MessageCircle />
        </span>
      )}
      <h4 className="conversation-welcome__title">
        {t("conversations.messagesEmptyTitle")}
      </h4>
      <p className="conversation-welcome__description">{description}</p>
    </div>
  );
}

function dayKey(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).format(value);
}

function buildMessageRows(
  items: readonly Message[],
  {
    language,
    locale,
    t,
    timeZone,
  }: {
    language: "vi" | "en";
    locale: string;
    t: Translate;
    timeZone: string;
  },
): MessageRow[] {
  const now = new Date();
  const todayKey = dayKey(now, timeZone);
  const yesterdayKey = dayKey(
    new Date(now.getTime() - 24 * 60 * 60 * 1000),
    timeZone,
  );
  const dayFormatter = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: language === "vi" ? "numeric" : "long",
    timeZone,
    weekday: "long",
    year: "numeric",
  });
  const rows: MessageRow[] = [];
  let previous: { key: string; message: Message; time: number } | null = null;
  for (const message of items) {
    const created = new Date(message.created_at);
    const time = created.getTime();
    const key = dayKey(created, timeZone);
    const newDay = !previous || previous.key !== key;
    const grouped =
      !newDay &&
      previous !== null &&
      previous.message.state === "active" &&
      message.state === "active" &&
      previous.message.author.user_id === message.author.user_id &&
      time - previous.time >= 0 &&
      time - previous.time <= GROUP_WINDOW_MS;
    const previousRow = rows[rows.length - 1];
    if (grouped && previousRow) {
      previousRow.continued = true;
    }
    rows.push({
      continued: false,
      dayLabel: newDay
        ? key === todayKey
          ? t("conversations.today")
          : key === yesterdayKey
            ? t("conversations.yesterday")
            : dayFormatter.format(created)
        : null,
      grouped,
      message,
      parsed:
        message.state === "active" ? parseQuotedMessage(message.content) : null,
    });
    previous = { key, message, time };
  }
  return rows;
}

function normalizeDraft(value: string) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function rowMutationError(
  error: Error,
  fallback: "conversations.editError" | "conversations.recallError",
  t: Translate,
) {
  if (error instanceof APIRequestError) {
    if (error.status === 409) {
      return t("conversations.editConflict");
    }
    if (error.status === 403) {
      return t("conversations.messageSendForbidden");
    }
    if (error.status === 404) {
      return t("conversations.messageSendUnavailable");
    }
    if (error.status === 429) {
      return t("conversations.messageSendRateLimited");
    }
  }
  return t(fallback);
}

function messageMutationError(error: Error, t: Translate) {
  if (error instanceof APIRequestError) {
    if (error.status === 403) {
      return t("conversations.messageSendForbidden");
    }
    if (error.status === 404) {
      return t("conversations.messageSendUnavailable");
    }
    if (error.status === 409) {
      return t("conversations.messageSendConflict");
    }
    if (error.status === 429) {
      return t("conversations.messageSendRateLimited");
    }
  }
  return t("conversations.messageSendError");
}
