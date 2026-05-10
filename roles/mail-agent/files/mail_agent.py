#!/usr/bin/env python3
"""Mail agent — auto-replies to whitelisted senders using the Claude Agent SDK.

One invocation does three things in order:
  1. Poll IMAP, find new unseen messages from allowed senders that we have
     not already processed (state.json tracks message-ids).
  2. For each new message: archive it, run the Claude agent to draft a
     reply (the agent has Read/Write/Grep over a memory dir for facts),
     enqueue the reply with a random 1h-48h send delay.
  3. Walk the queue, send any replies whose target time has elapsed.

Config comes entirely from environment variables (see mail-agent.env.j2).
"""

from __future__ import annotations

import asyncio
import email
import email.message
import email.policy
import email.utils
import imaplib
import json
import logging
import os
import random
import re
import smtplib
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    query,
)


# --- Config (env-driven) ---

def _env(name: str, default: str | None = None, required: bool = False) -> str:
    val = os.environ.get(name, default)
    if required and not val:
        sys.exit(f"missing required env var: {name}")
    return val or ""


def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


def _env_list(name: str) -> list[str]:
    raw = os.environ.get(name, "").strip()
    return [s.strip().lower() for s in raw.split(",") if s.strip()]


IMAP_HOST = _env("MAIL_AGENT_IMAP_HOST", "127.0.0.1")
IMAP_PORT = _env_int("MAIL_AGENT_IMAP_PORT", 993)
IMAP_USER = _env("MAIL_AGENT_IMAP_USER", required=True)
IMAP_PASSWORD = _env("MAIL_AGENT_IMAP_PASSWORD", required=True)
IMAP_FOLDER = _env("MAIL_AGENT_IMAP_FOLDER", "INBOX")

SMTP_HOST = _env("MAIL_AGENT_SMTP_HOST", "127.0.0.1")
SMTP_PORT = _env_int("MAIL_AGENT_SMTP_PORT", 25)

REPLY_FROM = _env("MAIL_AGENT_REPLY_FROM", required=True)
ALLOWED_SENDERS = _env_list("MAIL_AGENT_ALLOWED_SENDERS")

MIN_DELAY_SEC = _env_int("MAIL_AGENT_MIN_DELAY_SECONDS", 3600)
MAX_DELAY_SEC = _env_int("MAIL_AGENT_MAX_DELAY_SECONDS", 172800)

MODEL = _env("MAIL_AGENT_MODEL", "claude-sonnet-4-6")
PERSONA = _env("MAIL_AGENT_PERSONA", required=True)

DATA_DIR = Path(_env("MAIL_AGENT_DATA_DIR", "/var/lib/mail-agent"))
MEMORY_DIR = DATA_DIR / "memory"
ARCHIVE_DIR = DATA_DIR / "archive"
QUEUE_DIR = DATA_DIR / "queue"
STATE_FILE = DATA_DIR / "state.json"

os.environ.setdefault("ANTHROPIC_API_KEY", _env("MAIL_AGENT_ANTHROPIC_API_KEY", required=True))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("mail-agent")


# --- State (which message-ids we've already processed) ---

def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"processed_message_ids": []}
    return json.loads(STATE_FILE.read_text())


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


# --- IMAP polling ---

def parse_addr(header_val: str | None) -> str:
    if not header_val:
        return ""
    _, addr = email.utils.parseaddr(header_val)
    return addr.lower()


def is_auto_submitted(msg: email.message.EmailMessage) -> bool:
    auto = (msg.get("Auto-Submitted") or "").lower()
    if auto and auto != "no":
        return True
    if msg.get("X-Auto-Reply"):
        return True
    if (msg.get("Precedence") or "").lower() in {"bulk", "list", "junk"}:
        return True
    return False


