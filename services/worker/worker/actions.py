"""Pull action items out of a meeting transcript.

Rule-based on purpose: it runs on a CPU-only worker with no API key and its
behaviour is easy to explain and test. It looks for commitment and request
phrasing ("I'll send…", "can you…", "we need to…") and for deadlines.
"""
from __future__ import annotations

import re

# Phrases that usually mark a task being taken on or handed out.
_COMMITMENT = re.compile(
    r"""\b(
        i['’]ll | i\ will | i['’]m\ going\ to | i\ can\ take |
        we['’]ll | we\ will | we\ need\ to | we\ should | we\ have\ to | we\ must |
        let['’]?s | can\ you | could\ you | would\ you | will\ you | please |
        you\ need\ to | make\ sure | action\ item | to-?do | follow\ up | follow-up |
        assign(?:ed)?\ to | is\ going\ to | needs?\ to | by\ (?:the\ )?end\ of
    )\b""",
    re.IGNORECASE | re.VERBOSE,
)

_DUE = re.compile(
    r"""\b(
        (?:by|before|on|until|due)\s+
        (?:the\s+)?
        (?:end\ of\ (?:the\ )?(?:day|week|month|quarter|sprint)
          | (?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)
          | tomorrow | tonight | today | eod | eow
          | (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?
          | \d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*
          | \d{1,2}(?::\d{2})?\s*(?:am|pm)
        )
        | tomorrow | next\ week | this\ week | end\ of\ (?:the\ )?(?:day|week|month)
    )\b""",
    re.IGNORECASE | re.VERBOSE,
)

# "Sarah, can you…" / "Sarah will…" -> owner "Sarah"
_OWNER = re.compile(
    r"^(?:ok(?:ay)?|so|and|alright|right)?[,\s]*([A-Z][a-z]+)(?:,|\s+(?:will|can|could|is going to|needs to|should)\b)"
)
_NOT_NAMES = {"I", "We", "You", "Let", "Lets", "Can", "Could", "Would", "Will", "Please",
              "The", "This", "That", "And", "So", "Okay", "Ok", "Alright", "Right", "Make", "Next"}

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
# Filler questions that match the patterns but aren't tasks.
_IGNORE = re.compile(r"^(can you (hear|see) me|could you repeat|would you like)", re.IGNORECASE)


def split_sentences(segments: list[dict]) -> list[tuple[float, str]]:
    """Join Whisper segments into sentences, keeping each sentence's start time."""
    out: list[tuple[float, str]] = []
    buf, start = "", None
    for seg in segments:
        for piece in _SENTENCE_SPLIT.split(seg["text"].strip()):
            if not piece:
                continue
            if start is None:
                start = seg["start"]
            buf = f"{buf} {piece}".strip()
            if buf[-1:] in ".!?":
                out.append((start, buf))
                buf, start = "", None
    if buf:
        out.append((start or 0.0, buf))
    return out


def extract_action_items(segments: list[dict], limit: int = 25) -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()
    for start, sentence in split_sentences(segments):
        if len(sentence.split()) < 4 or _IGNORE.search(sentence):
            continue
        if not _COMMITMENT.search(sentence):
            continue
        key = sentence.lower()
        if key in seen:
            continue
        seen.add(key)

        due = _DUE.search(sentence)
        owner = None
        m = _OWNER.match(sentence)
        if m and m.group(1) not in _NOT_NAMES:
            owner = m.group(1)
        elif re.match(r"^(?:\w+[.,]\s*)?(i['’]ll|i will|i['’]m going to|i can take)\b", sentence, re.IGNORECASE):
            owner = "Speaker"

        items.append({
            "text": sentence,
            "start": round(float(start), 1),
            "owner": owner,
            "due": due.group(0) if due else None,
        })
        if len(items) >= limit:
            break
    return items
