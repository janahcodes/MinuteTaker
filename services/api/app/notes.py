"""Turn a lecture transcript into study notes.

Extractive and dependency-free: it scores sentences by how many of the
lecture's key terms they contain, keeps the strongest ones per section,
strips spoken filler ("um", "so basically", "you know"), and pulls out
definitions ("X is ...", "X refers to ..."). The result is a condensed,
organised set of notes rather than a verbatim transcript. It runs in
milliseconds, needs no API key, and gives the same output every time.
"""
from __future__ import annotations

import math
import re
from collections import Counter

STOP = set("""
a about above after again against all also am an and any are aren't as at be because been before being below between
both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further
get gets getting got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him
himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself just know let let's like lot lots
make made me might more most much must mustn't my myself need no nor not now of off ok okay on once one only or other
ought our ours ourselves out over own really right said same say says see shan't she she'd she'll she's should
shouldn't so some something such sure take than that that's the their theirs them themselves then there there's these
they they'd they'll they're they've thing things think this those though through to today too under until up us
very was wasn't way we we'd we'll we're we've well were weren't what what's when when's where where's which while who
who's whom why why's will with won't would wouldn't yeah yes you you'd you'll you're you've your yours yourself
yourselves going go gonna want wanna kind sort actually basically literally pretty quite even still back look looks
mean means talk talking time two three first second next last new good great little big many may every also
""".split())

_FILLER = [
    r"\b(um+|uh+|erm|hmm+)\b[,.]?",
    r"\byou know[,]?",
    r"\bi mean[,]?",
    r"\bkind of\b",
    r"\bsort of\b",
    r"\bbasically[,]?",
    r"\bactually[,]?",
    r"\bliterally[,]?",
    r"^(so|okay|ok|alright|right|now|and|well|but)[, ]+",
    r"^(so|and) (yeah|basically)[, ]+",
    r"^(let me|let's) (just )?(say|see)[, ]+",
]
_FILLER_RE = [re.compile(p, re.IGNORECASE) for p in _FILLER]
_DEF = re.compile(
    r"^(?:so\s+)?(?:an?\s+|the\s+)?(?P<term>[A-Za-z][\w\- ]{1,40}?)\s+"
    r"(?:is|are|refers to|means|is defined as|is called|are called|describes)\s+(?P<body>.{12,})$",
    re.IGNORECASE,
)
_SPLIT = re.compile(r"(?<=[.!?])\s+")
_WORD = re.compile(r"[a-z][a-z'\-]+")


def _clean(sentence: str) -> str:
    s = sentence.strip()
    for _ in range(2):
        for rx in _FILLER_RE:
            s = rx.sub("", s).strip()
    s = re.sub(r"\s{2,}", " ", s)
    s = re.sub(r"\s+([,.!?])", r"\1", s).strip(" ,")
    return s[:1].upper() + s[1:] if s else s


def _sentences(segments: list[dict], transcript: str) -> list[tuple[float, str]]:
    if not segments:
        return [(0.0, s) for s in _SPLIT.split(transcript) if s.strip()]
    out, buf, start = [], "", None
    for seg in segments:
        for piece in _SPLIT.split(seg["text"].strip()):
            if not piece:
                continue
            start = seg["start"] if start is None else start
            buf = f"{buf} {piece}".strip()
            if buf[-1:] in ".!?":
                out.append((float(start), buf))
                buf, start = "", None
    if buf:
        out.append((float(start or 0), buf))
    return out


def _words(s: str) -> list[str]:
    return [w for w in _WORD.findall(s.lower()) if w not in STOP and len(w) > 2]


def _key_terms(sentences: list[str], n: int = 12) -> list[str]:
    uni = Counter(w for s in sentences for w in _words(s))
    bi: Counter = Counter()
    for s in sentences:
        ws = _words(s)
        bi.update(f"{a} {b}" for a, b in zip(ws, ws[1:]))
    terms = [(t, c * 2.2) for t, c in bi.items() if c >= 2]
    terms += [(t, float(c)) for t, c in uni.items() if c >= 2]
    terms.sort(key=lambda x: -x[1])
    picked: list[str] = []
    for t, _ in terms:
        if any(t in p or p in t for p in picked):
            continue
        picked.append(t)
        if len(picked) >= n:
            break
    return picked