def _imap_sender_search(senders: Iterable[str]) -> str:
    """Build an IMAP SEARCH expression matching any of the given From: addresses.

    IMAP's `OR` is binary, so chains of N senders need (N-1) ORs prefixed.
    Without an allowlist we fall back to scanning the last week.
    """
    s = list(senders)
    if not s:
        # No allowlist set — scan the last 7 days so we still pick up
        # anything the operator wired up after the fact.
        since = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%d-%b-%Y")
        return f'SINCE "{since}"'
    if len(s) == 1:
        return f'FROM "{s[0]}"'
    expr = f'FROM "{s[-1]}"'
    for addr in reversed(s[:-1]):
        expr = f'OR FROM "{addr}" ({expr})'
    return expr


def fetch_new_messages(state: dict) -> list[email.message.EmailMessage]:
    """Return new messages from allowed senders we haven't processed yet.

    We search by sender (or the last 7 days as fallback) and dedup against
    state.processed_message_ids — relying on UNSEEN was unreliable because
    any other IMAP client (phone, webmail) marks mail Seen before we see it.
    """
    processed = set(state.get("processed_message_ids", []))
    out: list[email.message.EmailMessage] = []

    imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    try:
        imap.login(IMAP_USER, IMAP_PASSWORD)
        imap.select(IMAP_FOLDER, readonly=True)
        search_expr = _imap_sender_search(ALLOWED_SENDERS)
        log.info("IMAP search: %s", search_expr)
        typ, data = imap.search(None, search_expr)
        if typ != "OK":
            log.warning("IMAP search failed: %s", typ)
            return []
        for num in data[0].split():
            typ, fetched = imap.fetch(num, "(RFC822)")
            if typ != "OK" or not fetched or fetched[0] is None:
                continue
            raw = fetched[0][1]
            msg = email.message_from_bytes(raw, policy=email.policy.default)
            mid = msg.get("Message-ID", "").strip()
            sender = parse_addr(msg.get("From"))
            if not mid:
                log.info("skip: message has no Message-ID")
                continue
            if mid in processed:
                continue
            if ALLOWED_SENDERS and sender not in ALLOWED_SENDERS:
                log.info("skip: sender %s not in allowlist", sender)
                continue
            if is_auto_submitted(msg):
                log.info("skip: auto-submitted message from %s", sender)
                continue
            out.append(msg)
    finally:
        try:
            imap.close()
        except Exception:
            pass
        imap.logout()
    return out


# --- Archive ---

def archive_path(msg: email.message.EmailMessage) -> Path:
    now = datetime.now(timezone.utc)
    safe_id = re.sub(r"[^A-Za-z0-9._-]", "_", msg.get("Message-ID", "no-id"))[:120]
    folder = ARCHIVE_DIR / f"{now:%Y}" / f"{now:%m}"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / safe_id


def archive_message(msg: email.message.EmailMessage) -> Path:
    base = archive_path(msg)
    eml = base.with_suffix(".eml")
    eml.write_bytes(msg.as_bytes())
    return base


# --- Agent run ---

def message_text(msg: email.message.EmailMessage) -> str:
    """Return the plaintext body of a message, falling back to HTML stripped."""
    body_part = msg.get_body(preferencelist=("plain", "html"))
    if body_part is None:
        return ""
    text = body_part.get_content()
    if body_part.get_content_subtype() == "html":
        text = re.sub(r"<[^>]+>", "", text)
    return text.strip()


SYSTEM_PROMPT = f"""You are an email-reply agent. You answer messages on behalf
of a real person, drawing on a memory directory of previously-learned facts.

PERSONA YOU SPEAK AS:
{PERSONA}

WORKING DIRECTORY LAYOUT: you start in {DATA_DIR}. Two subdirectories matter:
  - ./memory/ — markdown files of previously-learned facts (read & write here)
  - ./reply.txt — where you must write the final reply body for this message

Use the Read, Grep, Glob, and Write tools.

MEMORY FORMAT: one markdown file per fact or topic, in ./memory/. Lead each
file with YAML frontmatter:
  ---
  title: short title
  tags: [tag1, tag2]
  source_message_id: <message-id of the conversation it came from>
  learned_at: <ISO8601 UTC>
  ---
  Body of the fact in plain prose.

There is also an index file ./memory/MEMORY.md listing every fact as one
bullet:
  - [title](filename.md) — one-line summary

YOUR JOB FOR EACH INCOMING MESSAGE:
  1. Grep / read ./memory/ for context relevant to the sender, subject, and
     any names or topics in the message.
  2. Draft a reply in the persona above. Keep tone consistent with prior
     replies if memory contains them.
  3. Identify any NEW facts worth remembering for next time (preferences,
     plans, names, decisions, anything the sender treats as durable). For
     each: write a new file in ./memory/, then append a bullet to
     ./memory/MEMORY.md. Skip if nothing new is worth saving.
  4. Write the final reply body — plain text, no signature — to ./reply.txt
     using the Write tool. Overwrite if it already exists.

Do not send the reply yourself. Do not invent facts not in memory or in the
incoming message. If you cannot answer from memory + the message alone, say
so politely in the reply rather than guessing.
"""


