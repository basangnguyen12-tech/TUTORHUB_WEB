import { Fragment, useMemo, type ReactNode } from "react";
import { linkifyChatText } from "../media/classroomChatMedia";
import {
  type ChatAlign,
  type ChatDocument,
  type ChatLine,
  type ChatRun,
  chatDocumentHasFormatting,
  mayContainChatMarkup,
  parseChatMarkup,
} from "./chatMarkup";
import "./chatFormat.css";

interface PieceClasses {
  linkClassName?: string;
  mentionClassName: string;
  mentions: readonly string[];
}

function cx(...values: (string | false | null | undefined)[]) {
  return values.filter(Boolean).join(" ");
}

/** Text with safe http(s) links and blue `@Name` mentions. */
function LinkedPieces({
  linkClassName,
  mentionClassName,
  mentions,
  text,
}: PieceClasses & { text: string }) {
  const pieces = useMemo(
    () => linkifyChatText(text, mentions),
    [mentions, text],
  );
  if (pieces.length === 1 && pieces[0]?.kind === "text") {
    return <>{text}</>;
  }
  return (
    <>
      {pieces.map((piece, index) =>
        piece.kind === "mention" ? (
          <span className={mentionClassName} key={`${index}-mention`}>
            {piece.text}
          </span>
        ) : piece.kind === "link" ? (
          <a
            className={linkClassName}
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

function StyledRun({ classes, run }: { classes: PieceClasses; run: ChatRun }) {
  let node: ReactNode = <LinkedPieces {...classes} text={run.text} />;
  const { style } = run;
  if (style.italic) node = <em>{node}</em>;
  if (style.bold) node = <strong>{node}</strong>;
  if (style.underline) node = <u>{node}</u>;
  if (style.strike) node = <s>{node}</s>;
  if (style.color || style.size) {
    node = (
      <span
        className={cx(
          style.color && `chat-fmt-color--${style.color}`,
          style.size && `chat-fmt-size--${style.size}`,
        )}
      >
        {node}
      </span>
    );
  }
  return node;
}

function LineRuns({
  classes,
  line,
}: {
  classes: PieceClasses;
  line: ChatLine;
}) {
  return (
    <>
      {line.runs.map((run, index) => (
        <StyledRun classes={classes} key={index} run={run} />
      ))}
    </>
  );
}

interface LineGroup {
  align: ChatAlign;
  kind: ChatLine["kind"];
  lines: ChatLine[];
}

function groupLines(document: ChatDocument): LineGroup[] {
  const groups: LineGroup[] = [];
  for (const line of document.lines) {
    const last = groups[groups.length - 1];
    if (last && last.kind === line.kind && last.align === line.align) {
      last.lines.push(line);
    } else {
      groups.push({ align: line.align, kind: line.kind, lines: [line] });
    }
  }
  return groups;
}

function TextLines({
  classes,
  lines,
}: {
  classes: PieceClasses;
  lines: readonly ChatLine[];
}) {
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 && "\n"}
          <LineRuns classes={classes} line={line} />
        </Fragment>
      ))}
    </>
  );
}

/**
 * MSG-RICH-COMPOSE-01: renders a message body written in chat markup.
 * Ordinary text keeps the exact plain output (one text node in the wrapper);
 * only formatted messages get styled runs, lists and aligned blocks. All
 * output is React elements; no HTML from the message is ever injected.
 */
export function ChatFormattedText({
  as = "p",
  className,
  linkClassName,
  mentionClassName,
  mentions,
  text,
}: {
  /** Wrapper for inline-only text; block content always uses a `div`. */
  as?: "p" | "span" | "div";
  className?: string;
  linkClassName?: string;
  mentionClassName: string;
  mentions: readonly string[];
  text: string;
}) {
  const document = useMemo(
    () => (mayContainChatMarkup(text) ? parseChatMarkup(text) : null),
    [text],
  );
  const classes: PieceClasses = { linkClassName, mentionClassName, mentions };
  const Wrapper = as;
  if (!document || !chatDocumentHasFormatting(document)) {
    const plain = document
      ? document.lines
          .map((line) => line.runs.map((run) => run.text).join(""))
          .join("\n")
      : text;
    return (
      <Wrapper className={className}>
        <LinkedPieces {...classes} text={plain} />
      </Wrapper>
    );
  }
  const groups = groupLines(document);
  const inlineOnly =
    groups.length === 1 &&
    groups[0]?.kind === "text" &&
    groups[0].align === "left";
  if (inlineOnly) {
    return (
      <Wrapper className={cx(className, "chat-fmt")}>
        <TextLines classes={classes} lines={document.lines} />
      </Wrapper>
    );
  }
  const aligned = groups.some((group) => group.align !== "left");
  return (
    <div
      className={cx(
        className,
        "chat-fmt",
        "chat-fmt--blocks",
        aligned && "chat-fmt--aligned",
      )}
    >
      {groups.map((group, index) => {
        const align = group.align === "left" ? undefined : group.align;
        if (group.kind === "text") {
          return (
            <div className="chat-fmt__block" data-align={align} key={index}>
              <TextLines classes={classes} lines={group.lines} />
            </div>
          );
        }
        const items = group.lines.map((line, itemIndex) => (
          <li key={itemIndex}>
            {line.runs.length > 0 ? (
              <LineRuns classes={classes} line={line} />
            ) : (
              <br />
            )}
          </li>
        ));
        return group.kind === "bullet" ? (
          <ul className="chat-fmt__list" data-align={align} key={index}>
            {items}
          </ul>
        ) : (
          <ol
            className="chat-fmt__list"
            data-align={align}
            key={index}
            start={group.lines[0]?.ordinal ?? 1}
          >
            {items}
          </ol>
        );
      })}
    </div>
  );
}