def make_notes(title: str, segments: list[dict], transcript: str, duration_s: float | None = None) -> dict:
    raw = _sentences(segments, transcript)
    cleaned = [(t, _clean(s)) for t, s in raw]
    cleaned = [(t, s) for t, s in cleaned if len(s.split()) >= 5]
    if not cleaned:
        return {"title": title, "summary": [], "key_terms": [], "definitions": [], "sections": [], "stats": {}}

    texts = [s for _, s in cleaned]
    df = Counter(w for s in texts for w in set(_words(s)))
    n = len(texts)

    def score(s: str) -> float:
        ws = _words(s)
        if not ws:
            return 0.0
        tf = Counter(ws)
        val = sum(c * math.log(1 + n / df[w]) * (df[w] > 1) for w, c in tf.items())
        return val / (len(ws) ** 0.6)

    scored = [(t, s, score(s)) for t, s in cleaned]

    # Definitions: explicit "X is/means/refers to Y" sentences about a key-ish term.
    definitions, seen_terms = [], set()
    for t, s, _ in scored:
        m = _DEF.match(s.rstrip("."))
        if not m:
            continue
        term = m.group("term").strip()
        if len(term.split()) > 5 or term.lower() in STOP or term.lower() in seen_terms:
            continue
        if term.lower().split()[0] in {"it", "this", "that", "there", "here", "what", "which", "he", "she", "they", "we", "i", "you"}:
            continue
        seen_terms.add(term.lower())
        definitions.append({"term": term[:1].upper() + term[1:], "definition": m.group("body").rstrip(".") + ".", "start": round(t, 1)})
    definitions = definitions[:12]

    # Sections: ~equal time slices (about 5 min each, 1-8 sections), each with
    # its top sentences kept in spoken order.
    total = duration_s or (cleaned[-1][0] + 10)
    n_sections = max(1, min(8, round(total / 300)))
    span = total / n_sections
    sections = []
    for i in range(n_sections):
        lo, hi = i * span, (i + 1) * span
        part = [x for x in scored if lo <= x[0] < hi] if i < n_sections - 1 else [x for x in scored if x[0] >= lo]
        if not part:
            continue
        keep = max(2, min(7, round(len(part) * 0.3)))
        top = sorted(sorted(part, key=lambda x: -x[2])[:keep], key=lambda x: x[0])
        heads = _key_terms([s for _, s, _ in part], n=2)
        heading = " & ".join(h.title() for h in heads) if heads else f"Part {i + 1}"
        sections.append({
            "heading": heading,
            "start": round(part[0][0], 1),
            "points": [{"text": _shorten(s), "start": round(t, 1)} for t, s, _ in top],
        })

    best = sorted(scored, key=lambda x: -x[2])[: min(5, max(3, n // 12))]
    summary = [_shorten(s, 30) for _, s, _ in sorted(best, key=lambda x: x[0])]

    return {
        "title": title,
        "summary": summary,
        "key_terms": _key_terms(texts),
        "definitions": definitions,
        "sections": sections,
        "stats": {"sentences": len(raw), "kept": sum(len(s["points"]) for s in sections)},
    }


def _shorten(s: str, max_words: int = 40) -> str:
    """Drop lead-ins like "What I want you to remember is that" and cap length."""
    s = re.sub(
        r"^(what i want (you )?to (say|remember|point out) is( that)?|the (important|key|main) (thing|point|idea) (here )?is( that)?|"
        r"i want to (point out|emphasize|stress) that|remember that|note that|notice that|it'?s important to (note|remember) that)\s+",
        "", s, flags=re.IGNORECASE)
    words = s.split()
    if len(words) > max_words:
        s = " ".join(words[:max_words]).rstrip(",;") + "…"
    return s[:1].upper() + s[1:]