async def run_agent(msg: email.message.EmailMessage) -> str:
    """Run the Claude agent, return the reply text it wrote to reply.txt.

    The agent runs with cwd=DATA_DIR so it can both read/write ./memory/
    and produce ./reply.txt in one tree. We wipe reply.txt before each run
    so a hung agent can't leak the previous message's reply.
    """
    reply_file = DATA_DIR / "reply.txt"
    if reply_file.exists():
        reply_file.unlink()

    sender = parse_addr(msg.get("From"))
    subject = msg.get("Subject", "")
    mid = msg.get("Message-ID", "")
    body = message_text(msg)

    user_prompt = (
        f"INCOMING EMAIL\n"
        f"From: {sender}\n"
        f"Subject: {subject}\n"
        f"Message-ID: {mid}\n"
        f"---\n{body}\n---\n\n"
        f"Search ./memory/ for context, draft a reply, and save it to "
        f"./reply.txt. Update ./memory/ with any new durable facts."
    )

    options = ClaudeAgentOptions(
        model=MODEL,
        cwd=str(DATA_DIR),
        system_prompt=SYSTEM_PROMPT,
        allowed_tools=["Read", "Write", "Edit", "Glob", "Grep"],
        # Headless: bypass interactive permission prompts. Tool exposure is
        # already constrained by allowed_tools and by cwd being the
        # agent-owned data dir.
        permission_mode="bypassPermissions",
        max_turns=30,
    )

    cost_usd = 0.0
    async for message in query(prompt=user_prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if hasattr(block, "text") and block.text.strip():
                    log.info("agent: %s", block.text.strip().splitlines()[0][:200])
        elif isinstance(message, ResultMessage):
            cost_usd = getattr(message, "total_cost_usd", 0.0) or 0.0

    log.info("agent done, cost=$%.4f", cost_usd)

    if not reply_file.exists():
        raise RuntimeError("agent did not write reply.txt")
    return reply_file.read_text().strip()


# --- Reply queue ---

def random_delay_seconds() -> int:
    return random.randint(MIN_DELAY_SEC, MAX_DELAY_SEC)


def enqueue_reply(original: email.message.EmailMessage, reply_body: str) -> Path:
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    send_at = datetime.now(timezone.utc) + timedelta(seconds=random_delay_seconds())
    item = {
        "id": str(uuid.uuid4()),
        "in_reply_to": original.get("Message-ID", ""),
        "references": original.get("References", "") or original.get("Message-ID", ""),
        "to": parse_addr(original.get("Reply-To") or original.get("From")),
        "subject": _make_reply_subject(original.get("Subject", "")),
        "from": REPLY_FROM,
        "body": reply_body,
        "queued_at": datetime.now(timezone.utc).isoformat(),
        "send_after": send_at.isoformat(),
    }
    path = QUEUE_DIR / f"{item['id']}.json"
    # Atomic write: a crashed/killed process between truncate and write would
    # otherwise leave a zero-byte file in the queue that would error on every
    # subsequent run forever.
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(item, indent=2))
    tmp.replace(path)
    log.info("queued reply id=%s send_after=%s", item["id"], send_at.isoformat())
    return path


def _make_reply_subject(orig_subject: str) -> str:
    if orig_subject.lower().startswith("re:"):
        return orig_subject
    return f"Re: {orig_subject}" if orig_subject else "Re:"


def send_due_replies() -> None:
    if not QUEUE_DIR.exists():
        return
    quarantine = QUEUE_DIR / ".failed"
    now = datetime.now(timezone.utc)
    for queue_file in sorted(QUEUE_DIR.glob("*.json")):
        try:
            raw = queue_file.read_text()
            item = json.loads(raw)
            send_at = datetime.fromisoformat(item["send_after"])
            if send_at > now:
                continue
            send_reply(item)
            queue_file.unlink()
            log.info("sent reply id=%s to=%s", item["id"], item["to"])
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            # Bad payload — move it out of the active queue so we don't
            # re-error on every tick. Operator can inspect under .failed/.
            quarantine.mkdir(exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
            dest = quarantine / f"{queue_file.stem}.{stamp}.json"
            queue_file.rename(dest)
            log.error("quarantined unreadable queue file %s -> %s: %s", queue_file.name, dest, exc)
        except Exception as exc:
            # Transient (SMTP outage, disk full, etc.) — leave the file in
            # place so the next tick can retry.
            log.exception("failed to send queued reply %s: %s", queue_file.name, exc)


def send_reply(item: dict) -> None:
    reply = email.message.EmailMessage()
    reply["From"] = item["from"]
    reply["To"] = item["to"]
    reply["Subject"] = item["subject"]
    reply["Date"] = email.utils.formatdate(localtime=True)
    reply["Message-ID"] = email.utils.make_msgid(domain=item["from"].split("@")[-1])
    if item.get("in_reply_to"):
        reply["In-Reply-To"] = item["in_reply_to"]
    if item.get("references"):
        reply["References"] = item["references"]
    # RFC 3834: identify ourselves as an automatic responder so other agents
    # don't loop with us. X-Auto-Reply is the conventional belt-and-braces.
    reply["Auto-Submitted"] = "auto-replied"
    reply["X-Auto-Reply"] = "true"
    reply.set_content(item["body"])

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as smtp:
        smtp.send_message(reply)

    _append_to_sent(reply)


def _append_to_sent(msg: email.message.EmailMessage) -> None:
    """Save an outgoing message to the IMAP Sent folder.

    SMTP delivery is independent of the user's mailbox — without this step
    the reply lands at the recipient but never appears in Roundcube /
    phone clients (which read the Sent IMAP folder). Failures here are
    logged but never raised: the recipient already has the mail.
    """
    try:
        imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        try:
            imap.login(IMAP_USER, IMAP_PASSWORD)
            # `\Seen` so it doesn't show as unread; INTERNALDATE = now.
            imap.append(
                "Sent",
                "(\\Seen)",
                imaplib.Time2Internaldate(time.time()),
                msg.as_bytes(),
            )
        finally:
            imap.logout()
    except Exception as exc:
        log.warning("could not append outgoing message to Sent folder: %s", exc)


# --- Top-level loop ---

def process_inbox() -> None:
    state = load_state()
    processed = set(state.get("processed_message_ids", []))
    new = fetch_new_messages(state)
    log.info("found %d new candidate messages", len(new))
    for msg in new:
        mid = msg.get("Message-ID", "").strip()
        try:
            base = archive_message(msg)
            reply = asyncio.run(run_agent(msg))
            (base.with_suffix(".reply.txt")).write_text(reply)
            enqueue_reply(msg, reply)
            processed.add(mid)
            state["processed_message_ids"] = sorted(processed)
            save_state(state)
        except Exception as exc:
            log.exception("failed to process %s: %s", mid, exc)


def main() -> int:
    for d in (MEMORY_DIR, ARCHIVE_DIR, QUEUE_DIR):
        d.mkdir(parents=True, exist_ok=True)
    if not (MEMORY_DIR / "MEMORY.md").exists():
        (MEMORY_DIR / "MEMORY.md").write_text("# Memory index\n\nNo facts yet.\n")
    process_inbox()
    send_due_replies()
    return 0


if __name__ == "__main__":
    sys.exit(main())
